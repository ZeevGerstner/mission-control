/**
 * T-B bridge-originated roster sync: one Mission Control agent row per wave role.
 *
 * Placement: driven from bridge/index.ts on its own 30s interval plus one eager
 * sync after startBridge. NEVER in the 5s tick path (snapshot/pollFrames).
 *
 * MC reach: base URL from MC_BASE_URL (default http://mission-control:3000 —
 * compose DNS, correct server-to-server), credential `x-api-key` header from
 * MC_API_KEY (never hardcoded; empty = warn once + skip, never invent auth).
 *
 * Upsert (exact, matches the POST→409→PUT contract in src/app/api/agents):
 *   POST /api/agents {name, role, session_key:'local-<role>', status, config:{managedBy}}
 *   on 409 → GET /api/agents/:name → PUT {name, status, last_activity, session_key}
 * PUT writes status/last_activity/session_key ONLY (config omitted → preserved).
 * Rows WITHOUT the managedBy tag are never touched (collision logged + skipped).
 *
 * Status mapping (MC enum only): active/working→busy, done→idle,
 * failed→error, unknown→offline. Presence is never fabricated.
 *
 * Retries: 429/5xx → exponential backoff w/ jitter (30s→60s→120s cap),
 * debug-log only, never throws out of the interval. 401/403 → one warn log
 * (operator must fix env), cycle aborts, serving continues.
 *
 * Role discovery (first hit wins for status; absent sources SKIPPED, never fatal):
 *   (1) live intake registry: agent.status + session events observed via
 *       noteIntakeEvent (deploy-truth);
 *   (2) transcript tailer roles (last lines of *.jsonl) + bridge/session-table.json
 *       role keys as optional override (existsSync + try/catch guards);
 *   (3) fallback canonical set seeded offline.
 *
 * Active-wave-only: writes gated on readActiveWaveKey() === waveKey.
 * No imports from src/ (bridge rule). ChangeClass: code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTranscriptLine } from './mapper';
import { loadSessionTable } from './usage';

/** Ownership tag: sync writes status-only rows carrying this config marker. */
export const ROSTER_MANAGED_BY = 'bridge-roster-sync';
/** Own interval (never the 5s tick). */
export const ROSTER_INTERVAL_MS = 30_000;
/** session_key namespace; proofs filter `session_key LIKE 'local-%'`. */
export const ROSTER_SESSION_PREFIX = 'local-';
/** Server-to-server default (compose DNS). */
export const MC_BASE_URL_DEFAULT = 'http://mission-control:3000';
/** Backoff ladder for 429/5xx: first hit lands on 30s, cap 120s. */
export const BACKOFF_FIRST_MS = 15_000;
export const BACKOFF_MAX_MS = 120_000;
/** Fallback canonical set, seeded offline when no source reports roles. */
export const FALLBACK_ROLES = [
  'historian',
  'workspace-expert',
  'scaffolder',
  'implementer',
  'qa',
  'curator',
  'orchestrator',
] as const;

/** MC agent status enum (createAgentSchema) — the only values ever written. */
export type McAgentStatus = 'online' | 'offline' | 'busy' | 'idle' | 'error';

/**
 * Map any raw status (intake events, `turn_<status>` frames) into the MC enum.
 * active/working→busy, done→idle, failed→error, unknown→offline.
 */
export function mapAgentStatus(raw: unknown): McAgentStatus {
  let s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s.startsWith('turn_')) s = s.slice('turn_'.length);
  switch (s) {
    case 'online':
      return 'online';
    case 'busy':
    case 'active':
    case 'working':
      return 'busy';
    case 'idle':
    case 'done':
    case 'success':
    case 'succeeded':
    case 'completed':
    case 'inactive':
      return 'idle';
    case 'error':
    case 'failed':
    case 'failure':
      return 'error';
    case 'offline':
      return 'offline';
    default:
      return 'offline';
  }
}

const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** One discovered role. `live` = status came from an intake event this process saw. */
export interface DiscoveredRole {
  role: string;
  status: McAgentStatus;
  live: boolean;
}

const MC_STATUS_SET: ReadonlySet<string> = new Set(['online', 'offline', 'busy', 'idle', 'error']);

/** Narrow an unknown row status to the MC enum; junk → undefined (never trust). */
function asMcStatus(raw: unknown): McAgentStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  return MC_STATUS_SET.has(s) ? (s as McAgentStatus) : undefined;
}

/** Accept only MC-safe role names; anything else is skipped, never fatal. */
export function sanitizeRole(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const r = raw.trim();
  return ROLE_RE.test(r) ? r : undefined;
}

/**
 * Roles seen in the tail of each transcript *.jsonl (message lines only).
 * Missing dir / unreadable files → [] (skipped, never throws).
 */
