import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startBridge, type BridgeHandle } from './server';

let dir: string;
let bridge: BridgeHandle | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-server-'));
});

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

interface TestClient {
  ws: WebSocket;
  /** Next inbound frame (queued — early frames are never lost). */
  next: (timeoutMs?: number) => Promise<any>;
  close: () => void;
}

/**
 * Mirrors the real MC client: ONE persistent `message` listener attached at
 * socket creation, frames queued. Attaching `once('message')` only after
 * `open` loses frames the server sent in the same tick as the upgrade.
 */
async function connectClient(port: number): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue: any[] = [];
  const pending: Array<{ resolve: (f: any) => void; reject: (e: Error) => void }> = [];
  ws.on('message', (raw: Buffer) => {
    let frame: any;
    try {
      frame = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    const waiter = pending.shift();
    if (waiter) waiter.resolve(frame);
    else queue.push(frame);
  });
  ws.on('error', (err) => {
    const waiter = pending.shift();
    if (waiter) waiter.reject(err as Error);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = (timeoutMs = 5000): Promise<any> => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
      pending.push({
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  };
  return { ws, next, close: () => ws.close() };
}

describe('bridge server', () => {
  it('handshake: challenge → connect → ok (same id echoed)', async () => {
    bridge = await startBridge({
      port: 0,
      tickIntervalMs: 60_000,
      waveKey: 'WAVE-TEST',
      cursorPath: path.join(dir, 'cursor.json'),
    });
    const client = await connectClient(bridge.port);
    try {
      const challenge = await client.next();
      expect(challenge.type).toBe('event');
      expect(challenge.event).toBe('connect.challenge');
      expect(challenge.payload?.nonce).toBeTruthy();

      client.ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'mc-1',
        params: { minProtocol: 3, maxProtocol: 3 },
      }));
      const res = await client.next();
      expect(res).toEqual({ type: 'res', id: 'mc-1', ok: true });
    } finally {
      client.close();
    }
  });

  it('ping: every ping-N answered <1s with matching id', async () => {
    bridge = await startBridge({
      port: 0,
      tickIntervalMs: 60_000,
      waveKey: 'WAVE-TEST',
      cursorPath: path.join(dir, 'cursor.json'),
    });
    const client = await connectClient(bridge.port);
    try {
      await client.next(); // challenge
      for (const id of ['ping-1', 'ping-2', 'ping-3']) {
        const sentAt = Date.now();
        client.ws.send(JSON.stringify({ type: 'req', method: 'ping', id }));
        const res = await client.next(1000);
        expect(Date.now() - sentAt).toBeLessThan(1000);
        expect(res).toEqual({ type: 'res', id, ok: true });
      }
    } finally {
      client.close();
    }
  });

  it('tick: fixture snapshot emits sessions[] with key/tokens/cost/messageCount', async () => {
    bridge = await startBridge({
      port: 0,
      tickIntervalMs: 200,
      waveKey: 'WAVE-TEST',
      cursorPath: path.join(dir, 'cursor.json'),
    });
    const client = await connectClient(bridge.port);
    try {
      let tick: any;
      for (let i = 0; i < 10 && tick?.event !== 'tick'; i++) tick = await client.next();
      expect(tick.event).toBe('tick');
      const sessions = tick.payload?.snapshot?.sessions;
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
      const s = sessions[0];
      expect(s.key).toBe('WAVE-TEST');
      expect(s).toHaveProperty('totalTokens');
      expect(s).toHaveProperty('contextTokens');
      expect(s).toHaveProperty('cost');
      expect(s).toHaveProperty('messageCount');
    } finally {
      client.close();
    }
  });

  it('health: GET /health → 200', async () => {
    bridge = await startBridge({
      port: 0,
      tickIntervalMs: 60_000,
      waveKey: 'WAVE-TEST',
      cursorPath: path.join(dir, 'cursor.json'),
    });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.waveKey).toBe('WAVE-TEST');
  });

  it('shared store: tick ids + pollFrames ids never collide (single seq)', async () => {
    const { CursorStore } = await import('./cursor');
    const { buildLog } = await import('./frames');
    const store = CursorStore.load(path.join(dir, 'cursor.json'));
    bridge = await startBridge({
      port: 0,
      tickIntervalMs: 100,
      waveKey: 'WAVE-TEST',
      cursorPath: path.join(dir, 'cursor.json'),
      store,
      pollFrames: () => [buildLog({
        id: store.nextFrameId('WAVE-TEST'),
        timestamp: Date.now(),
        level: 'info',
        source: 'test',
        message: 'extra',
      })],
    });
    const client = await connectClient(bridge.port);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const frame = await client.next(5000);
        if (frame.id) ids.push(frame.id);
      }
      // Every emitted frame carries a unique id from one monotonic seq.
      expect(new Set(ids).size).toBe(ids.length);
      const seqs = ids.map((id) => Number(id.split('-').pop()));
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(seqs).toEqual(sorted);
    } finally {
      client.close();
    }
  });
});
