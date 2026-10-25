// Turns parsed bank rows into Actual transactions.

import { createHash } from 'node:crypto';
import type { ParsedRow } from './parser.js';

/** The fields we send to Actual's importTransactions(). */
export interface ActualTransaction {
  date: string;
  amount: number;
  payee_name: string;
  imported_payee: string;
  /** Left out when empty: Actual treats "" and null as different, so "" would
   * make every re-import of the row count as an update. */
  notes?: string;
  imported_id: string;
  cleared: boolean;
}

/**
 * The export has no transaction ID, so we derive a stable one.
 *
 * This ID is what makes re-uploading an overlapping export safe: Actual skips
 * any transaction whose imported_id it already has. The running balance is part
 * of the hash so that two identical purchases on the same day (same text, same
 * amount) still get different IDs, while the same row exported again later
 * produces exactly the same ID.
 *
 * Do not change this formula: every previously imported row would then look new.
 */
export function importedId(row: ParsedRow): string {
  const key = [row.account, row.date, row.amount, row.balance, row.text].join('|');
  return 'bec-' + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
}

export function buildNotes(row: ParsedRow): string {
  return [row.counterparty, row.message, row.extra].filter((s) => s !== '').join(' | ');
}

export function toActualTransaction(row: ParsedRow): ActualTransaction {
  return {
    date: row.date,
    amount: row.amount, // already integer øre, which is Actual's amount format
    payee_name: row.text,
    imported_payee: row.text,
    notes: buildNotes(row) || undefined,
    imported_id: importedId(row),
    cleared: true,
  };
}
