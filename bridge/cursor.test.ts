import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CursorStore } from './cursor';

let dir: string;
let cursorPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cursor-'));
  cursorPath = path.join(dir, 'cursor.json');
});

describe('CursorStore', () => {
  it('starts empty when the file is missing', () => {
    const store = CursorStore.load(cursorPath);
    expect(store.getCursor('WAVE-X')).toBeUndefined();
    expect(store.lastSeq('WAVE-X')).toBe(0);
  });

  it('round-trips offsets through disk (offset-resume: no re-emit)', () => {
    const store = CursorStore.load(cursorPath);
    store.setCursor('WAVE-X', { file: 'subagents/a.jsonl', offset: 5, lastEventId: 'WAVE-X-5' });

    // Simulate a restart: reload from disk, tailer resumes AT offset 5.
    const resumed = CursorStore.load(cursorPath);
    const cursor = resumed.getCursor('WAVE-X');
    expect(cursor).toEqual({ file: 'subagents/a.jsonl', offset: 5, lastEventId: 'WAVE-X-5' });

    // Lines 0..4 are behind the cursor → nothing re-emitted.
    const lines = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5-new', 'l6-new'];
    const pending = lines.slice(cursor!.offset);
    expect(pending).toEqual(['l5-new', 'l6-new']);
  });

  it('issues stable monotonic frame ids <waveKey>-<seq> across restarts', () => {
    const store = CursorStore.load(cursorPath);
    expect(store.nextFrameId('WAVE-20261018-1009')).toBe('WAVE-20261018-1009-1');
    expect(store.nextFrameId('WAVE-20261018-1009')).toBe('WAVE-20261018-1009-2');

    const resumed = CursorStore.load(cursorPath);
    expect(resumed.nextFrameId('WAVE-20261018-1009')).toBe('WAVE-20261018-1009-3');
  });

  it('tracks sequences per wave key independently', () => {
    const store = CursorStore.load(cursorPath);
    expect(store.nextFrameId('WAVE-A')).toBe('WAVE-A-1');
    expect(store.nextFrameId('WAVE-B')).toBe('WAVE-B-1');
    expect(store.nextFrameId('WAVE-A')).toBe('WAVE-A-2');
  });
});
