/**
 * Bridge entrypoint: `node dist/index.js` (after `tsc -p bridge/tsconfig.json`).
 *
 * Wires the T2 tailer into the T1 server via the `snapshot` injection point
 * (poll-once-per-tick inside `snapshotFn`, queued frames drained by the
 * server's `pollFrames` hook). The ping responder and tick loop in
 * server.ts are untouched in behavior.
 *
 * Transcript source: BRIDGE_TRANSCRIPTS_DIR (default: this wave's parent
 * session subagents dir — active-wave-only scope). Wave identity + model
 * default come from state/wave/active.json (read-only); per-role model
 * overrides from gitignored bridge/session-table.json (may be absent).
 */
import path from 'node:path';
import { resolveConfig } from './config';
import { startBridge } from './server';
import { CursorStore } from './cursor';
import { fixtureSnapshot, type TickSnapshot } from './frames';
import { pollTranscripts, type TailerConfig } from './tailer';
import { parseContextTokens } from './usage';
import { IntakeOverlay, ingestEventSchema, mapIngestEvent } from './ingest';
import { RosterSync, ROSTER_INTERVAL_MS, readActiveMarker } from './roster';

const BRIDGE_DIR = __dirname;

/** bridge/ whether running from src (ts) or dist (compiled js). */
function bridgeRoot(): string {
  return path.basename(BRIDGE_DIR) === 'dist' ? path.join(BRIDGE_DIR, '..') : BRIDGE_DIR;
}

const DEFAULT_TRANSCRIPTS_DIR =
  '/Users/zevik.g/.cursor/projects/Users-zevik-g-Desktop-Developer-workspaces-mission-control/agent-transcripts/28e5e651-7143-43e3-adb3-da0df010a07b/subagents';

function buildTailerConfig(waveKey: string): TailerConfig {
  // Single shared marker reader (roster.ts) — tailer and roster agree.
  const marker = readActiveMarker();
  const model =
    typeof marker.modelProfile?.plannerModel === 'string' && marker.modelProfile.plannerModel !== ''
      ? marker.modelProfile.plannerModel
      : 'muse-spark-1.3-high';
  const markerWaveKey = typeof marker.waveKey === 'string' ? marker.waveKey : undefined;
  return {
    transcriptDir: process.env.BRIDGE_TRANSCRIPTS_DIR ?? DEFAULT_TRANSCRIPTS_DIR,
    waveKey,
    model,
    contextTokens: parseContextTokens(marker.modelProfile?.contextTokens),
    isActive: markerWaveKey === undefined || markerWaveKey === waveKey,
    usageStatePath:
      process.env.BRIDGE_USAGE_PATH ?? path.join(bridgeRoot(), 'usage-state.json'),
    sessionTablePath: path.join(bridgeRoot(), 'session-table.json'),
  };
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const store = CursorStore.load(config.cursorPath);
  const tailerConfig = buildTailerConfig(config.waveKey);

  // Poll-once-per-tick: refresh the snapshot, stash live frames for the drain.
  let cached: TickSnapshot = fixtureSnapshot(config.waveKey);
  let queued: unknown[] = [];
  // Server-mode overlay: intake usage/session events absorbed into the tick.
  const overlay = new IntakeOverlay();
  try {
    const first = pollTranscripts(store, tailerConfig);
    cached = first.snapshot;
    queued = first.frames;
  } catch {
    // Startup poll is best-effort; the tick loop retries every interval.
  }

  // T-B roster sync: one MC agent row per wave role. Own instance here so
  // intake events double as role discovery (deploy-truth); the interval is
  // started after startBridge, never inside the 5s tick path.
  const roster = new RosterSync({
    waveKey: config.waveKey,
    mcBaseUrl: process.env.MC_BASE_URL ?? 'http://mission-control:3000',
    mcApiKey: process.env.MC_API_KEY ?? '',
    transcriptDir: tailerConfig.transcriptDir,
    sessionTablePath: path.join(bridgeRoot(), 'session-table.json'),
    bridgeDir: bridgeRoot(),
  });

  const bridge = await startBridge({
    port: config.port,
    host: config.host,
    tickIntervalMs: config.tickIntervalMs,
    waveKey: config.waveKey,
    cursorPath: config.cursorPath,
    store, // single CursorStore: tailer polls + tick ids share one seq
    snapshot: () => {
      try {
        const result = pollTranscripts(store, tailerConfig);
        cached = result.snapshot;
        queued.push(...result.frames);
      } catch {
        // Best-effort: keep serving the last good snapshot.
      }
      return overlay.apply(cached);
    },
    pollFrames: () => {
      const out = queued;
      queued = [];
      return out;
    },
    ingestToken: config.ingestToken,
    onIngest: (body: unknown) => {
      const parsed = ingestEventSchema.safeParse(body);
      if (!parsed.success) {
        return { status: 400, body: { error: 'invalid event', issues: parsed.error.issues.length } };
      }
      // Feed roster discovery (role/status registry); guarded, never throws.
      try {
        roster.noteIntakeEvent(parsed.data);
      } catch {
        // Discovery is best-effort; intake mapping below still runs.
      }
      const result = mapIngestEvent(parsed.data, {
        waveKey: config.waveKey,
        nextId: () => store.nextFrameId(config.waveKey),
        overlay,
      });
      if (result.frame) queued.push(result.frame);
      return { status: 200, body: result.ack };
    },
  });
   
  console.log(
    `[bridge] up wave=${config.waveKey} port=${bridge.port} pid=${process.pid} tickMs=${config.tickIntervalMs}`,
  );

  // T-B roster loop: eager first pass + own interval via RosterSync.start
  // (never the 5s tick). syncOnce never throws (failures logged in-result).
  const stopRoster = roster.start(ROSTER_INTERVAL_MS);

  const shutdown = (signal: string) => {
    stopRoster();
     
    console.log(`[bridge] ${signal} — shutting down`);
    void bridge.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
   
  console.error(`[bridge] fatal: ${(err as Error).message}`);
  process.exit(1);
});
