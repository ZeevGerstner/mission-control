import { describe, it, expect } from 'vitest';
import {
  IntakeOverlay,
  ingestEventSchema,
  mapIngestEvent,
  type IngestContext,
} from './ingest';

function testCtx(overlay = new IntakeOverlay()): IngestContext & { ids: string[] } {
  const ids: string[] = [];
  let seq = 500;
  return {
    waveKey: 'WAVE-TEST',
    nextId: () => {
      seq += 1;
      const id = `WAVE-TEST-${seq}`;
      ids.push(id);
      return id;
    },
    overlay,
    ids,
  };
}

describe('ingest event validation', () => {
  it('rejects unknown event kinds', () => {
    expect(ingestEventSchema.safeParse({ event: 'token_usage' }).success).toBe(false);
    expect(ingestEventSchema.safeParse({ event: 'hax' }).success).toBe(false);
  });

  it('rejects empty log messages and oversized payloads', () => {
    expect(ingestEventSchema.safeParse({ event: 'log', message: '' }).success).toBe(false);
    expect(
      ingestEventSchema.safeParse({ event: 'log', message: 'x'.repeat(5001) }).success,
    ).toBe(false);
  });

  it('accepts all five event kinds with defaults', () => {
    for (const body of [
      { event: 'log', message: 'hi' },
      { event: 'agent.status', role: 'qa', status: 'busy' },
      { event: 'notification', title: 't', message: 'm' },
      { event: 'usage', totalTokens: 10 },
      { event: 'session', key: 'WAVE-X' },
    ]) {
      expect(ingestEventSchema.safeParse(body).success).toBe(true);
    }
  });
});

describe('mapIngestEvent frames', () => {
  it('log → live log frame with stable id', () => {
    const ctx = testCtx();
    const parsed = ingestEventSchema.safeParse({ event: 'log', message: 'hello' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = mapIngestEvent(parsed.data, ctx);
    const frame = result.frame as any;
    expect(frame.type).toBe('event');
    expect(frame.event).toBe('log');
    expect(frame.id).toBe('WAVE-TEST-501');
    expect(frame.payload.message).toContain('hello');
  });

  it('agent.status → status frame keyed by role', () => {
    const ctx = testCtx();
    const parsed = ingestEventSchema.safeParse({ event: 'agent.status', role: 'scaffolder', status: 'done' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const frame = mapIngestEvent(parsed.data, ctx).frame as any;
    expect(frame.event).toBe('agent.status');
    expect(frame.payload.id).toBe('scaffolder');
    expect(frame.payload.status).toBe('done');
  });

  it('notification → notification frame', () => {
    const ctx = testCtx();
    const parsed = ingestEventSchema.safeParse({ event: 'notification', title: 'Wave Done', message: 'all green' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const frame = mapIngestEvent(parsed.data, ctx).frame as any;
    expect(frame.event).toBe('notification');
    expect(frame.payload.title).toBe('Wave Done');
  });

  it('usage/session mutate the overlay, emit no frame', () => {
    const overlay = new IntakeOverlay();
    const ctx = testCtx(overlay);
    for (const body of [
      { event: 'usage', totalTokens: 1234, messageCount: 12 },
      { event: 'session', key: 'WAVE-REMOTE', model: 'muse-x' },
    ]) {
      const parsed = ingestEventSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const result = mapIngestEvent(parsed.data, ctx);
      expect(result.frame).toBeUndefined();
      expect(result.ack.applied).toBe('tick-overlay');
    }
    const snap = overlay.apply({ sessions: [] });
    expect(snap.sessions.map((s) => s.key).sort()).toEqual(['WAVE-REMOTE', 'WAVE-TEST']);
    const remote = snap.sessions.find((s) => s.key === 'WAVE-REMOTE')!;
    expect(remote.model).toBe('muse-x');
    const local = snap.sessions.find((s) => s.key === 'WAVE-TEST')!;
    expect(local.totalTokens).toBe(1234);
    expect(local.messageCount).toBe(12);
  });

  it('usage totals only move forward, models never fabricated', () => {
    const overlay = new IntakeOverlay();
    const ctx = testCtx(overlay);
    const apply = (body: unknown) => {
      const parsed = ingestEventSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) mapIngestEvent(parsed.data, ctx);
    };
    apply({ event: 'usage', totalTokens: 5000 });
    apply({ event: 'usage', totalTokens: 100 }); // stale report → ignored
    const snap = overlay.apply({ sessions: [] });
    expect(snap.sessions[0].totalTokens).toBe(5000);
    expect(snap.sessions[0].model).toBe('unknown');
  });

  it('overlay merges into (never replaces) the tailer snapshot', () => {
    const overlay = new IntakeOverlay();
    const ctx = testCtx(overlay);
    const parsed = ingestEventSchema.safeParse({ event: 'usage', totalTokens: 42 });
    if (parsed.success) mapIngestEvent(parsed.data, ctx);
    const base = {
      sessions: [
        {
          key: 'WAVE-TEST',
          kind: 'ai-team-local',
          updatedAt: 1,
          model: 'grok-4.7',
          totalTokens: 10,
          contextTokens: 500000,
          messageCount: 2,
          cost: 0,
        },
      ],
    };
    const merged = overlay.apply(base);
    expect(merged.sessions).toHaveLength(1);
    expect(merged.sessions[0].totalTokens).toBe(42);
    expect(merged.sessions[0].model).toBe('grok-4.7');
    expect(merged.sessions[0].contextTokens).toBe(500000);
  });
});
