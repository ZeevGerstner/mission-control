/**
 * T-B roster-sync proofs (changeClass: code):
 * - double-sync + simulated restart vs scratch store → GROUP BY name all =1
 * - hand-edit probe: soul_content+role survive, only status moved
 * - intake agent.status flips row status
 * - untagged rows never touched; wave gate blocks foreign waves;
 *   429 → backoff skip; 401 → warn once, no throw.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RosterSync,
  mapAgentStatus,
  sanitizeRole,
  discoverTranscriptRoles,
  readActiveWaveKey,
  ROSTER_MANAGED_BY,
  ROSTER_SESSION_PREFIX,
  FALLBACK_ROLES,
  type RosterOptions,
} from './roster';

interface FakeRow {
  name: string;
  role: string;
  session_key: string | null;
  soul_content: string | null;
  status: string;
  last_activity: string | null;
  config: Record<string, unknown>;
}

/** In-memory MC twin: POST→409→PUT by name, GET by name (route subset). */
function fakeMc(initial: FakeRow[] = [], fail?: { post?: number; put?: number; get?: number }) {
  const rows = new Map<string, FakeRow>(initial.map((r) => [r.name, { ...r, config: { ...r.config } }]));
  const calls: string[] = [];
  const warns: string[] = [];
  const debugs: string[] = [];
  const resp = (status: number, body: unknown = {}) => ({
    status,
    json: () => Promise.resolve(body),
  });
  const fetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push(`${init.method} ${url}`);
    const failStatus =
      init.method === 'POST' ? fail?.post : init.method === 'PUT' ? fail?.put : fail?.get;
    if (failStatus) return Promise.resolve(resp(failStatus, { error: 'injected' }));
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith('/api/agents') && init.method === 'POST') {
      const name = body.name as string;
      if (!name || typeof body.role !== 'string') return Promise.resolve(resp(400, { error: 'bad' }));
      if (rows.has(name)) return Promise.resolve(resp(409, { error: 'Agent name already exists' }));
      const row: FakeRow = {
        name,
        role: body.role,
        session_key: (body.session_key as string) ?? null,
        soul_content: null,
        status: body.status as string,
        last_activity: null,
        config: (body.config as Record<string, unknown>) ?? {},
      };
      rows.set(name, row);
      return Promise.resolve(resp(201, { agent: { ...row } }));
    }
    if (url.endsWith('/api/agents') && init.method === 'PUT') {
      const name = body.name as string;
      const row = rows.get(name);
      if (!row) return Promise.resolve(resp(404, { error: 'Agent not found' }));
      // Mirror the real route: only provided fields move; config untouched
      // unless `config` is present (roster never sends it).
      if (body.status !== undefined) row.status = body.status as string;
      if (body.last_activity !== undefined) row.last_activity = body.last_activity as string;
      if (body.session_key !== undefined) row.session_key = body.session_key as string;
      if (body.config !== undefined) row.config = body.config as Record<string, unknown>;
      if (body.soul_content !== undefined) row.soul_content = body.soul_content as string;
      if (body.role !== undefined) row.role = body.role as string;
      return Promise.resolve(resp(200, { success: true }));
    }
    const m = /\/api\/agents\/([^/]+)$/.exec(url);
    if (m && init.method === 'GET') {
      const row = rows.get(decodeURIComponent(m[1]));
      if (!row) return Promise.resolve(resp(404, { error: 'Agent not found' }));
      return Promise.resolve(resp(200, { agent: { ...row } }));
    }
    return Promise.resolve(resp(404, { error: 'not found' }));
  };

  const countsByName = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const r of rows.values()) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    return counts;
  };
  return { rows, calls, warns, debugs, fetchImpl, countsByName };
}

function optsFor(
  mc: ReturnType<typeof fakeMc>,
  over: Partial<RosterOptions> = {},
): RosterOptions {
  return {
    waveKey: 'WAVE-TEST',
    mcBaseUrl: 'http://mc:3000',
    mcApiKey: 'k',
    transcriptDir: path.join(os.tmpdir(), 'roster-test-nope'),
    sessionTablePath: path.join(os.tmpdir(), 'roster-test-nope.json'),
    bridgeDir: os.tmpdir(),
    readActiveWaveKey: () => 'WAVE-TEST',
    fetchImpl: mc.fetchImpl,
    log: {
      debug: (m: string) => mc.debugs.push(m),
      warn: (m: string) => mc.warns.push(m),
    },
    ...over,
  };
}

