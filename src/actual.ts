// Connection to the Actual server via @actual-app/api.
//
// The API is a process-wide singleton (one open budget per process), so every
// operation goes through a mutex: two uploads at the same time queue up
// instead of interleaving.

import { mkdir } from 'node:fs/promises';
import * as api from '@actual-app/api';
import type { ActualApi } from './importer.js';

export interface ActualConfig {
  serverURL: string;
  password: string;
  syncId: string;
  e2ePassword?: string;
  dataDir: string;
}

/** Runs async functions one at a time, in the order they were queued. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain going even if `fn` fails.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class ActualClient {
  private mutex = new Mutex();
  private connected = false;
  /** Did the most recent attempt to talk to Actual succeed? Used by /healthz. */
  lastConnectionOk = false;

  constructor(private config: ActualConfig) {}

  /**
   * Bring the local budget copy up to date, then run `fn` with the API.
   * Pass `syncAfter` for real imports so the changes are pushed to the server.
   */
  withBudget<T>(fn: (api: ActualApi) => Promise<T>, { syncAfter = false } = {}): Promise<T> {
    return this.mutex.run(async () => {
      await this.refresh();
      try {
        const result = await fn(api as unknown as ActualApi);
        if (syncAfter) await api.sync();
        return result;
      } catch (err) {
        this.lastConnectionOk = false;
        throw err;
      }
    });
  }

  /** Connect at startup so /healthz is meaningful. Failure is logged, not fatal. */
  connect(): Promise<void> {
    return this.mutex.run(() => this.refresh());
  }

  shutdown(): Promise<void> {
    return this.mutex.run(async () => {
      if (this.connected) await api.shutdown();
      this.connected = false;
    });
  }

  /**
   * First call: init + downloadBudget. Later calls: sync, so we never preview
   * against a stale cache. If sync fails (server restarted, session expired)
   * we tear down and download again once before giving up.
   */
  private async refresh(): Promise<void> {
    try {
      if (this.connected) {
        try {
          await api.sync();
          this.lastConnectionOk = true;
          return;
        } catch {
          await this.disconnect();
        }
      }
      await this.open();
      this.lastConnectionOk = true;
    } catch (err) {
      this.lastConnectionOk = false;
      await this.disconnect();
      throw new Error(`Could not connect to Actual at ${this.config.serverURL}: ${(err as Error).message}`);
    }
  }

  private async open(): Promise<void> {
    const { serverURL, password, syncId, e2ePassword, dataDir } = this.config;
    await mkdir(dataDir, { recursive: true }); // init() requires it to exist
    // verbose: false is required: in verbose mode the API prints every
    // imported transaction (payee, amount, notes) to the console.
    await api.init({ serverURL, password, dataDir, verbose: false });
    this.connected = true;
    // E2E encryption is off today; the password is passed through only if set.
    await api.downloadBudget(syncId, e2ePassword ? { password: e2ePassword } : undefined);
  }

  private async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await api.shutdown();
    } catch {
      // Already broken; nothing more to do.
    }
  }
}