export function discoverTranscriptRoles(transcriptDir: string, maxLinesPerFile = 200): string[] {
  const roles: string[] = [];
  const seen = new Set<string>();
  try {
    if (!transcriptDir || !fs.existsSync(transcriptDir)) return [];
    const files = fs
      .readdirSync(transcriptDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    for (const file of files) {
      try {
        const text = fs.readFileSync(path.join(transcriptDir, file), 'utf8');
        const lines = text
          .split('\n')
          .filter((l) => l.trim() !== '')
          .slice(-maxLinesPerFile);
        for (const line of lines) {
          const parsed = parseTranscriptLine(line);
          if (parsed.kind === 'message') {
            const role = sanitizeRole(parsed.role);
            if (role && !seen.has(role)) {
              seen.add(role);
              roles.push(role);
            }
          }
        }
      } catch {
        // Unreadable file → skip, never break discovery.
      }
    }
  } catch {
    return [];
  }
  return roles;
}

/**
 * Wave marker lookup: BRIDGE_ACTIVE_MARKER override, then the dev-tree path,
 * then the container mount (/app/state/wave via bridgeDir/state/...).
 * Unreadable/absent → undefined (caller treats as gate-closed, never fatal).
 */
export function readActiveWaveKey(bridgeDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.BRIDGE_ACTIVE_MARKER,
    path.join(bridgeDir, '..', 'state', 'wave', 'active.json'),
    path.join(bridgeDir, 'state', 'wave', 'active.json'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { waveKey?: unknown };
      if (typeof parsed.waveKey === 'string' && parsed.waveKey !== '') return parsed.waveKey;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * Full wave marker (waveKey + model profile). No-arg: resolves bridge root
 * from this module's location (src or dist) so both call sites share one
 * reader. Unreadable/absent → {} (callers treat as best-effort, never fatal).
 */
export interface ActiveMarker {
  waveKey?: unknown;
  modelProfile?: { plannerModel?: unknown; contextTokens?: unknown };
}

function moduleBridgeRoot(): string {
  return path.basename(__dirname) === 'dist' ? path.join(__dirname, '..') : __dirname;
}

export function readActiveMarker(): ActiveMarker {
  const root = moduleBridgeRoot();
  const candidates = [
    process.env.BRIDGE_ACTIVE_MARKER,
    path.join(root, '..', 'state', 'wave', 'active.json'),
    path.join(root, 'state', 'wave', 'active.json'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (!fs.existsSync(candidate)) continue;
      return JSON.parse(fs.readFileSync(candidate, 'utf8')) as ActiveMarker;
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

/** Minimal HTTP surface (global fetch satisfies this; tests inject a fake). */
export interface RosterHttpResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface RosterHttp {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<RosterHttpResponse>;
}

export interface RosterLog {
  debug(msg: string): void;
  warn(msg: string): void;
}

export interface RosterOptions {
  waveKey: string;
  mcBaseUrl?: string;
  mcApiKey?: string;
  transcriptDir?: string;
  sessionTablePath?: string;
  bridgeDir?: string;
  readActiveWaveKey?: () => string | undefined;
  fetchImpl?: RosterHttp;
  log?: RosterLog;
}

export interface SyncResult {
  ok: boolean;
  created: number;
  updated: number;
  /** Existing rows without the ownership tag — left untouched. */
  untagged: string[];
  skipped: number;
  /** Why the cycle (or its writes) did not run, when applicable. */
  skippedReason?: 'wave-gate' | 'backoff' | 'no-credential' | 'auth';
}

type UpsertOutcome = 'created' | 'updated' | 'untagged' | 'skipped';

class RosterAuthError extends Error {}
class RosterRetryableError extends Error {}

function parseConfigTag(config: unknown): string | undefined {
  try {
    const obj = typeof config === 'string' ? (JSON.parse(config) as unknown) : config;
    if (typeof obj === 'object' && obj !== null) {
      const tag = (obj as Record<string, unknown>).managedBy;
      return typeof tag === 'string' ? tag : undefined;
    }
  } catch {
    // Unparseable config → treated as untagged (never touched).
  }
  return undefined;
}

export class RosterSync {
  private readonly opts: Required<Omit<RosterOptions, 'fetchImpl' | 'log' | 'readActiveWaveKey'>> & {
    fetchImpl: RosterHttp;
    log: RosterLog;
    readActiveWaveKey?: () => string | undefined;
  };
  /** Live intake registry: role → latest mapped status (deploy-truth). */
  private readonly live = new Map<string, McAgentStatus>();
  private backoffUntil = 0;
  private backoffMs = BACKOFF_FIRST_MS;
  private authWarned = false;
  private credentialWarned = false;

  constructor(opts: RosterOptions) {
    const fetchImpl: RosterHttp =
      opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<RosterHttpResponse>);
    const log: RosterLog = opts.log ?? {
      debug: (msg) => console.debug(msg),
      warn: (msg) => console.warn(msg),
    };
    this.opts = {
      waveKey: opts.waveKey,
      mcBaseUrl: (opts.mcBaseUrl ?? MC_BASE_URL_DEFAULT).replace(/\/+$/, ''),
      mcApiKey: opts.mcApiKey ?? '',
      transcriptDir: opts.transcriptDir ?? '',
      sessionTablePath: opts.sessionTablePath ?? '',
      bridgeDir: opts.bridgeDir ?? process.cwd(),
      readActiveWaveKey: opts.readActiveWaveKey,
      fetchImpl,
      log,
    };
  }

  /**
   * Observe one validated intake event for role discovery. Session events
   * with a `local-<role>` key (or a bare role key) seed the role with
   * active→busy / inactive→idle; agent.status events set the mapped status.
   * Never throws (observation must not break intake).
   */
  noteIntakeEvent(event: { event: string; [key: string]: unknown }): void {
    try {
      if (event.event === 'agent.status') {
        const role = sanitizeRole(event.role);
        if (role) this.live.set(role, mapAgentStatus(event.status));
      } else if (event.event === 'session') {
        const key = typeof event.key === 'string' ? event.key : '';
        if (key === '' || key === this.opts.waveKey) return;
        const bare = key.startsWith(ROSTER_SESSION_PREFIX)
          ? key.slice(ROSTER_SESSION_PREFIX.length)
          : key;
        const role = sanitizeRole(bare);
        if (!role) return;
        this.live.set(role, event.active === false ? 'idle' : 'busy');
      }
    } catch {
      // Swallowed by design.
    }
  }

  /** Union of sources (live first); canonical fallback only when all are empty. */
  discoverRoles(): DiscoveredRole[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const push = (role: string): void => {
      if (!seen.has(role)) {
        seen.add(role);
        ordered.push(role);
      }
    };
    for (const role of this.live.keys()) push(role);
    for (const role of discoverTranscriptRoles(this.opts.transcriptDir)) push(role);
    try {
      if (this.opts.sessionTablePath) {
        for (const key of Object.keys(loadSessionTable(this.opts.sessionTablePath))) {
          const role = sanitizeRole(key);
          if (role) push(role);
        }
      }
    } catch {
      // Optional override — absent/broken means skipped.
    }
    if (ordered.length === 0) {
      for (const role of FALLBACK_ROLES) push(role);
    }
    return ordered.map((role) => ({
      role,
      status: this.live.get(role) ?? 'offline',
      live: this.live.has(role),
    }));
  }

  private noteRetryable(status: number, now: number): void {
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    const jittered = Math.round(this.backoffMs * (0.8 + Math.random() * 0.4));
    this.backoffUntil = now + jittered;
    this.opts.log.debug(
      `[roster] MC ${status} → backoff ${Math.round(jittered / 1000)}s (debug only, serving continues)`,
    );
  }

  private noteAuth(): void {
    if (!this.authWarned) {
      this.authWarned = true;
      this.opts.log.warn(
        '[roster] MC rejected the roster credential (401/403) — fix MC_API_KEY env; sync paused, bridge keeps serving',
      );
    }
  }

  private async upsertRole(
    role: string,
    status: McAgentStatus,
    now: number,
    liveStatus: boolean,
  ): Promise<UpsertOutcome> {
    const { mcBaseUrl, mcApiKey, fetchImpl, log } = this.opts;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (mcApiKey !== '') headers['x-api-key'] = mcApiKey;
    const sessionKey = `${ROSTER_SESSION_PREFIX}${role}`;

    const post: RosterHttpResponse = await fetchImpl(`${mcBaseUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: role,
        role,
        session_key: sessionKey,
        status,
        config: { managedBy: ROSTER_MANAGED_BY },
      }),
    });
    if (post.status === 200 || post.status === 201) return 'created';
    if (post.status === 401 || post.status === 403) {
      this.noteAuth();
      throw new RosterAuthError(`POST /api/agents → ${post.status}`);
    }
    if (post.status === 429 || post.status >= 500) {
      this.noteRetryable(post.status, now);
      throw new RosterRetryableError(`POST /api/agents → ${post.status}`);
    }
    if (post.status !== 409) {
      log.debug(`[roster] POST ${role} → ${post.status} (skipped, debug only)`);
      return 'skipped';
    }

    // 409: name-keyed upsert — read the owner tag, then status-only PUT.
    const got = await fetchImpl(`${mcBaseUrl}/api/agents/${encodeURIComponent(role)}`, {
      method: 'GET',
      headers,
    });
    if (got.status === 401 || got.status === 403) {
      this.noteAuth();
      throw new RosterAuthError(`GET /api/agents/${role} → ${got.status}`);
    }
    if (got.status === 429 || got.status >= 500) {
      this.noteRetryable(got.status, now);
      throw new RosterRetryableError(`GET /api/agents/${role} → ${got.status}`);
    }
    if (got.status !== 200) {
      log.debug(`[roster] GET ${role} → ${got.status} after 409 (skipped, debug only)`);
      return 'skipped';
    }
    const body = (await got.json().catch(() => null)) as {
      agent?: { config?: unknown; status?: unknown };
    } | null;
    if (parseConfigTag(body?.agent?.config) !== ROSTER_MANAGED_BY) {
      log.warn(`[roster] collision: agent '${role}' exists without the roster tag — left untouched`);
      return 'untagged';
    }
    // No-flap probe: when nothing live was observed (offline-by-default) yet
    // the row carries a fresher non-offline status, preserve the row's status
    // instead of dragging it back to offline on every restart. An explicit
    // live status (even offline) always wins — pass liveStatus through.
    if (!liveStatus && status === 'offline') {
      const rowStatus = asMcStatus(body?.agent?.status);
      if (rowStatus && rowStatus !== 'offline') {
        log.debug(`[roster] ${role}: preserving row status '${rowStatus}' (no live signal)`);
        status = rowStatus;
      }
    }
    const put = await fetchImpl(`${mcBaseUrl}/api/agents`, {
      method: 'PUT',
      headers,
      // Ownership: status/last_activity/session_key ONLY — config (and
      // name/role/soul_content) are never written here.
      body: JSON.stringify({
        name: role,
        status,
        last_activity: new Date().toISOString(),
        session_key: sessionKey,
      }),
    });
    if (put.status >= 200 && put.status < 300) return 'updated';
    if (put.status === 401 || put.status === 403) {
      this.noteAuth();
      throw new RosterAuthError(`PUT /api/agents ${role} → ${put.status}`);
    }
    if (put.status === 429 || put.status >= 500) {
      this.noteRetryable(put.status, now);
      throw new RosterRetryableError(`PUT /api/agents ${role} → ${put.status}`);
    }
    log.debug(`[roster] PUT ${role} → ${put.status} (skipped, debug only)`);
    return 'skipped';
  }

  /**
   * One full pass. Never throws: every failure mode is caught, logged at
   * debug (warn for auth/collisions), and reported in the result.
   */
  async syncOnce(now: number = Date.now()): Promise<SyncResult> {    const empty: SyncResult = { ok: true, created: 0, updated: 0, untagged: [], skipped: 0 };
    try {
      const active = this.opts.readActiveWaveKey
        ? this.opts.readActiveWaveKey()
        : readActiveWaveKey(this.opts.bridgeDir);
      if (active !== this.opts.waveKey) {
        this.opts.log.debug(
          `[roster] active-wave gate closed (marker=${active ?? 'none'} want=${this.opts.waveKey}) — writes skipped`,
        );
        return { ...empty, skippedReason: 'wave-gate' };
      }
      if (now < this.backoffUntil) {
        this.opts.log.debug('[roster] backoff window still open — cycle skipped');
        return { ...empty, skippedReason: 'backoff' };
      }
      if (this.opts.mcApiKey === '') {
        if (!this.credentialWarned) {
          this.credentialWarned = true;
          this.opts.log.warn('[roster] MC_API_KEY is empty — roster writes skipped (no auth invented)');
        }
        return { ...empty, skippedReason: 'no-credential' };
      }
      const result: SyncResult = { ...empty, untagged: [] };
      for (const { role, status, live } of this.discoverRoles()) {
        try {
          const outcome = await this.upsertRole(role, status, now, live);
          if (outcome === 'created') result.created += 1;
          else if (outcome === 'updated') result.updated += 1;
          else if (outcome === 'untagged') result.untagged.push(role);
          else result.skipped += 1;
        } catch (err) {
          if (err instanceof RosterAuthError) {
            return { ...result, skippedReason: 'auth' };
          }
          if (err instanceof RosterRetryableError) {
            return result;
          }
          // Network/fetch failure on one role → debug + continue with the rest.
          this.opts.log.debug(`[roster] ${role}: ${(err as Error)?.message ?? err} (debug only)`);
          result.skipped += 1;
        }
      }
      this.backoffMs = BACKOFF_FIRST_MS;
      return result;
    } catch (err) {
      this.opts.log.debug(`[roster] sync cycle failed: ${(err as Error)?.message ?? err} (debug only)`);
      return { ...empty, ok: false, skippedReason: undefined };
    }
  }

  /**
   * Eager sync now, then every `intervalMs` on this instance's own timer
   * (never the tick path). Returns a stop function for shutdown.
   */
  start(intervalMs: number = ROSTER_INTERVAL_MS): () => void {
    void this.syncOnce();
    const timer = setInterval(() => {
      void this.syncOnce();
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
