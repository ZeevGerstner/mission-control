import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CursorStore } from './cursor';
import { pollTranscripts, type TailerConfig } from './tailer';

let dir: string;
let transcriptDir: string;
let cursorPath: string;
let usagePath: string;
const FIXTURE = path.resolve(process.cwd(), 'bridge/fixtures/tailer-sample.jsonl');

function baseConfig(): TailerConfig {
  return {
    transcriptDir,
    waveKey: 'WAVE-TEST',
    model: 'grok-4.7',
    contextTokens: 500000,
    isActive: true,
    usageStatePath: usagePath,
    sessionTablePath: path.join(dir, 'session-table.json'),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tailer-'));
  transcriptDir = path.join(dir, 'subagents');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(transcriptDir, 'a.jsonl'));
  cursorPath = path.join(dir, 'cursor.json');
  usagePath = path.join(dir, 'usage-state.json');
});

describe('pollTranscripts', () => {
  it('maps fixture lines: logs + statuses + Done notification, skips malformed', () => {
    const store = CursorStore.load(cursorPath);
    const result = pollTranscripts(store, baseConfig());

    // Fixture: 3 message lines (user, assistant text, tool_use) + 2 turn_ended
    // + 1 Done body message + 2 malformed (poison + wrong-shape) = 8 complete.
    expect(result.droppedLines).toBe(2);
    expect(result.newLines).toBe(6);

    const events = result.frames.map((f) => (f as { event: string }).event);
    expect(events).toContain('log');
    expect(events).toContain('agent.status');
    expect(events).toContain('notification'); // start + agent-Done
    for (const e of events) {
      expect(['log', 'agent.status', 'notification']).toContain(e);
    }

    // Stable <waveKey>-<seq> ids, unique across this poll.
    const ids = result.frames.map((f) => (f as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('WAVE-TEST-')).toBe(true);

    // T3 totals: the Done body contributes 11000 + 2400.
    expect(result.snapshot.sessions[0]).toMatchObject({
      key: 'WAVE-TEST',
      kind: 'ai-team-local',
      totalTokens: 13400,
      contextTokens: 500000,
      cost: 0,
    });
    expect(result.snapshot.sessions[0].messageCount).toBe(6);
  });

  it('resume: second poll emits nothing (restart-no-dup via cursor offsets)', () => {
    const store = CursorStore.load(cursorPath);
    const first = pollTranscripts(store, baseConfig());
    expect(first.newLines).toBeGreaterThan(0);

    // Simulate a bridge restart: fresh store instance, same files.
    const resumed = CursorStore.load(cursorPath);
    const second = pollTranscripts(resumed, baseConfig());
    const liveFrames = second.frames.filter(
      (f) => (f as { event: string }).event === 'log' && !(f as { payload: { message: string } }).payload.message.includes('malformed'),
    );
    expect(second.newLines).toBe(0);
    expect(liveFrames).toHaveLength(0);
    // Totals survive the restart via usage-state.json.
    expect(second.snapshot.sessions[0].totalTokens).toBe(13400);
  });

  it('appended lines emit exactly once with the next stable seq', () => {
    const store = CursorStore.load(cursorPath);
    pollTranscripts(store, baseConfig());
    const lastSeq = store.lastSeq('WAVE-TEST');

    fs.appendFileSync(
      path.join(transcriptDir, 'a.jsonl'),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'one more line' }] } }) + '\n',
    );
    const resumed = CursorStore.load(cursorPath);
    const result = pollTranscripts(resumed, baseConfig());
    expect(result.newLines).toBe(1);
    const logFrames = result.frames.filter((f) => (f as { event: string }).event === 'log');
    expect(logFrames).toHaveLength(1);
    expect((logFrames[0] as { id: string }).id).toBe(`WAVE-TEST-${lastSeq + 1}`);
  });

  it('missing transcript dir → empty result, never throws', () => {
    const store = CursorStore.load(cursorPath);
    const result = pollTranscripts(store, { ...baseConfig(), transcriptDir: path.join(dir, 'nope') });
    expect(result.frames).toHaveLength(1); // only the start notification
    expect(result.newLines).toBe(0);
  });

  it('inactive wave → wave-done notification once, then quiet', () => {
    const store = CursorStore.load(cursorPath);
    const cfg = { ...baseConfig(), isActive: false };
    const first = pollTranscripts(store, cfg);
    expect(first.frames.some((f) => (f as { payload: { title?: string } }).payload?.title?.includes('done'))).toBe(true);
    const second = pollTranscripts(CursorStore.load(cursorPath), cfg);
    expect(
      second.frames.filter((f) => (f as { payload: { title?: string } }).payload?.title?.includes('done')),
    ).toHaveLength(0);
  });
});
