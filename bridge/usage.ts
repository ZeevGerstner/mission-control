/**
 * T3 — usage surfacing WITHOUT forbidden live frames.
 *
 * MC's live frame path handles only tick/log/chat.message/notification/
 * agent.status. Totals therefore travel inside the tick snapshot's session
 * fields (totalTokens/contextTokens/messageCount/cost) and wave milestones
 * travel as notification frames. This module parses `Tokens:` Done-body
 * lines, accumulates cumulative totals, and builds those notifications.
 *
 * Cost: there is no pricing source in this repo, so cost stays 0 rather
 * than fabricating a dollar figure.
 */
import fs from 'node:fs';
import { buildNotification, type TickSnapshot } from './frames';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  cost: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  messageCount: 0,
  cost: 0,
};

/**
 * Parse a Done-body Tokens line, e.g.
 *   "Tokens: ~11k input / ~2.4k output (source: estimate)"
 * Supports `k` suffixes, tildes, and plain integers. Returns null when the
 * text carries no parseable Tokens line (never throws, never guesses).
 */
export function parseUsageFromText(text: string): { inputTokens: number; outputTokens: number } | null {
  const match = /tokens:\s*~?\s*([\d.,]+)\s*(k?)\s*input\s*\/\s*~?\s*([\d.,]+)\s*(k?)\s*output/i.exec(text);
  if (!match) return null;
  const scale = (num: string, kilo: string): number | null => {
    const n = Number(num.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * (kilo.toLowerCase() === 'k' ? 1000 : 1));
  };
  const inputTokens = scale(match[1], match[2]);
  const outputTokens = scale(match[3], match[4]);
  if (inputTokens === null || outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

/** Add one parsed usage sample to running totals (cost stays 0: no source). */
export function addUsage(totals: UsageTotals, sample: { inputTokens: number; outputTokens: number }): UsageTotals {
  const inputTokens = totals.inputTokens + sample.inputTokens;
  const outputTokens = totals.outputTokens + sample.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    messageCount: totals.messageCount,
    cost: 0,
  };
}

/** Parse a context-window spec like "500k" (active.json) → 500000. */
export function parseContextTokens(value: unknown, fallback = 35000): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const match = /^\s*([\d.,]+)\s*([kKmM]?)\s*$/.exec(value);
    if (match) {
      const n = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) {
        const mult = match[2].toLowerCase() === 'm' ? 1_000_000 : match[2].toLowerCase() === 'k' ? 1000 : 1;
        return Math.floor(n * mult);
      }
    }
  }
  return fallback;
}

/**
 * Per-role model override table (gitignored bridge/session-table.json):
 *   {"roles": {"orchestrator": {"model": "..."}, ...}}
 * Missing/unreadable/empty → {} (callers render the default; NEVER
 * fabricate a model string for a role with no entry).
 */
export function loadSessionTable(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { roles?: Record<string, { model?: unknown }> };
    const roles = parsed.roles;
    if (typeof roles !== 'object' || roles === null) return {};
    const out: Record<string, string> = {};
    for (const [role, entry] of Object.entries(roles)) {
      if (typeof entry === 'object' && entry !== null && typeof entry.model === 'string' && entry.model !== '') {
        out[role] = entry.model;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Resolve a display model: role override when present, else the default. */
export function resolveModel(sessionTable: Record<string, string>, role: string, defaultModel: string): string {
  return sessionTable[role] ?? defaultModel;
}

export interface WaveSnapshotInput {
  waveKey: string;
  model: string;
  contextTokens: number;
  totals: UsageTotals;
  isActive: boolean;
  updatedAt?: number;
}

/** One-session-per-wave tick snapshot (shape matches frames.fixtureSnapshot). */
export function buildWaveSnapshot(input: WaveSnapshotInput): TickSnapshot {
  return {
    sessions: [
      {
        key: input.waveKey,
        kind: 'ai-team-local',
        updatedAt: input.updatedAt ?? Date.now(),
        model: input.model,
        totalTokens: input.totals.totalTokens,
        contextTokens: input.contextTokens,
        messageCount: input.totals.messageCount,
        cost: input.totals.cost,
      },
    ],
  };
}

/** Cumulative usage state (gitignored bridge/usage-state.json). Survives restarts. */
export interface UsageState {
  totals: UsageTotals;
  notifiedStart: boolean;
  notifiedWaveDone: boolean;
  notifiedDoneFiles: string[];
}

export function emptyUsageState(): UsageState {
  return { totals: { ...EMPTY_TOTALS }, notifiedStart: false, notifiedWaveDone: false, notifiedDoneFiles: [] };
}

export function loadUsageState(filePath: string): UsageState {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UsageState>;
    const base = emptyUsageState();
    return {
      totals: { ...base.totals, ...(parsed.totals ?? {}) },
      notifiedStart: parsed.notifiedStart === true,
      notifiedWaveDone: parsed.notifiedWaveDone === true,
      notifiedDoneFiles: Array.isArray(parsed.notifiedDoneFiles)
        ? parsed.notifiedDoneFiles.filter((f): f is string => typeof f === 'string')
        : [],
    };
  } catch {
    return emptyUsageState();
  }
}

/** Persist usage state. Never throws (a failed save must not break polling). */
export function saveUsageState(filePath: string, state: UsageState): void {
  try {
    fs.mkdirSync(filePath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {
    // Swallowed by design: usage accounting is best-effort, polling is not.
  }
}

export function buildStartNotification(frameId: string, waveKey: string): ReturnType<typeof buildNotification> {
  return buildNotification(frameId, `Wave ${waveKey} live`, `AI-team bridge is tailing transcripts for ${waveKey}.`, {
    source_type: 'wave',
    source_id: waveKey,
  });
}

export function buildAgentDoneNotification(
  frameId: string,
  waveKey: string,
  agentFile: string,
  sample: { inputTokens: number; outputTokens: number } | null,
): ReturnType<typeof buildNotification> {
  const usage = sample ? ` (${sample.inputTokens + sample.outputTokens} tokens)` : '';
  return buildNotification(frameId, `Agent done: ${agentFile}`, `${waveKey} · ${agentFile} reported Done${usage}.`, {
    source_type: 'wave',
    source_id: waveKey,
  });
}

export function buildWaveDoneNotification(frameId: string, waveKey: string): ReturnType<typeof buildNotification> {
  return buildNotification(frameId, `Wave ${waveKey} done`, `Active marker moved on; ${waveKey} is no longer the active wave.`, {
    source_type: 'wave',
    source_id: waveKey,
  });
}
