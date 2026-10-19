/**
 * T2 transcript tailer: polls agent-transcripts/<parent>/subagents/*.jsonl
 * from persisted byte offsets and emits live frames.
 *
 * Cursor discipline (load-bearing for restart-no-dup):
 * - Resume each file from `store.getCursor(<sessionKey>:<basename>)`.
 * - `store.nextFrameId` + `store.setCursor` flush to disk BEFORE the built
 *   frame is returned to the caller (the caller sends it). Never after.
 * - Malformed lines advance the offset too (else the tailer would re-read
 *   them forever) and bump `droppedLines`, surfaced as a periodic `log`.
 * - Never throws: missing dir/files, short reads, and truncated offsets
 *   all degrade to empty results. The socket loop and tick timer are never
 *   disturbed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CursorStore } from './cursor';
import {
  buildDroppedLinesLog,
  buildMessageLog,
  buildTurnEndedStatus,
  parseTranscriptLine,
} from './mapper';
import {
  addUsage,
  buildAgentDoneNotification,
  buildStartNotification,
  buildWaveDoneNotification,
  buildWaveSnapshot,
  loadSessionTable,
  loadUsageState,
  parseUsageFromText,
  resolveModel,
  saveUsageState,
  type UsageState,
} from './usage';

export interface TailerConfig {
  /** Absolute dir holding subagents/*.jsonl (env BRIDGE_TRANSCRIPTS_DIR). */
  transcriptDir: string;
  waveKey: string;
  /** Model default from active.json modelProfile.plannerModel. */
  model: string;
  contextTokens: number;
  /** True while active.json still names this waveKey. */
  isActive: boolean;
  /** Gitignored cumulative usage/notification state. */
  usageStatePath: string;
  /** Gitignored per-role model overrides (may be absent/empty). */
  sessionTablePath: string;
  sessionKey?: string;
}

export interface PollResult {
  /** Frames ready to send (log + agent.status + notification only). */
  frames: unknown[];
  /** Cumulative tick snapshot for this wave. */
  snapshot: ReturnType<typeof buildWaveSnapshot>;
  newLines: number;
  droppedLines: number;
}

function listTranscriptFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function readBytesFrom(filePath: string, offset: number): { text: string; startOffset: number } {
  const buf = fs.readFileSync(filePath);
  const startOffset = offset > buf.length ? 0 : offset;
  return { text: buf.subarray(startOffset).toString('utf8'), startOffset };
}

