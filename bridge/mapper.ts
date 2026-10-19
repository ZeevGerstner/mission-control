/**
 * Transcript → frame mapping (pure functions: no I/O, no sockets, no throw).
 *
 * Source lines are Cursor agent-transcript JSONL:
 *   {"role":"user"|"assistant","message":{"content":[...]}}   (content items:
 *   text | tool_use | tool_result, mirroring the live transcript shape)
 *   {"type":"turn_ended","status":"success"|...}              (turn boundary)
 *
 * Mapping contract (from the locked wave plan):
 *   per-line message  → `log` frame (one line, human-readable summary)
 *   `turn_ended`      → `agent.status` frame
 *   malformed/empty   → skipped by the caller + counted (never thrown)
 *
 * PROHIBITION (T3 trap — MC's live frame path silently drops these, so the
 * bridge must never emit them; usage totals travel inside the tick snapshot
 * and milestones travel as notification frames instead):
 *   token_usage / session_update / spawn_result / cron_status
 * are named here ONLY in this comment. There is no builder, no emitter, and
 * no event literal for them anywhere in runtime bridge code — usage.test.ts
 * asserts that absence against every non-test bridge/*.ts source file.
 */
import { buildAgentStatus, buildLog } from './frames';

export const MAX_SUMMARY_CHARS = 280;

/** Structured result of parsing one raw transcript line. */
export type ParsedLine =
  | { kind: 'empty' }
  | { kind: 'malformed'; raw: string }
  | { kind: 'turn_ended'; status: string }
  | {
      kind: 'message';
      role: string;
      summary: string;
      /** Full text body (for usage scanning); may be '' for tool-only lines. */
      body: string;
      /** True when the body carries a Done VALIDATION block (T3 milestone). */
      isDone: boolean;
    };

/** True when a text body carries a Done VALIDATION block (wave milestone). */
export function isDoneBody(text: string): boolean {
  return text.includes('VALIDATION');
}

/** Truncate a summary to a single feed-safe line. */
export function clipSummary(text: string, max = MAX_SUMMARY_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Summarize one transcript content item for the LiveFeed.
 * Tool calls render as `tool·<name> <short-args>`; text renders clipped.
 */
export function summarizeItem(item: unknown): string {
  if (typeof item !== 'object' || item === null) return '';
  const rec = item as Record<string, unknown>;
  if (rec.type === 'text') {
    return typeof rec.text === 'string' ? clipSummary(rec.text) : '';
  }
  if (rec.type === 'tool_use') {
    const name = typeof rec.name === 'string' ? rec.name : 'unknown';
    let args = '';
    try {
      const input = (rec as { input?: unknown }).input;
      if (input !== undefined) args = ` ${clipSummary(JSON.stringify(input), 120)}`;
    } catch {
      args = '';
    }
    return clipSummary(`tool·${name}${args}`, MAX_SUMMARY_CHARS);
  }
  if (rec.type === 'tool_result') {
    return 'tool·result';
  }
  return '';
}

/** Summarize a content array (or anything else, tolerantly) into log text. */
export function summarizeContent(content: unknown): { summary: string; body: string } {
  if (!Array.isArray(content)) return { summary: '(unstructured line)', body: '' };
  const parts: string[] = [];
  const bodies: string[] = [];
  for (const item of content) {
    const s = summarizeItem(item);
    if (s) parts.push(s);
    if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
      const t = (item as Record<string, unknown>).text;
      if (typeof t === 'string') bodies.push(t);
    }
  }
  const summary = parts.length > 0 ? parts.join(' · ') : '(no displayable content)';
  return { summary: clipSummary(summary), body: bodies.join('\n') };
}

/**
 * Parse one raw line. Never throws: unparseable input → `malformed`,
 * valid JSON with an unexpected shape → `malformed` as well (the caller
 * skips + counts; the socket/tick loop is never disturbed).
 */
export function parseTranscriptLine(rawLine: string): ParsedLine {
  if (rawLine.trim() === '') return { kind: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return { kind: 'malformed', raw: rawLine };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'malformed', raw: rawLine };
  }
  const rec = parsed as Record<string, unknown>;

  if (rec.type === 'turn_ended') {
    const status = typeof rec.status === 'string' ? rec.status : 'unknown';
    return { kind: 'turn_ended', status };
  }

  const role = typeof rec.role === 'string' ? rec.role : undefined;
  const message = rec.message;
  if (role === undefined || typeof message !== 'object' || message === null) {
    return { kind: 'malformed', raw: rawLine };
  }
  const content = (message as Record<string, unknown>).content;
  // Content must be the transcript array; anything else is a shape drift —
  // skip + count rather than emitting placeholder noise into the LiveFeed.
  if (!Array.isArray(content)) {
    return { kind: 'malformed', raw: rawLine };
  }
  const { summary, body } = summarizeContent(content);
  return { kind: 'message', role, summary, body, isDone: isDoneBody(body) };
}

export interface LogBuildInput {
  frameId: string;
  sessionKey: string;
  agentFile: string;
  role: string;
  summary: string;
  timestamp?: number;
}

/** Build the `log` frame for one parsed message line. */
export function buildMessageLog(input: LogBuildInput): ReturnType<typeof buildLog> {
  return buildLog({
    id: input.frameId,
    timestamp: input.timestamp ?? Date.now(),
    level: 'info',
    source: `ai-team/${input.agentFile}`,
    session: input.sessionKey,
    message: `[${input.role}] ${input.summary}`,
  });
}

export interface StatusBuildInput {
  frameId: string;
  agentId: string;
  turnStatus: string;
  timestamp?: number;
}

/** Build the `agent.status` frame for one `turn_ended` line. */
export function buildTurnEndedStatus(input: StatusBuildInput): ReturnType<typeof buildAgentStatus> {
  void input.timestamp;
  return buildAgentStatus(input.agentId, `turn_${input.turnStatus}`, input.frameId);
}

export interface DroppedLinesInput {
  frameId: string;
  sessionKey: string;
  droppedLines: number;
  timestamp?: number;
}

/** Periodic `log` frame surfacing the malformed-line skip counter. */
export function buildDroppedLinesLog(input: DroppedLinesInput): ReturnType<typeof buildLog> {
  return buildLog({
    id: input.frameId,
    timestamp: input.timestamp ?? Date.now(),
    level: 'warn',
    source: 'bridge/tailer',
    session: input.sessionKey,
    message: `tailer skipped ${input.droppedLines} malformed transcript line(s) (counted, socket unaffected)`,
  });
}
