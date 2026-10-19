/**
 * `cursor.json` offset store (gitignored, local-only).
 *
 * Shape: { cursors: { [sessionKey]: { file, offset, lastEventId } },
 *           seq: { [waveKey]: number } }
 *
 * Offsets let the T2 tailer resume without re-emitting; `seq` backs stable
 * frame ids `<waveKey>-<seq>` so a bridge restart duplicates nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { frameId } from './frames';

export interface SessionCursor {
  file: string;
  offset: number;
  lastEventId: string;
}

interface CursorFile {
  cursors: Record<string, SessionCursor>;
  seq: Record<string, number>;
}

const EMPTY: CursorFile = { cursors: {}, seq: {} };

export class CursorStore {
  private constructor(
    private readonly filePath: string,
    private data: CursorFile,
  ) {}

  static load(filePath: string): CursorStore {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CursorFile>;
      return new CursorStore(filePath, {
        cursors: parsed.cursors ?? {},
        seq: parsed.seq ?? {},
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new CursorStore(filePath, structuredClone(EMPTY));
      }
      throw new Error(`cursor store unreadable at ${filePath}: ${(err as Error).message}`);
    }
  }

  getCursor(sessionKey: string): SessionCursor | undefined {
    return this.data.cursors[sessionKey];
  }

  setCursor(sessionKey: string, cursor: SessionCursor): void {
    this.data.cursors[sessionKey] = cursor;
    this.save();
  }

  /** Monotonic per-wave sequence → stable frame id `<waveKey>-<seq>`. */
  nextFrameId(waveKey: string): string {
    const next = (this.data.seq[waveKey] ?? 0) + 1;
    this.data.seq[waveKey] = next;
    this.save();
    return frameId(waveKey, next);
  }

  lastSeq(waveKey: string): number {
    return this.data.seq[waveKey] ?? 0;
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
