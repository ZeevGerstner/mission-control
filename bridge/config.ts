/**
 * Bridge runtime config.
 * Port comes from BRIDGE_PORT (default 3101). :3000/:3005 are reserved for
 * Mission Control and are refused so the bridge can never steal them.
 */
import path from 'node:path';

export const DEFAULT_PORT = 3101;
export const RESERVED_PORTS = [3000, 3005];
export const DEFAULT_TICK_INTERVAL_MS = 5000;
export const DEFAULT_WAVE_KEY = 'WAVE-20261018-1009';

export interface BridgeConfig {
  port: number;
  host: string;
  /** Optional intake secret (BRIDGE_INGEST_TOKEN). Unset = open local trust. */
  ingestToken?: string;
  tickIntervalMs: number;
  waveKey: string;
  cursorPath: string;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const rawPort = env.BRIDGE_PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BRIDGE_PORT invalid: ${JSON.stringify(rawPort)} (want 1-65535)`);
  }
  if (RESERVED_PORTS.includes(port)) {
    throw new Error(
      `BRIDGE_PORT ${port} collides with Mission Control (:3000/:3005); use default ${DEFAULT_PORT}`,
    );
  }

  const rawTick = env.BRIDGE_TICK_MS ?? String(DEFAULT_TICK_INTERVAL_MS);
  const tickIntervalMs = Number(rawTick);
  if (!Number.isInteger(tickIntervalMs) || tickIntervalMs < 500) {
    throw new Error(`BRIDGE_TICK_MS invalid: ${JSON.stringify(rawTick)} (want integer >= 500)`);
  }

  return {
    port,
    host: env.BRIDGE_HOST ?? '127.0.0.1',
    ingestToken: env.BRIDGE_INGEST_TOKEN || undefined,
    tickIntervalMs,
    waveKey: env.BRIDGE_WAVE_KEY ?? DEFAULT_WAVE_KEY,
    cursorPath: env.BRIDGE_CURSOR_PATH ?? path.join(__dirname, '..', 'cursor.json'),
  };
}