describe('mapAgentStatus', () => {
  it.each([
    ['online', 'online'],
    ['busy', 'busy'],
    ['active', 'busy'],
    ['working', 'busy'],
    ['done', 'idle'],
    ['success', 'idle'],
    ['turn_success', 'idle'],
    ['turn_failed', 'error'],
    ['failed', 'error'],
    ['unknown', 'offline'],
    ['', 'offline'],
  ])('maps %s → %s', (raw, want) => {
    expect(mapAgentStatus(raw)).toBe(want);
  });

  it('only emits the MC enum, never fabricates liveness', () => {
    for (const raw of ['weird', 'ONLINE ', ' Turn_Working ', null, 42, undefined]) {
      expect(['online', 'offline', 'busy', 'idle', 'error']).toContain(mapAgentStatus(raw));
    }
  });
});

describe('role hygiene', () => {
  it('sanitizeRole rejects paths, blanks, and oversize', () => {
    expect(sanitizeRole('qa')).toBe('qa');
    expect(sanitizeRole('workspace-expert')).toBe('workspace-expert');
    expect(sanitizeRole('')).toBeUndefined();
    expect(sanitizeRole('../x')).toBeUndefined();
    expect(sanitizeRole('a b')).toBeUndefined();
    expect(sanitizeRole('x'.repeat(65))).toBeUndefined();
  });
});

describe('readActiveWaveKey', () => {
  it('reads the dev-tree marker under bridgeDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-'));
    fs.mkdirSync(path.join(dir, 'state', 'wave'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'wave', 'active.json'), JSON.stringify({ waveKey: 'WAVE-X' }));
    expect(readActiveWaveKey(dir)).toBe('WAVE-X');
  });

  it('honours BRIDGE_ACTIVE_MARKER and degrades to undefined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-'));
    const p = path.join(dir, 'active.json');
    fs.writeFileSync(p, JSON.stringify({ waveKey: 'WAVE-Y' }));
    expect(readActiveWaveKey(os.tmpdir(), { BRIDGE_ACTIVE_MARKER: p } as NodeJS.ProcessEnv)).toBe(
      'WAVE-Y',
    );
    expect(readActiveWaveKey(path.join(os.tmpdir(), 'marker-missing-dir'))).toBeUndefined();
  });
});

describe('discoverTranscriptRoles', () => {
  it('reads message-line roles, skips malformed, missing dir → []', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-'));
    const line = (role: string, text: string) =>
      JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
    fs.writeFileSync(
      path.join(dir, 'a.jsonl'),
      [
        line('qa', 'first'),
        'not json',
        JSON.stringify({ type: 'turn_ended', status: 'success' }),
        line('qa', 'dup role'),
        line('implementer', 'hi Valid tokens here but no VALIDATION block'),
      ].join('\n') + '\n',
    );
    expect(discoverTranscriptRoles(dir).sort()).toEqual(['implementer', 'qa']);
    expect(discoverTranscriptRoles(path.join(os.tmpdir(), 'tx-missing-dir'))).toEqual([]);
  });
});

