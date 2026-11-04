# Tests

Every test is listed here with what it checks and why it matters. CI fails if a
test is missing from this file, or if this file lists a test that no longer
exists (`npm run check:test-docs`). Test names must be unique.

All fixtures use fake data: the account numbers `11112222333344`,
`55556666777788` and `99990000111122`, and the rows in
[helpers.ts](helpers.ts), which are encoded as Windows-1252 bytes like a real
Netbank export.

## parser.test.ts: reading Netbank CSV exports

### `parseBecCsv`

| Test | What it checks |
|---|---|
| `parses a file with a header row` | A normal export with a header is read into rows for the right account, with dates as `yyyy-mm-dd`, amounts and balances in øre, and no rejects or warnings. |
| `parses a file without a header row using the default column order` | Exports without a header row still work, using Netbank's usual column order. Line numbers start at 1. |
| `maps header columns by name, not position` | Columns are found by their header name, so a reordered or shorter export still parses. Missing optional columns become empty strings. |
| `strips unescaped double quotes and keeps inner quotes` | Netbank's broken quoting (`""EKSEMPEL""`) is cleaned up, while quotes that belong to the text are kept. |
| `decodes æøå from Windows-1252` | Danish letters survive the Windows-1252 encoding. Also checks the fixture really is single-byte, not UTF-8. |
| `handles trailing ; with and without CRLF, and blank lines` | Both line-ending styles, the trailing `;` and blank lines are handled, and line numbers still match the file. |
| `rejects a line with a ; inside the text, with its line number` | A line with the wrong number of fields is rejected (not guessed at), keeps its line number and raw text, and has no account. The other lines still import. |
| `rejects an invalid date` | An impossible date (31 February) rejects that line, and the reject is linked to its account. |
| `rejects a non-numeric amount` | A non-numeric amount rejects only that line. |
| `accepts the decimal comma variant` | Amounts like `-1.234,56` (Danish format) are read correctly. |
| `warns about a balance gap but still keeps the rows` | When the running balance doesn't add up (rows missing from the export), a warning names the line and both balances, and the rows are still kept. |
| `checks balances per account` | The balance check runs separately for each account, so mixing accounts in one file doesn't cause false warnings. |
| `fails the whole upload on an unknown header column` | An unknown column in the header stops the whole upload (the format may have changed), and the error names the column. |
| `fails the whole upload when a required column is missing` | A header without a required column (here `Saldo`) stops the whole upload and names the missing column. |
| `fails on an empty file` | An empty file is an upload error, not an empty import. |

### Field helpers

| Test | What it checks |
|---|---|
| `cleanField` | Strips the outer quotes, collapses repeated spaces, keeps inner quotes and turns `""` into an empty string. |
| `parseAmountToOre` | Converts both `264.56` and `264,56` styles to whole øre without float rounding errors, and rejects empty or ambiguous values like `12.345`. |
| `parseDate` | Converts `dd-mm-yyyy` to `yyyy-mm-dd`, accepts leap days only in leap years, and rejects other formats. |

## mapping.test.ts: turning rows into Actual transactions

### `toActualTransaction`

| Test | What it checks |
|---|---|
| `maps a row to an Actual transaction` | The full mapping: date, amount, payee (bank text as both payee name and imported payee), notes, `imported_id` and `cleared`. |
| `joins only non-empty note fields` | Notes join counterparty, message and extra text with ` \| `, skipping empty ones. |
| `leaves notes out when there are none` | A row without note text sends `undefined`, not `""`. Otherwise Actual reports every re-upload as "updated". |

### `importedId`

| Test | What it checks |
|---|---|
| `has the documented shape` | The id looks like `bec-` plus 32 hex characters. |
| `gives identical same-day purchases different ids` | Two identical purchases on the same day get different ids (the balance differs), so neither is skipped as a duplicate. |
| `gives the same row the same id when exported again` | The same transaction in a later, overlapping export gets the same id, so re-uploading never imports it twice. |

## importer.test.ts: running a batch against Actual

These use a fake Actual API, never a real server.

### `runBatch`

| Test | What it checks |
|---|---|
| `reports added and already-imported rows per account` | Rows Actual already has are counted as already imported, the rest as to add, and the preview lists the rows to add. Actual is called with dry run, original payee names and `reimportDeleted: false`. |
| `fails only the account that has no mapping or no Actual account` | An account missing from `accounts.json`, or mapped to a name Actual doesn't have, gets an error, while the other accounts in the same file still go through. |
| `refuses a closed Actual account` | Nothing is imported into a closed Actual account. |
| `previews a missing account as new when account creation is on` | With `CREATE_MISSING_ACCOUNTS` on, the preview creates nothing, lists every row as to add, and shows the starting balance (oldest row's balance minus its amount) and its date. |
| `creates a missing account on import, then imports into it` | The import creates the account on-budget with that starting balance, moves the starting balance to the oldest row's date (Actual dates it today), and imports the rows into the new account. |
| `takes the starting balance from the oldest row in a newest-first export` | If the export is newest first, the starting balance still comes from the oldest row, not the first line of the file. |
| `puts rejects under their account, or in the unassigned list` | A rejected line with a known account is shown under that account; one without (wrong field count) goes to the "account unknown" list. |

### `BatchStore`

| Test | What it checks |
|---|---|
| `expires batches after the TTL` | A preview's token is random and stops working after 15 minutes. |

## app.test.ts: the HTTP routes

These start the app in memory with a fake Actual and a temporary
`accounts.json`.

| Test | What it checks |
|---|---|
| `previews, imports, and then shows everything as already imported` | The full flow: the preview writes nothing, the import adds the rows and syncs, the token only works once, and uploading the same file again shows everything as already imported. |
| `rejects non-CSV uploads and broken headers` | Non-`.csv` files and files with unknown header columns get a 400 with a readable error. |
| `rejects uploads over 5 MB` | Files over 5 MB get a 413. |
| `serves the page and the health check` | `/` serves the HTML page, and `/healthz` returns 200 when the Actual connection works and 503 when it doesn't. |
