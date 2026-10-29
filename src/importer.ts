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
  createAccount(account: { name: string; offbudget: boolean }, initialBalance: number): Promise<string>;
  getTransactions(accountId: string, startDate: string, endDate: string): Promise<Array<{ id: string }>>;
  updateTransaction(id: string, fields: { date: string }): Promise<unknown>;
}

export interface RunOptions {
  /** Create Actual accounts that accounts.json names but Actual doesn't have. */
  createMissingAccounts?: boolean;
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
  /**
   * Set when the Actual account doesn't exist and will be (preview) or was
   * (import) created. Shown on the page, never logged.
   */
  newAccount: { startingBalance: number; startingDate: string } | null;
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
  { createMissingAccounts = false }: RunOptions = {},
): Promise<BatchReport> {
  const actualAccounts = await api.getAccounts();
  const reports: AccountReport[] = [];

  for (const [bankAccount, rows] of batch.accounts) {
    const report = emptyReport(bankAccount, rows, batch);
    reports.push(report);

    const name = accountMap[bankAccount];
    if (name === undefined) {
      report.error = `Bankkonto ${bankAccount} er ikke knyttet til en Actual-konto i accounts.json.`;
      continue;
    }
    report.actualAccount = name;
    const target = actualAccounts.find((a) => a.name === name);
    if (!target && createMissingAccounts) {
      report.newAccount = startingBalance(rows);
      if (dryRun) {
        // Nothing to compare against yet: every row is new.
        report.added = rows.length;
        report.rowsToAdd = rows.map((row) => {
          const t = toActualTransaction(row);
          return { date: t.date, payee: t.payee_name, amount: t.amount, notes: t.notes ?? '' };
        });
        continue;
      }
      try {
        const id = await createAccount(api, name, report.newAccount);
        await importRows(api, id, rows, false, report);
      } catch (err) {
        report.error = `Kunne ikke oprette Actual-kontoen "${name}": ${(err as Error).message}`;
      }
      continue;
    }
    if (!target) {
      report.error = `Actual har ingen konto med navnet "${name}".`;
      continue;
    }
    if (target.closed) {
      report.error = `Actual-kontoen "${name}" er lukket.`;
      continue;
    }

    try {
      await importRows(api, target.id, rows, dryRun, report);
    } catch (err) {
      report.error = `Actual afviste importen: ${(err as Error).message}`;
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

async function importRows(api: ActualApi, accountId: string, rows: ParsedRow[], dryRun: boolean, report: AccountReport) {
  const transactions = rows.map((row) => ({ ...toActualTransaction(row), account: accountId }));
  const result = await api.importTransactions(accountId, transactions, { dryRun, ...IMPORT_OPTS });
  report.added = result.added.length;
  report.updated = result.updated.length;
  report.alreadyImported = rows.length - report.added - report.updated;
  report.errors = (result.errors ?? []).map((e) => e.message);
  report.rowsToAdd = rowsToAdd(transactions, result);
}

/**
 * The balance before the oldest row of the export, so the new account ends up
 * with the same balance as the bank. Rows are expected oldest first (the
 * running-balance check relies on that too), but if the last row has the
 * earlier date the file is newest first, so use that end instead.
 */
function startingBalance(rows: ParsedRow[]): { startingBalance: number; startingDate: string } {
  const last = rows[rows.length - 1];
  const oldest = last.date < rows[0].date ? last : rows[0];
  return { startingBalance: oldest.balance - oldest.amount, startingDate: oldest.date };
}

/**
 * Creates an on-budget account with a starting balance. Actual dates the
 * starting balance transaction today, which would put it after the imported
 * rows, so it is moved to the date of the oldest row. A brand-new account has
 * no other transactions, so everything found is the starting balance.
 */
async function createAccount(api: ActualApi, name: string, start: { startingBalance: number; startingDate: string }) {
  const id = await api.createAccount({ name, offbudget: false }, start.startingBalance);
  for (const t of await api.getTransactions(id, '1900-01-01', '2999-12-31')) {
    await api.updateTransaction(t.id, { date: start.startingDate });
  }
  return id;
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
    newAccount: null,
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
