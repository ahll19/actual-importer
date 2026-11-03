import { describe, expect, it, vi } from 'vitest';
import { BatchStore } from '../src/batches.js';
import { runBatch, type ActualApi } from '../src/importer.js';
import { importedId } from '../src/mapping.js';
import { parseBecCsv } from '../src/parser.js';
import { file, HEADER, ROW1, ROW2, ROW3 } from './helpers.js';

const ACCOUNT = '11112222333344';
const OTHER = '55556666777788';

/** A fake Actual that already "has" the given imported_ids. */
function fakeApi(existing: string[] = []) {
  const known = new Set(existing);
  const api: ActualApi = {
    getAccounts: async () => [
      { id: 'acc-budget', name: 'Budgetkonto' },
      { id: 'acc-closed', name: 'Gammel', closed: true },
    ],
    importTransactions: vi.fn<ActualApi['importTransactions']>(async (_id, txs) => {
      const matched = txs.filter((t) => known.has(t.imported_id));
      return {
        added: txs.filter((t) => !known.has(t.imported_id)).map((_, i) => `new-${i}`),
        updated: [],
        updatedPreview: matched.map((t) => ({ transaction: t, ignored: true })),
        errors: [],
      };
    }),
    createAccount: vi.fn<ActualApi['createAccount']>(async () => 'acc-new'),
    // A brand-new account only holds its starting balance transaction.
    getTransactions: vi.fn<ActualApi['getTransactions']>(async () => [{ id: 'start-tx' }]),
    updateTransaction: vi.fn<ActualApi['updateTransaction']>(async () => undefined),
  };
  return api;
}

describe('runBatch', () => {
  it('reports added and already-imported rows per account', async () => {
    const batch = parseBecCsv(file(HEADER, ROW1, ROW2, ROW3));
    const alreadyThere = importedId(batch.accounts.get(ACCOUNT)![0]);
    const api = fakeApi([alreadyThere]);

    const report = await runBatch(api, batch, { [ACCOUNT]: 'Budgetkonto' }, true);

    expect(report.accounts).toHaveLength(1);
    const a = report.accounts[0];
    expect(a).toMatchObject({
      actualAccount: 'Budgetkonto',
      error: null,
      rowCount: 3,
      dateFrom: '2026-08-03',
      dateTo: '2026-08-03',
      added: 2,
      updated: 0,
      alreadyImported: 1,
    });
    expect(a.rowsToAdd.map((r) => r.payee)).toEqual(['EKSEMPEL', 'Til Ønskeopsparing p']);
    expect(api.importTransactions).toHaveBeenCalledWith('acc-budget', expect.any(Array), {
      dryRun: true,
      payeeNameNormalization: 'original',
      reimportDeleted: false,
    });
  });

  it('fails only the account that has no mapping or no Actual account', async () => {
    const other = '"55556666777788";"";"";04-08-2026;"Rente";1.00;500.00;"";"";"";';
    const third = '"99990000111122";"";"";04-08-2026;"X";1.00;1.00;"";"";"";';
    const batch = parseBecCsv(file(HEADER, ROW1, other, third));
    const report = await runBatch(fakeApi(), batch, { [ACCOUNT]: 'Budgetkonto', [OTHER]: 'Opsparing' }, true);

    const byBank = Object.fromEntries(report.accounts.map((a) => [a.bankAccount, a]));
    expect(byBank[ACCOUNT].error).toBeNull();
    expect(byBank[ACCOUNT].added).toBe(1);
    expect(byBank[OTHER].error).toMatch(/ingen konto med navnet "Opsparing"/);
    expect(byBank['99990000111122'].error).toMatch(/ikke knyttet/);
  });

  it('refuses a closed Actual account', async () => {
    const batch = parseBecCsv(file(HEADER, ROW1));
    const report = await runBatch(fakeApi(), batch, { [ACCOUNT]: 'Gammel' }, true);
    expect(report.accounts[0].error).toMatch(/lukket/);
  });

  it('previews a missing account as new when account creation is on', async () => {
    const batch = parseBecCsv(file(HEADER, ROW1, ROW2, ROW3));
    const api = fakeApi();
    const report = await runBatch(api, batch, { [ACCOUNT]: 'Ny konto' }, true, { createMissingAccounts: true });

    const a = report.accounts[0];
    expect(a.error).toBeNull();
    expect(a.added).toBe(3);
    expect(a.rowsToAdd).toHaveLength(3);
    // ROW1 is the oldest: balance 13230.96 after -29.00.
    expect(a.newAccount).toEqual({ startingBalance: 1325996, startingDate: '2026-08-03' });
    expect(api.createAccount).not.toHaveBeenCalled();
    expect(api.importTransactions).not.toHaveBeenCalled();
  });

  it('creates a missing account on import, then imports into it', async () => {
    const batch = parseBecCsv(file(HEADER, ROW1, ROW2, ROW3));
    const api = fakeApi();
    const report = await runBatch(api, batch, { [ACCOUNT]: 'Ny konto' }, false, { createMissingAccounts: true });

    expect(report.accounts[0].error).toBeNull();
    expect(report.accounts[0].added).toBe(3);
    expect(api.createAccount).toHaveBeenCalledWith({ name: 'Ny konto', offbudget: false }, 1325996);
    // Actual dates the starting balance today; it is moved to the oldest row's date.
    expect(api.updateTransaction).toHaveBeenCalledWith('start-tx', { date: '2026-08-03' });
    expect(api.importTransactions).toHaveBeenCalledWith('acc-new', expect.any(Array), expect.objectContaining({ dryRun: false }));
  });

  it('takes the starting balance from the oldest row in a newest-first export', async () => {
    const newer = '"11112222333344";"";"";05-08-2026;"Nyere";-10.00;90.00;"";"";"";';
    const older = '"11112222333344";"";"";04-08-2026;"Ældre";50.00;100.00;"";"";"";';
    const batch = parseBecCsv(file(HEADER, newer, older));
    const report = await runBatch(fakeApi(), batch, { [ACCOUNT]: 'Ny konto' }, true, { createMissingAccounts: true });
    // Balance before the older row: 100.00 - 50.00.
    expect(report.accounts[0].newAccount).toEqual({ startingBalance: 5000, startingDate: '2026-08-04' });
  });

  it('puts rejects under their account, or in the unassigned list', async () => {
    const badDate = ROW2.replace('03-08-2026', '99-99-2026');
    const badSplit = ROW3.replace('Til Ønskeopsparing p', 'Til;Ønske');
    const batch = parseBecCsv(file(HEADER, ROW1, badDate, badSplit));
    const report = await runBatch(fakeApi(), batch, { [ACCOUNT]: 'Budgetkonto' }, true);
    expect(report.accounts[0].rejects.map((r) => r.lineNo)).toEqual([3]);
    expect(report.unassignedRejects.map((r) => r.lineNo)).toEqual([4]);
  });
});

describe('BatchStore', () => {
  it('expires batches after the TTL', () => {
    let now = 0;
    const store = new BatchStore<string>(15 * 60 * 1000, () => now);
    const token = store.put('batch');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    now = 14 * 60 * 1000;
    expect(store.get(token)).toBe('batch');
    now = 15 * 60 * 1000;
    expect(store.get(token)).toBeUndefined();
  });
});
