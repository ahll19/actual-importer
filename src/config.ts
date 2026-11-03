// Reads configuration from environment variables.

import path from 'node:path';
import type { ActualConfig } from './actual.js';

export interface Config {
  port: number;
  accountsFile: string;
  /** Create Actual accounts named in accounts.json that don't exist yet. Off by default. */
  createMissingAccounts: boolean;
  actual: ActualConfig;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

export function loadConfig(): Config {
  const dataDir = process.env.ACTUAL_DATA_DIR || '/data/actual-cache';
  return {
    port: Number(process.env.PORT || 3000),
    // Next to the Actual cache on the persistent volume unless overridden.
    accountsFile: process.env.ACCOUNTS_FILE || path.join(path.dirname(dataDir), 'accounts.json'),
    createMissingAccounts: process.env.CREATE_MISSING_ACCOUNTS === 'true',
    actual: {
      serverURL: required('ACTUAL_SERVER_URL'),
      password: required('ACTUAL_PASSWORD'),
      syncId: required('ACTUAL_SYNC_ID'),
      e2ePassword: process.env.ACTUAL_E2E_PASSWORD || undefined,
      dataDir,
    },
  };
}
