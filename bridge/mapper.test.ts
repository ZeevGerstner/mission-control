import { describe, expect, it } from 'vitest';
import {
  buildDroppedLinesLog,
  buildMessageLog,
  buildTurnEndedStatus,
  clipSummary,
  isDoneBody,
  parseTranscriptLine,
  summarizeContent,
} from './mapper';

describe('parseTranscriptLine', () => {
  it('maps a user text line to a message with clipped summary', () => {
    const parsed = parseTranscriptLine(
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '  hello   wave  ' }] } }),
    );
    expect(parsed.kind).toBe('message');
    if (parsed.kind !== 'message') return;
    expect(parsed.role).toBe('user');
    expect(parsed.summary).toBe('hello wave');
    expect(parsed.isDone).toBe(false);
  });

  it('summarizes tool_use lines as tool·name (feed-safe)', () => {
    const parsed = parseTranscriptLine(
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }] },
      }),
    );
    expect(parsed.kind).toBe('message');
    if (parsed.kind !== 'message') return;
    expect(parsed.summary).toContain('tool·Shell');
  });

  it('maps turn_ended to a turn boundary (never a log)', () => {
    const parsed = parseTranscriptLine(JSON.stringify({ type: 'turn_ended', status: 'success' }));
    expect(parsed).toEqual({ kind: 'turn_ended', status: 'success' });
  });

  it('tolerates malformed JSON (skip + count, never throw)', () => {
    const parsed = parseTranscriptLine('not-json-at-all {{{');
    expect(parsed.kind).toBe('malformed');
  });

  it('tolerates valid JSON with the wrong shape (never throw)', () => {
    for (const raw of [
      '[]',
      '42',
      '"str"',
      '{"role":"assistant"}',
      '{"role":"x","message":null}',
      '{"role":"assistant","message":{}}',
      '{"role":"assistant","message":{"content":"not-an-array"}}',
      '{"role":"assistant","message":{"weird":"shape without content array"}}',
    ]) {
      expect(parseTranscriptLine(raw).kind).toBe('malformed');
    }
  });

  it('treats blank lines as empty (caller skips silently)', () => {
    expect(parseTranscriptLine('   ').kind).toBe('empty');
    expect(parseTranscriptLine('').kind).toBe('empty');
  });

  it('detects Done VALIDATION bodies for the T3 milestone', () => {
    expect(isDoneBody('Done:\n\nVALIDATION\n- tests: x')).toBe(true);
    expect(isDoneBody('just chatting')).toBe(false);
    const parsed = parseTranscriptLine(
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'Done stuff\nVALIDATION\n- tests: ok' }] },
      }),
    );
    expect(parsed.kind).toBe('message');
    if (parsed.kind !== 'message') return;
    expect(parsed.isDone).toBe(true);
    expect(parsed.body).toContain('VALIDATION');
  });
});

describe('summaries', () => {
  it('clips to one line within the cap', () => {
    const long = `a${'  \n '.repeat(50)}b${'x'.repeat(500)}`;
    const clipped = clipSummary(long);
    expect(clipped.length).toBeLessThanOrEqual(280);
    expect(clipped).not.toContain('\n');
  });

  it('summarizeContent tolerates non-arrays', () => {
    const { summary } = summarizeContent(undefined);
    expect(typeof summary).toBe('string');
  });
});

describe('frame builders used by the tailer', () => {
  it('buildMessageLog emits ONLY the log event path', () => {
    const frame = buildMessageLog({
      frameId: 'WAVE-TEST-1',
      sessionKey: 'WAVE-TEST',
      agentFile: 'a.jsonl',
      role: 'assistant',
      summary: 'hi',
    });
    expect(frame).toMatchObject({ type: 'event', event: 'log', id: 'WAVE-TEST-1' });
    expect(frame.payload.message).toContain('[assistant]');
  });

  it('buildTurnEndedStatus emits ONLY the agent.status event path', () => {
    const frame = buildTurnEndedStatus({ frameId: 'WAVE-TEST-2', agentId: 'WAVE-TEST:a.jsonl', turnStatus: 'success' });
    expect(frame).toMatchObject({ type: 'event', event: 'agent.status', id: 'WAVE-TEST-2' });
    expect(frame.payload.status).toBe('turn_success');
  });

  it('buildDroppedLinesLog surfaces the skip counter', () => {
    const frame = buildDroppedLinesLog({ frameId: 'WAVE-TEST-9', sessionKey: 'WAVE-TEST', droppedLines: 3 });
    expect(frame).toMatchObject({ type: 'event', event: 'log' });
    expect(frame.payload.message).toContain('3 malformed');
  });
});
