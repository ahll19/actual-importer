// Keeps parsed uploads in memory between "preview" and "import", so the import
// uses exactly the batch the user looked at and never re-parses the file.

import { randomBytes } from 'node:crypto';

export const BATCH_TTL_MS = 15 * 60 * 1000;

export class BatchStore<T> {
  private batches = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private ttlMs = BATCH_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  put(value: T): string {
    this.sweep();
    const token = randomBytes(16).toString('hex');
    this.batches.set(token, { value, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  get(token: string): T | undefined {
    this.sweep();
    return this.batches.get(token)?.value;
  }

  delete(token: string): void {
    this.batches.delete(token);
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.batches) {
      if (entry.expiresAt <= now) this.batches.delete(token);
    }
  }
}
