// Runs a parsed batch against Actual, either as a dry run (preview) or for real.
//
// Takes a small `ActualApi` interface instead of importing @actual-app/api
// directly, so tests can pass in a fake.

import type { AccountMap } from './accounts.js';
import { toActualTransaction } from './mapping.js';
import type { BalanceWarning, ParseResult, ParsedRow, RejectedLine } from './parser.js';

export interface ActualAccount {
  id: string;
  name: string;
  closed?: boolean;
}

export interface ImportResult {
  added: string[];
  updated: string[];
  updatedPreview?: Array<{ transaction: { imported_id?: string | null } }>;
  errors?: Array<{ message: string }>;
}

export interface ActualApi {
  getAccounts(): Promise<ActualAccount[]>;
  importTransactions(
    accountId: string,
    transactions: Array<ReturnType<typeof toActualTransaction> & { account: string }>,
    opts: { dryRun: boolean; payeeNameNormalization: 'original'; reimportDeleted: boolean },
  ): Promise<ImportResult>;
}

export interface PreviewRow {
  date: string;
  payee: string;
  amount: number;
  notes: string;
}

export interface AccountReport {
  /** Bank account number (Exportkonto). Shown on the page, never logged. */
  bankAccount: string;
  actualAccount: string | null;
  /** Set when this account could not be processed (no mapping, unknown name, Actual error). */
  error: string | null;
  rowCount: number;
  dateFrom: string;
  dateTo: string;
  added: number;
  updated: number;
  alreadyImported: number;
  errors: string[];
  warnings: BalanceWarning[];
  rejects: RejectedLine[];
  /** Rows that would be / were added. */
  rowsToAdd: PreviewRow[];
}

export interface BatchReport {
  accounts: AccountReport[];
  /** Rejected lines we could not attribute to an account. */
  unassignedRejects: RejectedLine[];
}

const IMPORT_OPTS = {
  // The default ('title-case') rewrites payee names, which would break rules
  // written against the bank's exact text.
  payeeNameNormalization: 'original',
  // Same as Actual's own CSV importer: a transaction deleted in Actual stays deleted.
  reimportDeleted: false,
} as const;

export async function runBatch(
  api: ActualApi,
  batch: ParseResult,
  accountMap: AccountMap,
  dryRun: boolean,
): Promise<BatchReport> {
  const actualAccounts = await api.getAccounts();
  const reports: AccountReport[] = [];

  for (const [bankAccount, rows] of batch.accounts) {
    const report = emptyReport(bankAccount, rows, batch);
    reports.push(report);

    const name = accountMap[bankAccount];
    if (name === undefined) {
      report.error = `No mapping for bank account ${bankAccount} in accounts.json.`;
      continue;
    }
    report.actualAccount = name;
    const target = actualAccounts.find((a) => a.name === name);
    if (!target) {
      report.error = `Actual has no account named "${name}".`;
      continue;
    }
    if (target.closed) {
      report.error = `Actual account "${name}" is closed.`;
      continue;
    }

    const transactions = rows.map((row) => ({ ...toActualTransaction(row), account: target.id }));
    try {
      const result = await api.importTransactions(target.id, transactions, { dryRun, ...IMPORT_OPTS });
      report.added = result.added.length;
      report.updated = result.updated.length;
      report.alreadyImported = rows.length - report.added - report.updated;
      report.errors = (result.errors ?? []).map((e) => e.message);
      report.rowsToAdd = rowsToAdd(transactions, result);
    } catch (err) {
      report.error = `Actual rejected the import: ${(err as Error).message}`;
    }
  }

  // Rejects whose account is known but has no valid rows still get a section.
  for (const reject of batch.rejects) {
    if (reject.account && !batch.accounts.has(reject.account) && !reports.some((r) => r.bankAccount === reject.account)) {
      const report = emptyReport(reject.account, [], batch);
      report.actualAccount = accountMap[reject.account] ?? null;
      reports.push(report);
    }
  }

  return { accounts: reports, unassignedRejects: batch.rejects.filter((r) => !r.account) };
}

function emptyReport(bankAccount: string, rows: ParsedRow[], batch: ParseResult): AccountReport {
  const dates = rows.map((r) => r.date).sort();
  return {
    bankAccount,
    actualAccount: null,
    error: null,
    rowCount: rows.length,
    dateFrom: dates[0] ?? '',
    dateTo: dates[dates.length - 1] ?? '',
    added: 0,
    updated: 0,
    alreadyImported: 0,
    errors: [],
    warnings: batch.warnings.filter((w) => w.account === bankAccount),
    rejects: batch.rejects.filter((r) => r.account === bankAccount),
    rowsToAdd: [],
  };
}

/**
 * Which rows end up as new transactions. Actual's result only gives the IDs of
 * new transactions (random ones in a dry run), but `updatedPreview` lists every
 * incoming transaction that matched an existing one. Everything else is added.
 */
function rowsToAdd(
  transactions: Array<{ date: string; payee_name: string; amount: number; notes?: string; imported_id: string }>,
  result: ImportResult,
): PreviewRow[] {
  const matched = new Set((result.updatedPreview ?? []).map((p) => p.transaction.imported_id));
  return transactions
    .filter((t) => !matched.has(t.imported_id))
    .map((t) => ({ date: t.date, payee: t.payee_name, amount: t.amount, notes: t.notes ?? '' }));
}
