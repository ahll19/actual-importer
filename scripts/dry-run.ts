// Manual integration check (not run by `npm test`): parses a real export and
// does a DRY RUN against a real Actual server. Nothing is written.
//
//   ACTUAL_SERVER_URL=https://budget.example.com ACTUAL_PASSWORD=... ACTUAL_SYNC_ID=... \
//   ACTUAL_DATA_DIR=./data/actual-cache ACCOUNTS_FILE=./data/accounts.json \
//   npm run dry-run -- path/to/export.csv
//
// Prints counts only, so the output is safe to paste into an issue.

import { readFile } from 'node:fs/promises';
import { loadAccountMap } from '../src/accounts.js';
import { ActualClient } from '../src/actual.js';
import { loadConfig } from '../src/config.js';
import { runBatch } from '../src/importer.js';
import { parseBecCsv } from '../src/parser.js';

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('usage: npm run dry-run -- <export.csv>');
  process.exit(2);
}

const config = loadConfig();
const parsed = parseBecCsv(await readFile(csvPath));
const accountMap = await loadAccountMap(config.accountsFile);
const client = new ActualClient(config.actual);

try {
  const report = await client.withBudget((api) => runBatch(api, parsed, accountMap, true, { createMissingAccounts: config.createMissingAccounts }));
  for (const a of report.accounts) {
    console.log(
      a.error
        ? `${a.actualAccount ?? 'unmapped account'}: ERROR ${a.error.replace(/\d{6,}/g, '<account>')}`
        : `${a.actualAccount}${a.newAccount ? ' (would be created)' : ''}: ${a.rowCount} rows (${a.dateFrom}..${a.dateTo}), ` +
            `${a.added} to add, ${a.updated} to update, ${a.alreadyImported} already imported, ` +
            `${a.rejects.length} rejected, ${a.warnings.length} balance warnings, ${a.errors.length} errors`,
    );
  }
  if (report.unassignedRejects.length) console.log(`${report.unassignedRejects.length} rejected lines without a known account`);
} finally {
  await client.shutdown();
}
