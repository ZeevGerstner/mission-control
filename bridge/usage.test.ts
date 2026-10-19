import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addUsage,
  buildAgentDoneNotification,
  buildStartNotification,
  buildWaveDoneNotification,
  buildWaveSnapshot,
  loadSessionTable,
  loadUsageState,
  parseContextTokens,
  parseUsageFromText,
  resolveModel,
} from './usage';

describe('parseUsageFromText (Done-body Totals)', () => {
  it('parses "~11k input / ~2.4k output"', () => {
    expect(parseUsageFromText('Tokens: ~11k input / ~2.4k output (source: estimate)')).toEqual({
      inputTokens: 11000,
      outputTokens: 2400,
    });
  });

  it('parses plain integers without tildes', () => {
    expect(parseUsageFromText('tokens: 500 input / 250 output')).toEqual({ inputTokens: 500, outputTokens: 250 });
  });

  it('returns null when no Tokens line exists (never guesses)', () => {
    expect(parseUsageFromText('just chatting, no totals')).toBeNull();
    expect(parseUsageFromText('')).toBeNull();
  });

  it('accumulates totals across Done bodies (cost stays 0: no pricing source)', () => {
    const t1 = addUsage(
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 7, cost: 0 },
      { inputTokens: 11000, outputTokens: 2400 },
    );
    expect(t1.totalTokens).toBe(13400);
    expect(t1.messageCount).toBe(7);
    expect(t1.cost).toBe(0);
  });
});

describe('parseContextTokens', () => {
  it('parses "500k" from active.json modelProfile', () => {
    expect(parseContextTokens('500k')).toBe(500000);
  });

  it('passes numbers through, falls back on garbage', () => {
    expect(parseContextTokens(35000)).toBe(35000);
    expect(parseContextTokens('nope')).toBe(35000);
    expect(parseContextTokens(undefined)).toBe(35000);
  });
});

describe('session table (per-role model overrides)', () => {
  it('missing file → empty table (caller renders the role default)', () => {
    expect(loadSessionTable('/does/not/exist.json')).toEqual({});
    expect(resolveModel({}, 'orchestrator', 'grok-4.7')).toBe('grok-4.7');
  });

  it('override wins only when present; unknown roles fall back (never fabricated)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-usage-'));
    const file = path.join(dir, 'session-table.json');
    fs.writeFileSync(file, JSON.stringify({ roles: { orchestrator: { model: 'custom-1' } } }));
    const table = loadSessionTable(file);
    expect(resolveModel(table, 'orchestrator', 'grok-4.7')).toBe('custom-1');
    expect(resolveModel(table, 'implementer', 'grok-4.7')).toBe('grok-4.7');
  });
});

describe('usage state persistence', () => {
  it('missing file → empty state (never throws)', () => {
    const state = loadUsageState('/does/not/exist.json');
    expect(state.totals.totalTokens).toBe(0);
    expect(state.notifiedStart).toBe(false);
  });
});

describe('T3 snapshot + notifications', () => {
  it('buildWaveSnapshot keeps the fixture shape (key/kind/tokens/cost/messageCount)', () => {
    const snap = buildWaveSnapshot({
      waveKey: 'WAVE-TEST',
      model: 'grok-4.7',
      contextTokens: 500000,
      totals: { inputTokens: 11000, outputTokens: 2400, totalTokens: 13400, messageCount: 5, cost: 0 },
      isActive: true,
    });
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({
      key: 'WAVE-TEST',
      kind: 'ai-team-local',
      model: 'grok-4.7',
      totalTokens: 13400,
      contextTokens: 500000,
      messageCount: 5,
      cost: 0,
    });
  });

  it('milestones emit ONLY notification frames', () => {
    const start = buildStartNotification('WAVE-TEST-1', 'WAVE-TEST');
    const done = buildAgentDoneNotification('WAVE-TEST-2', 'WAVE-TEST', 'a.jsonl', {
      inputTokens: 1,
      outputTokens: 2,
    });
    const waveDone = buildWaveDoneNotification('WAVE-TEST-3', 'WAVE-TEST');
    for (const f of [start, done, waveDone]) {
      expect(f).toMatchObject({ type: 'event', event: 'notification' });
    }
    expect((done.payload as { message: string }).message).toContain('3 tokens');
  });
});

describe('prove-the-negative: forbidden live frames are never emitted', () => {
  const FORBIDDEN = ['token_usage', 'session_update', 'spawn_result', 'cron_status'];
  const ALLOWED_EVENTS = new Set(['tick', 'log', 'chat.message', 'notification', 'agent.status', 'connect.challenge']);

  it('no runtime bridge source names a forbidden event outside comments', () => {
    const dir = path.resolve(process.cwd(), 'bridge');
    const sources = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
    expect(sources.length).toBeGreaterThan(0);
    for (const { file, text } of sources) {
      const codeLines = text
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
        })
        .join('\n');
      for (const forbidden of FORBIDDEN) {
        expect(codeLines, `${file} must not reference ${forbidden} in code`).not.toContain(forbidden);
      }
    }
  });

  it('every event literal in runtime sources is on the MC-rendered allowlist', () => {
    const dir = path.resolve(process.cwd(), 'bridge');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const literals = new Set<string>();
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/event:\s*'([^']+)'/g)) literals.add(m[1]);
    }
    for (const event of literals) {
      expect(ALLOWED_EVENTS.has(event), `unexpected emitted event '${event}'`).toBe(true);
    }
  });
});
