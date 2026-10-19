/**
 * Bridge server: HTTP + WebSocket on one port.
 *
 * - GET /health → 200 (liveness for QA/ops)
 * - WS: on connect send `connect.challenge`; accept `connect` req → `res ok`;
 *   answer EVERY `ping` req with `res ok` synchronously + unconditionally
 *   (MC force-reconnects after 3 missed pongs — acceptance #1).
 * - Fixture `tick` loop emits a canned session snapshot (T2 wires real data).
 *
 * No native modules: deps are `ws` + `zod` only. No imports from `src/`.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { CursorStore } from './cursor';
import {
  PROTOCOL_VERSION,
  buildChallenge,
  buildConnectOk,
  buildConnectReject,
  buildPong,
  buildTick,
  connectReqSchema,
  fixtureSnapshot,
  pingReqSchema,
  type TickSnapshot,
} from './frames';

export interface BridgeOptions {
  port: number;
  /** Bind host. 127.0.0.1 local; 0.0.0.0 in containers (BRIDGE_HOST). */
  host?: string;
  /**
   * Intake shared secret (BRIDGE_INGEST_TOKEN). When set, POST /ingest
   * requires `Authorization: Bearer <token>`. Unset = open local trust.
   */
  ingestToken?: string;
  /**
   * Intake handler (index.ts wires validation + mapping). Receives the parsed
   * JSON body; returns the HTTP status + response body. Absent = 404.
   */
  onIngest?: (body: unknown) => { status: number; body: Record<string, unknown> };
  tickIntervalMs: number;
  waveKey: string;
  cursorPath: string;
  /** Override the snapshot source (tests / T2 tailer). Defaults to fixture. */
  snapshot?: () => TickSnapshot;
  /**
   * Optional live-frame source (T2 tailer + T3 milestones). Drained after
   * each tick and fanned out to open clients. Must never throw — the tick
   * loop guards it. Tick + ping behavior is unchanged when absent.
   */
  pollFrames?: () => unknown[];
  /**
   * Share one CursorStore between the tailer (index.ts) and the tick loop.
   * Two instances over the same file would fork the in-memory seq counter
   * and re-issue frame ids. Tests omit this and keep the internal load.
   */
  store?: CursorStore;
}

export interface BridgeHandle {
  port: number;
  startTime: number;
  close(): Promise<void>;
  clientCount(): number;
}

export async function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const store = opts.store ?? CursorStore.load(opts.cursorPath);
  const snapshotFn = opts.snapshot ?? (() => fixtureSnapshot(opts.waveKey));
  const startTime = Date.now();

  const MAX_INGEST_BYTES = 1_000_000;

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, waveKey: opts.waveKey, uptimeMs: Date.now() - startTime }));
      return;
    }
    if (req.method === 'POST' && req.url?.split('?')[0] === '/ingest') {
      if (!opts.onIngest) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'intake disabled' }));
        return;
      }
      if (opts.ingestToken) {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${opts.ingestToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
          return;
        }
      }
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_INGEST_BYTES) chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > MAX_INGEST_BYTES) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'body too large' }));
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        try {
          const result = opts.onIngest!(body);
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: result.status < 400, ...result.body }));
        } catch {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'intake failed' }));
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    // Handshake step 1: challenge on connect. Deferred a tick so the client's
    // `open` handler (and its message listener) is always attached first —
    // a synchronous send here can win the race and be dropped by some clients.
    const nonce = randomUUID();
    setImmediate(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(buildChallenge(nonce)));
      else ws.once('open', () => ws.send(JSON.stringify(buildChallenge(nonce))));
    });

    ws.on('message', (raw: Buffer) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString('utf8'));
      } catch {
        return; // malformed → ignore, never crash the bridge
      }
      if (typeof frame !== 'object' || frame === null) return;
      const msg = frame as Record<string, unknown>;

      // Ping responder: FIRST branch, synchronous + unconditional.
      // Never gate behind handshake state or any other health.
      const ping = pingReqSchema.safeParse(msg);
      if (ping.success) {
        ws.send(JSON.stringify(buildPong(ping.data.id)));
        return;
      }

      const connect = connectReqSchema.safeParse(msg);
      if (connect.success) {
        const { id, params } = connect.data;
        const min = params?.minProtocol ?? PROTOCOL_VERSION;
        const max = params?.maxProtocol ?? PROTOCOL_VERSION;
        if (min <= PROTOCOL_VERSION && PROTOCOL_VERSION <= max) {
          ws.send(JSON.stringify(buildConnectOk(id)));
        } else {
          ws.send(JSON.stringify(buildConnectReject(id, `protocol ${PROTOCOL_VERSION} not in [${min},${max}]`)));
        }
        return;
      }
      // Unknown frames → ignore quietly (no error spam into MC logs).
    });
  });

  // Fixture tick loop: canned session snapshot so MC renders pre-tailer.
  // Frame ids are stable `<waveKey>-<seq>` via the cursor store (no re-emit on restart).
  const timer = setInterval(() => {
    const frame = buildTick(snapshotFn(), store.nextFrameId(opts.waveKey));
    const text = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
    // Live tailer drain (T2/T3): extra frames go out on the same tick, but a
    // failing poller can never break the tick above or the ping responder.
    try {
      const extra = opts.pollFrames?.() ?? [];
      if (extra.length > 0) {
        const texts = extra.map((f) => JSON.stringify(f));
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            for (const t of texts) client.send(t);
          }
        }
      }
    } catch {
      // Swallowed by design: polling is best-effort, the socket is not.
    }
  }, opts.tickIntervalMs);
  timer.unref();

  // Free-before-bind: fail fast with a clear error instead of crashing later.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`bridge port ${opts.port} already in use (BRIDGE_PORT=${opts.port})`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      httpServer.removeAllListeners('error');
      resolve();
    });
  });

  const boundPort = (httpServer.address() as { port: number }).port;
  return {
    port: boundPort,
    startTime,
    clientCount: () => [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN).length,
    close: async () => {
      clearInterval(timer);
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
