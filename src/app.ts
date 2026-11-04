// HTTP routes.
//
// Fastify rather than Express: it has upload size limits, JSON body parsing and
// a structured logger built in, so there is less glue code to maintain.

import { readFileSync } from 'node:fs';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { loadAccountMap } from './accounts.js';
import { BatchStore } from './batches.js';
import { runBatch, type ActualApi, type BatchReport } from './importer.js';
import { parseBecCsv, UploadError, type ParseResult } from './parser.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** What the routes need from the Actual connection (ActualClient, or a fake in tests). */
export interface BudgetRunner {
  withBudget<T>(fn: (api: ActualApi) => Promise<T>, opts?: { syncAfter?: boolean }): Promise<T>;
  lastConnectionOk: boolean;
}

export interface AppOptions {
  actual: BudgetRunner;
  accountsFile: string;
  createMissingAccounts?: boolean;
  store?: BatchStore<Batch>;
  logger?: boolean;
}

/**
 * Turns off Fastify's "incoming request" / "request completed" lines: we write
 * one summary line per preview/import instead, and must never log transaction
 * text, amounts or account numbers. Unexpected errors are still logged.
 */
class QuietRequests extends LogController {
  override incomingRequest(): void {}
  override requestCompleted(...args: Parameters<LogController['requestCompleted']>): void {
    if (args[0]) super.requestCompleted(...args);
  }
}

interface Batch {
  filename: string;
  parsed: ParseResult;
}

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url));

// Log time as readable Copenhagen local time instead of pino's default epoch
// milliseconds. The time zone is set here, not via TZ, so the container needs
// no time zone setup. 'sv-SE' gives the ISO-like "2026-10-29 14:03:12".
const copenhagenTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Copenhagen',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const copenhagenTimestamp = () => `,"time":"${copenhagenTime.format(new Date())}"`;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { actual, accountsFile } = opts;
  const runOpts = { createMissingAccounts: opts.createMissingAccounts ?? false };
  const store = opts.store ?? new BatchStore<Batch>();

  const logger = opts.logger === false ? false : { timestamp: copenhagenTimestamp };
  const app = Fastify({ logger, logController: new QuietRequests() });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));

  app.get('/healthz', async (_req, reply) =>
    actual.lastConnectionOk ? { ok: true } : reply.code(503).send({ ok: false }),
  );

  app.post('/preview', async (req, reply) => {
    const started = Date.now();
    let file;
    try {
      file = await req.file();
    } catch {
      return reply.code(400).send({ error: 'Forventede en fil-upload.' });
    }
    if (!file) return reply.code(400).send({ error: 'Der blev ikke uploadet nogen fil.' });
    if (!file.filename.toLowerCase().endsWith('.csv')) {
      return reply.code(400).send({ error: 'Kun .csv-filer kan bruges.' });
    }

    let bytes: Buffer;
    try {
      bytes = await file.toBuffer();
    } catch (err) {
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send({ error: 'Filen er større end 5 MB.' });
      }
      throw err;
    }

    let parsed: ParseResult;
    try {
      parsed = parseBecCsv(bytes);
    } catch (err) {
      if (err instanceof UploadError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    let report: BatchReport;
    try {
      const accountMap = await loadAccountMap(accountsFile);
      report = await actual.withBudget((api) => runBatch(api, parsed, accountMap, true, runOpts));
    } catch (err) {
      req.log.error(`preview failed: ${(err as Error).message}`);
      return reply.code(502).send({ error: (err as Error).message });
    }

    const token = store.put({ filename: file.filename, parsed });
    req.log.info(`preview: ${summary(report)}, ${Date.now() - started} ms`);
    return { token, filename: file.filename, ...report };
  });

  app.post<{ Body: { token?: unknown } }>('/import', async (req, reply) => {
    const started = Date.now();
    const token = req.body?.token;
    const batch = typeof token === 'string' ? store.get(token) : undefined;
    if (!batch) {
      return reply.code(410).send({ error: 'Forhåndsvisningen er udløbet (efter 15 minutter) eller allerede importeret. Upload filen igen.' });
    }

    let report: BatchReport;
    try {
      // Same parsed batch as the preview; the file is not parsed again.
      const accountMap = await loadAccountMap(accountsFile);
      report = await actual.withBudget((api) => runBatch(api, batch.parsed, accountMap, false, runOpts), { syncAfter: true });
    } catch (err) {
      req.log.error(`import failed: ${(err as Error).message}`);
      return reply.code(502).send({ error: (err as Error).message });
    }

    store.delete(token as string);
    req.log.info(`import: ${summary(report)}, ${Date.now() - started} ms`);
    return { filename: batch.filename, ...report };
  });

  return app;
}

/** Log-safe summary: Actual account names and counts only. */
function summary(report: BatchReport): string {
  const parts = report.accounts.map((a) =>
    a.error
      ? `${a.actualAccount ?? 'unmapped account'}: failed`
      : `${a.actualAccount}${a.newAccount ? ' (new account)' : ''}: ${a.rowCount} rows, +${a.added} added, ${a.updated} updated, ${a.alreadyImported} skipped, ` +
        `${a.rejects.length} rejected, ${a.warnings.length} warnings, ${a.errors.length} errors`,
  );
  if (report.unassignedRejects.length) parts.push(`${report.unassignedRejects.length} unassigned rejects`);
  return parts.join('; ') || 'no accounts';
}
