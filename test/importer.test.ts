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
    expect(byBank[OTHER].error).toMatch(/no account named "Opsparing"/);
    expect(byBank['99990000111122'].error).toMatch(/No mapping/);
  });

  it('refuses a closed Actual account', async () => {
    const batch = parseBecCsv(file(HEADER, ROW1));
    const report = await runBatch(fakeApi(), batch, { [ACCOUNT]: 'Gammel' }, true);
    expect(report.accounts[0].error).toMatch(/closed/);
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
