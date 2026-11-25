import { CodexError } from '../agents/rpc.js';
import { randomUUID } from 'node:crypto';

// Shared by planning, implementation and validation: two workers globally.
export class RunPool {
  readonly ownerId = randomUUID();
  private active = 0;
  private queue: { start: () => void; signal: AbortSignal; priority: number; queuedAt: number }[] = [];
  constructor(private limit = 2) {}
  acquire(signal: AbortSignal, priority = 'normal', queuedAt = Date.now()): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => { this.queue = this.queue.filter(entry => entry !== entryForRun); reject(new CodexError('CANCELLED', 'Queued work was stopped.')); };
      const entryForRun = { signal, priority: priority === 'high' ? 2 : priority === 'low' ? 0 : 1, queuedAt, start: () => {
        signal.removeEventListener('abort', abort);
        this.active++; let released = false;
        resolve(() => { if (released) return; released = true; this.active--; this.pump(); });
      } };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.queue.push(entryForRun); this.pump();
    });
  }
  private pump() {
    const now = Date.now();
    // FIFO within priority, with one aging point per 30 seconds to prevent a
    // continuous stream of new high-priority work starving older requests.
    const rank = (entry: typeof this.queue[number]) => entry.priority + Math.floor(Math.max(0, now - entry.queuedAt) / 30000);
    this.queue.sort((a, b) => rank(b) - rank(a) || a.queuedAt - b.queuedAt);
    while (this.active < this.limit && this.queue.length) { const next = this.queue.shift()!; if (!next.signal.aborted) next.start(); }
  }
}