export function pollTranscripts(store: CursorStore, config: TailerConfig): PollResult {
  const frames: unknown[] = [];
  const sessionKey = config.sessionKey ?? config.waveKey;
  let usage: UsageState;
  try {
    usage = loadUsageState(config.usageStatePath);
  } catch {
    usage = { totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0, cost: 0 }, notifiedStart: false, notifiedWaveDone: false, notifiedDoneFiles: [] };
  }
  let sessionTable: Record<string, string> = {};
  try {
    sessionTable = loadSessionTable(config.sessionTablePath);
  } catch {
    sessionTable = {};
  }

  let newLines = 0;
  let droppedLines = 0;

  // Wave-start milestone (once ever — persisted flag keeps restarts dup-free).
  if (config.isActive && !usage.notifiedStart) {
    const id = store.nextFrameId(config.waveKey);
    usage.notifiedStart = true;
    try {
      saveUsageState(config.usageStatePath, usage);
    } catch {
      // best-effort
    }
    frames.push(buildStartNotification(id, config.waveKey));
  }

  for (const filePath of listTranscriptFiles(config.transcriptDir)) {
    const basename = path.basename(filePath);
    const cursorKey = `${sessionKey}:${basename}`;
    let offset: number;
    try {
      offset = store.getCursor(cursorKey)?.offset ?? 0;
    } catch {
      offset = 0;
    }

    let text: string;
    try {
      const read = readBytesFrom(filePath, offset);
      // A shrunk file means rotation/rewrite: restart from 0 (documented
      // re-read risk, accepted over silent data loss).
      offset = read.startOffset;
      text = read.text;
    } catch {
      continue; // unreadable file → skip, never break the poll
    }
    if (text === '') continue;

    // Hold back a trailing partial line (no newline = still being written).
    // text.split('\n') always yields a trailing element to drop: '' when the
    // file ends with '\n', or the incomplete tail otherwise.
    const complete = text.split('\n').slice(0, -1);
    let cursor = offset;

    for (const rawLine of complete) {
      cursor += Buffer.byteLength(rawLine, 'utf8') + 1; // +1 for the '\n'
      if (rawLine.trim() === '') {
        try {
          store.setCursor(cursorKey, { file: basename, offset: cursor, lastEventId: '' });
        } catch {
          // best-effort
        }
        continue;
      }
      const parsed = parseTranscriptLine(rawLine);
      if (parsed.kind === 'empty') {
        try {
          store.setCursor(cursorKey, { file: basename, offset: cursor, lastEventId: '' });
        } catch {
          // best-effort
        }
        continue;
      }
      if (parsed.kind === 'malformed') {
        droppedLines += 1;
        try {
          store.setCursor(cursorKey, { file: basename, offset: cursor, lastEventId: '' });
        } catch {
          // best-effort
        }
        continue;
      }

      // Mappable line: flush id + cursor BEFORE the frame leaves this poll.
      let frameId: string;
      try {
        frameId = store.nextFrameId(config.waveKey);
      } catch {
        continue;
      }
      try {
        store.setCursor(cursorKey, { file: basename, offset: cursor, lastEventId: frameId });
      } catch {
        // best-effort: the seq already advanced, so at worst this line
        // re-emits once under a NEW stable id (no silent id reuse).
      }

      newLines += 1;
      usage.totals.messageCount += 1;

      if (parsed.kind === 'turn_ended') {
        frames.push(
          buildTurnEndedStatus({ frameId, agentId: `${config.waveKey}:${basename}`, turnStatus: parsed.status }),
        );
      } else {
        const model = resolveModel(sessionTable, parsed.role, config.model);
        void model; // role model override reserved for the session label; never fabricated into frames
        frames.push(
          buildMessageLog({
            frameId,
            sessionKey,
            agentFile: basename,
            role: parsed.role,
            summary: parsed.summary,
          }),
        );
        if (parsed.isDone) {
          const sample = parseUsageFromText(parsed.body);
          if (sample) usage.totals = addUsage(usage.totals, sample);
          if (!usage.notifiedDoneFiles.includes(basename)) {
            usage.notifiedDoneFiles.push(basename);
            let noteId: string;
            try {
              noteId = store.nextFrameId(config.waveKey);
            } catch {
              noteId = frameId;
            }
            frames.push(buildAgentDoneNotification(noteId, config.waveKey, basename, sample));
          }
        }
      }
    }
  }

  if (droppedLines > 0) {
    let dropId: string;
    try {
      dropId = store.nextFrameId(config.waveKey);
    } catch {
      dropId = `${config.waveKey}-dropped`;
    }
    frames.push(buildDroppedLinesLog({ frameId: dropId, sessionKey, droppedLines }));
  }

  // Wave-closeout milestone (once ever).
  if (!config.isActive && !usage.notifiedWaveDone) {
    let doneId: string;
    try {
      doneId = store.nextFrameId(config.waveKey);
    } catch {
      doneId = `${config.waveKey}-wave-done`;
    }
    usage.notifiedWaveDone = true;
    frames.push(buildWaveDoneNotification(doneId, config.waveKey));
  }

  try {
    saveUsageState(config.usageStatePath, usage);
  } catch {
    // best-effort
  }

  return {
    frames,
    snapshot: buildWaveSnapshot({
      waveKey: config.waveKey,
      model: config.model,
      contextTokens: config.contextTokens,
      totals: usage.totals,
      isActive: config.isActive,
    }),
    newLines,
    droppedLines,
  };
}
