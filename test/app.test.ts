import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BudgetRunner } from '../src/app.js';
import type { ActualApi } from '../src/importer.js';
import { file, HEADER, ROW1, ROW2 } from './helpers.js';

function multipart(filename: string, content: Buffer) {
  const boundary = '----test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('HTTP routes', () => {
  let app: FastifyInstance;
  let imported: Set<string>;
  let runner: BudgetRunner;

  beforeEach(async () => {
    imported = new Set();
    const api: ActualApi = {
      getAccounts: async () => [{ id: 'acc-1', name: 'Budgetkonto' }],
      importTransactions: async (_id, txs, opts) => {
        const fresh = txs.filter((t) => !imported.has(t.imported_id));
        if (!opts.dryRun) fresh.forEach((t) => imported.add(t.imported_id));
        return {
          added: fresh.map((t) => t.imported_id),
          updated: [],
          updatedPreview: txs.filter((t) => !fresh.includes(t)).map((t) => ({ transaction: t })),
          errors: [],
        };
      },
      createAccount: async () => 'acc-new',
      getTransactions: async () => [],
      updateTransaction: async () => undefined,
    };
    runner = {
      lastConnectionOk: true,
      withBudget: vi.fn(async (fn) => fn(api)),
    };
    const dir = await mkdtemp(path.join(tmpdir(), 'importer-test-'));
    const accountsFile = path.join(dir, 'accounts.json');
    await writeFile(accountsFile, JSON.stringify({ '11112222333344': 'Budgetkonto' }));
    app = await buildApp({ actual: runner, accountsFile, logger: false });
  });

  afterEach(() => app.close());

  it('previews, imports, and then shows everything as already imported', async () => {
    const upload = multipart('export.csv', file(HEADER, ROW1, ROW2));

    const preview = await app.inject({ method: 'POST', url: '/preview', ...upload });
    expect(preview.statusCode).toBe(200);
    const p = preview.json();
    expect(p.accounts[0]).toMatchObject({ actualAccount: 'Budgetkonto', added: 2, alreadyImported: 0 });
    expect(imported.size).toBe(0); // dry run wrote nothing

    const result = await app.inject({ method: 'POST', url: '/import', payload: { token: p.token } });
    expect(result.statusCode).toBe(200);
    expect(result.json().accounts[0]).toMatchObject({ added: 2 });
    expect(runner.withBudget).toHaveBeenLastCalledWith(expect.any(Function), { syncAfter: true });

    // Token is single-use.
    const again = await app.inject({ method: 'POST', url: '/import', payload: { token: p.token } });
    expect(again.statusCode).toBe(410);

    const second = await app.inject({ method: 'POST', url: '/preview', ...upload });
    expect(second.json().accounts[0]).toMatchObject({ added: 0, alreadyImported: 2 });
  });

  it('rejects non-CSV uploads and broken headers', async () => {
    const txt = await app.inject({ method: 'POST', url: '/preview', ...multipart('export.txt', file(ROW1)) });
    expect(txt.statusCode).toBe(400);

    const bad = await app.inject({
      method: 'POST',
      url: '/preview',
      ...multipart('export.csv', file(HEADER.replace('"Saldo"', '"Foo"'), ROW1)),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/"Foo"/);
  });

  it('rejects uploads over 5 MB', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0x41);
    const res = await app.inject({ method: 'POST', url: '/preview', ...multipart('big.csv', big) });
    expect(res.statusCode).toBe(413);
  });

  it('serves the page and the health check', async () => {
    expect((await app.inject('/')).headers['content-type']).toMatch(/text\/html/);
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    runner.lastConnectionOk = false;
    expect((await app.inject('/healthz')).statusCode).toBe(503);
  });
});