describe('roster sync idempotency', () => {
  it('double-sync + simulated restart → GROUP BY name all counts = 1', async () => {
    const mc = fakeMc();
    const first = new RosterSync(optsFor(mc));
    const s1 = await first.syncOnce();
    expect(s1.created).toBe(FALLBACK_ROLES.length);
    const s2 = await first.syncOnce();
    expect(s2.updated).toBe(FALLBACK_ROLES.length);
    expect(s2.created).toBe(0);

    // Simulated restart: brand-new instance, no process state carried over.
    const restarted = new RosterSync(optsFor(mc));
    const s3 = await restarted.syncOnce();
    expect(s3.created).toBe(0);
    expect(s3.updated).toBe(FALLBACK_ROLES.length);

    for (const [, count] of mc.countsByName()) expect(count).toBe(1);
    expect(mc.rows.size).toBe(FALLBACK_ROLES.length);
    const sessionKeys = new Set([...mc.rows.values()].map((r) => r.session_key));
    expect(sessionKeys.size).toBe(FALLBACK_ROLES.length);
    for (const k of sessionKeys) expect(k?.startsWith(ROSTER_SESSION_PREFIX)).toBe(true);
  });

  it('hand-edit probe: soul_content+role survive, only status moved', async () => {
    const mc = fakeMc();
    await new RosterSync(optsFor(mc)).syncOnce();
    const row = mc.rows.get('qa')!;
    row.soul_content = 'hand-written soul';
    row.config = { ...row.config, operatorNote: 'keep me' };

    const restarted = new RosterSync(optsFor(mc));
    restarted.noteIntakeEvent({ event: 'agent.status', role: 'qa', status: 'working' });
    const s = await restarted.syncOnce();
    expect(s.updated).toBeGreaterThan(0);

    const after = mc.rows.get('qa')!;
    expect(after.soul_content).toBe('hand-written soul');
    expect(after.role).toBe('qa');
    expect(after.config).toMatchObject({ managedBy: ROSTER_MANAGED_BY, operatorNote: 'keep me' });
    expect(after.status).toBe('busy');
    expect(after.session_key).toBe(`${ROSTER_SESSION_PREFIX}qa`);
  });

  it('intake agent.status flips row status on next sync', async () => {
    const mc = fakeMc();
    const sync = new RosterSync(optsFor(mc));
    await sync.syncOnce();
    expect(mc.rows.get('implementer')!.status).toBe('offline');
    sync.noteIntakeEvent({ event: 'agent.status', role: 'implementer', status: 'active' });
    await sync.syncOnce();
    expect(mc.rows.get('implementer')!.status).toBe('busy');

    const fresh = new RosterSync(optsFor(mc));
    fresh.noteIntakeEvent({ event: 'agent.status', role: 'implementer', status: 'done' });
    await fresh.syncOnce();
    expect(mc.rows.get('implementer')!.status).toBe('idle');
  });

  it('rows WITHOUT the tag are never touched (collision logged, not fixed)', async () => {
    const mc = fakeMc([
      {
        name: 'qa',
        role: 'something-else',
        session_key: null,
        soul_content: 'theirs',
        status: 'online',
        last_activity: null,
        config: {},
      },
    ]);
    const s = await new RosterSync(optsFor(mc)).syncOnce();
    expect(s.untagged).toContain('qa');
    const row = mc.rows.get('qa')!;
    expect(row.role).toBe('something-else');
    expect(row.status).toBe('online');
    expect(row.soul_content).toBe('theirs');
    expect(mc.warns.some((m) => m.includes('collision'))).toBe(true);
  });

  it('session intake events seed roles (deploy-truth before transcripts)', async () => {
    const mc = fakeMc();
    const sync = new RosterSync(optsFor(mc));
    sync.noteIntakeEvent({ event: 'session', key: 'local-qa', kind: 'ai-team-remote', active: true });
    expect(sync.discoverRoles()).toEqual([{ role: 'qa', status: 'busy', live: true }]);
    await sync.syncOnce();
    expect(mc.rows.get('qa')!.status).toBe('busy');
  });

  it('restart preserves a fresher row status when nothing live was observed', async () => {
    const mc = fakeMc();
    await new RosterSync(optsFor(mc)).syncOnce();
    // Simulate pre-restart liveness recorded in the row (e.g. intake flip).
    mc.rows.get('qa')!.status = 'busy';

    // Simulated restart: fresh instance, no live events seen.
    const restarted = new RosterSync(optsFor(mc));
    expect(restarted.discoverRoles().find((r) => r.role === 'qa')).toMatchObject({
      status: 'offline',
      live: false,
    });
    await restarted.syncOnce();
    expect(mc.rows.get('qa')!.status).toBe('busy');
    expect(mc.debugs.some((m) => m.includes('preserving row status'))).toBe(true);
  });

  it('an explicit live offline still wins over the preserved row status', async () => {
    const mc = fakeMc();
    await new RosterSync(optsFor(mc)).syncOnce();
    mc.rows.get('qa')!.status = 'busy';

    const sync = new RosterSync(optsFor(mc));
    sync.noteIntakeEvent({ event: 'agent.status', role: 'qa', status: 'offline' });
    await sync.syncOnce();
    expect(mc.rows.get('qa')!.status).toBe('offline');
  });
});

describe('roster guards', () => {
  it('wave gate: foreign marker → zero writes', async () => {
    const mc = fakeMc();
    const s = await new RosterSync(optsFor(mc, { readActiveWaveKey: () => 'WAVE-OTHER' })).syncOnce();
    expect(s.skippedReason).toBe('wave-gate');
    expect(mc.calls).toHaveLength(0);
    expect(mc.rows.size).toBe(0);
  });

  it('missing credential → warn once, zero writes, no throw', async () => {
    const mc = fakeMc();
    const sync = new RosterSync(optsFor(mc, { mcApiKey: '' }));
    const s1 = await sync.syncOnce();
    const s2 = await sync.syncOnce();
    expect(s1.skippedReason).toBe('no-credential');
    expect(s2.skippedReason).toBe('no-credential');
    expect(mc.calls).toHaveLength(0);
    expect(mc.warns).toHaveLength(1);
  });

  it('429 → backoff skips the next pass without throwing', async () => {
    const mc = fakeMc([], { post: 429 });
    const sync = new RosterSync(optsFor(mc));
    await sync.syncOnce(1_000);
    const callsAfterFirst = mc.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const s2 = await sync.syncOnce(2_000);
    expect(s2.skippedReason).toBe('backoff');
    expect(mc.calls.length).toBe(callsAfterFirst);
  });

  it('401 → one warn, cycle aborts, no throw', async () => {
    const mc = fakeMc([], { post: 401 });
    const sync = new RosterSync(optsFor(mc));
    const s1 = await sync.syncOnce();
    const s2 = await sync.syncOnce();
    expect(s1.skippedReason).toBe('auth');
    expect(s2.skippedReason).toBe('auth');
    expect(mc.warns).toHaveLength(1);
    expect(mc.warns[0]).toContain('MC_API_KEY');
  });
});
