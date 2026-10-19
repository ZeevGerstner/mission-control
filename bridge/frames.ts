/**
 * Gateway v3 frame builders + validators for the bridge.
 *
 * Wire shape is dictated by Mission Control's client (`src/lib/websocket.ts`,
 * READ-ONLY reference — never imported here). Only these frame paths are
 * rendered by MC: `tick`, `log`, `chat.message`, `notification`, `agent.status`.
 * Do NOT emit `token_usage` / `session_update` / `spawn_result` / `cron_status`
 * live frames — MC's frame path drops them (T3 proves the negative).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export const connectReqSchema = z.object({
  type: z.literal('req'),
  method: z.literal('connect'),
  id: z.string(),
  params: z
    .object({
      minProtocol: z.number().optional(),
      maxProtocol: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

export const pingReqSchema = z.object({
  type: z.literal('req'),
  method: z.literal('ping'),
  id: z.string(),
});

export const PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// Outbound builders
// ---------------------------------------------------------------------------

export function frameId(waveKey: string, seq: number): string {
  return `${waveKey}-${seq}`;
}

export function buildChallenge(nonce: string) {
  return { type: 'event', event: 'connect.challenge', payload: { nonce } };
}

export function buildConnectOk(id: string) {
  return { type: 'res', id, ok: true };
}

export function buildConnectReject(id: string, message: string) {
  return { type: 'res', id, ok: false, error: { message } };
}

/** Ping answer. Must be sent synchronously + unconditionally (acceptance #1). */
export function buildPong(id: string) {
  return { type: 'res', id, ok: true };
}

// ---------------------------------------------------------------------------
// Tick snapshot (what MC's tick handler reads)
// ---------------------------------------------------------------------------

export interface SnapshotSession {
  key: string;
  kind: string;
  updatedAt: number;
  model: string;
  totalTokens: number;
  contextTokens: number;
  messageCount: number;
  cost: number;
}

export interface TickSnapshot {
  sessions: SnapshotSession[];
}

export function buildTick(snapshot: TickSnapshot, id?: string) {
  return { type: 'event', event: 'tick', ...(id ? { id } : {}), payload: { snapshot } };
}

/**
 * Canned fixture snapshot so MC renders without the tailer.
 * T2 replaces the source with real transcript data; the shape must not change.
 */
export function fixtureSnapshot(waveKey: string, now = Date.now()): TickSnapshot {
  return {
    sessions: [
      {
        key: waveKey,
        kind: 'ai-team-local',
        updatedAt: now,
        model: 'muse-spark-1.3-high',
        totalTokens: 0,
        contextTokens: 35000,
        messageCount: 0,
        cost: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Frames T2/T3 will emit (builders scaffolded now, wired later)
// ---------------------------------------------------------------------------

export interface LogFrame {
  id: string;
  timestamp: number;
  level: string;
  source: string;
  session?: string;
  message: string;
}

export function buildLog(log: LogFrame) {
  return { type: 'event', event: 'log', id: log.id, payload: log };
}

export function buildNotification(id: string, title: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'event',
    event: 'notification',
    id,
    payload: { id, recipient: 'operator', type: 'info', title, message, created_at: Math.floor(Date.now() / 1000), ...extra },
  };
}

export function buildAgentStatus(id: string, status: string, frameId?: string) {
  return {
    type: 'event',
    event: 'agent.status',
    id: frameId ?? id,
    payload: { id, status, last_seen: Date.now(), last_activity: Date.now() },
  };
}
