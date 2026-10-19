/**
 * Server-mode event intake for the bridge.
 *
 * On a deployed host there are no laptop-local transcript files, so waves and
 * agents POST lifecycle events here instead of (or alongside) the JSONL tailer.
 * Log/status/notification events become live frames immediately; usage/session
 * events mutate an overlay that the tick snapshot absorbs each tick.
 *
 * Frames that Mission Control drops (`token_usage`, `session_update`,
 * `spawn_result`, `cron_status`) are NEVER emitted — see frames.ts.
 */
import { z } from 'zod';
import {
  buildLog,
  buildNotification,
  buildAgentStatus,
  type TickSnapshot,
  type SnapshotSession,
} from './frames';

const baseEvent = z.object({
  waveKey: z.string().min(1).optional(),
});

const logIntakeSchema = baseEvent.extend({
  event: z.literal('log'),
  message: z.string().min(1).max(5000),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  source: z.string().max(100).default('ai-team'),
  session: z.string().max(200).optional(),
});

const statusIntakeSchema = baseEvent.extend({
  event: z.literal('agent.status'),
  role: z.string().min(1).max(100),
  status: z.string().min(1).max(50),
});

const notificationIntakeSchema = baseEvent.extend({
  event: z.literal('notification'),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
});

const usageIntakeSchema = baseEvent.extend({
  event: z.literal('usage'),
  totalTokens: z.number().int().min(0).optional(),
  messageCount: z.number().int().min(0).optional(),
  cost: z.number().min(0).optional(),
  model: z.string().max(100).optional(),
});

const sessionIntakeSchema = baseEvent.extend({
  event: z.literal('session'),
  key: z.string().min(1).max(200),
  kind: z.string().max(100).default('ai-team-remote'),
  model: z.string().max(100).optional(),
  active: z.boolean().default(true),
});

export const ingestEventSchema = z.discriminatedUnion('event', [
  logIntakeSchema,
  statusIntakeSchema,
  notificationIntakeSchema,
  usageIntakeSchema,
  sessionIntakeSchema,
]);

export type IngestEvent = z.infer<typeof ingestEventSchema>;

/**
 * Overlay mutated by usage/session intake events and absorbed into the tick
 * snapshot each tick. Keyed by session key; never fabricates — absent fields
 * leave the base snapshot untouched.
 */
export class IntakeOverlay {
  private sessions = new Map<string, Partial<SnapshotSession> & { key: string }>();

  noteUsage(
    key: string,
    patch: { totalTokens?: number; messageCount?: number; cost?: number; model?: string },
  ): void {
    const prev = this.sessions.get(key) ?? { key };
    const next = { ...prev };
    if (patch.totalTokens !== undefined) {
      next.totalTokens = Math.max(prev.totalTokens ?? 0, patch.totalTokens);
    }
    if (patch.messageCount !== undefined) {
      next.messageCount = Math.max(prev.messageCount ?? 0, patch.messageCount);
    }
    if (patch.cost !== undefined) {
      next.cost = Math.max(prev.cost ?? 0, patch.cost);
    }
    if (patch.model !== undefined) next.model = patch.model;
    next.updatedAt = Date.now();
    this.sessions.set(key, next);
  }

  noteSession(key: string, patch: { kind?: string; model?: string; active?: boolean }): void {
    const prev = this.sessions.get(key) ?? { key };
    this.sessions.set(key, { ...prev, ...patch, updatedAt: Date.now() });
  }

  apply(base: TickSnapshot): TickSnapshot {
    if (this.sessions.size === 0) return base;
    const byKey = new Map(base.sessions.map((s) => [s.key, { ...s }]));
    for (const [key, patch] of this.sessions) {
      const existing = byKey.get(key);
      if (existing) {
        byKey.set(key, { ...existing, ...patch, key, updatedAt: patch.updatedAt ?? Date.now() });
      } else {
        byKey.set(key, {
          key,
          kind: patch.kind ?? 'ai-team-remote',
          updatedAt: patch.updatedAt ?? Date.now(),
          model: patch.model ?? 'unknown',
          totalTokens: patch.totalTokens ?? 0,
          contextTokens: 0,
          messageCount: patch.messageCount ?? 0,
          cost: patch.cost ?? 0,
        });
      }
    }
    return { sessions: [...byKey.values()] };
  }
}

export interface IngestContext {
  waveKey: string;
  nextId: () => string;
  overlay: IntakeOverlay;
}

export interface IngestResult {
  /** Live frame to queue, if the event produces one. Usage/session mutate the overlay instead. */
  frame?: unknown;
  ack: Record<string, unknown>;
}

/** Map a validated intake event to a live frame and/or overlay mutation. */
export function mapIngestEvent(event: IngestEvent, ctx: IngestContext): IngestResult {
  const id = ctx.nextId();
  switch (event.event) {
    case 'log':
      return {
        frame: buildLog({
          id,
          timestamp: Date.now(),
          level: event.level,
          source: event.source,
          session: event.session,
          message: `[${event.waveKey ?? ctx.waveKey}] ${event.message}`,
        }),
        ack: { id },
      };
    case 'agent.status':
      return {
        frame: buildAgentStatus(event.role, event.status, id),
        ack: { id },
      };
    case 'notification':
      return {
        frame: buildNotification(id, event.title, event.message),
        ack: { id },
      };
    case 'usage': {
      const key = event.waveKey ?? ctx.waveKey;
      ctx.overlay.noteUsage(key, {
        totalTokens: event.totalTokens,
        messageCount: event.messageCount,
        cost: event.cost,
        model: event.model,
      });
      return { ack: { id, applied: 'tick-overlay', session: key } };
    }
    case 'session': {
      ctx.overlay.noteSession(event.key, {
        kind: event.kind,
        model: event.model,
        active: event.active,
      });
      return { ack: { id, applied: 'tick-overlay', session: event.key } };
    }
  }
}
