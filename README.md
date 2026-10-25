# actual-importer

A small LAN-only web page for importing bank CSV exports from Netbank on the BEC
platform into a self-hosted [Actual Budget](https://actualbudget.org).

Drop a CSV on the page, check the preview, click **Import**. Uploading the same
(or an overlapping) export again is safe: rows that are already in Actual are
skipped.

The original spec is in [actual-csv-importer-spec.md](actual-csv-importer-spec.md),
and [bec2actual.py](bec2actual.py) is the Python script the parser was ported from.

## How it works

1. **Upload** (`POST /preview`). The file is decoded as Windows-1252 and parsed
   line by line ([src/parser.ts](src/parser.ts)). The bank's CSV has unescaped
   quotes, so no CSV library is used.
   - Lines that can't be parsed (bad date, bad amount, a `;` inside the text)
     are **rejected** and shown with line number, reason and raw text.
   - Running balances are checked per account. A gap gives a **warning**
     (rows are probably missing from the export), not a reject.
2. **Preview.** The parsed rows are sent to Actual as a **dry run**
   (`importTransactions(..., { dryRun: true })`). Nothing is written. The page
   shows, per account: how many rows would be added, how many are already
   imported, and the rows to add.
3. **Import** (`POST /import`). The exact same parsed batch (kept in memory for
   15 minutes under a random token) is imported for real, then synced to the
   server.

Each transaction gets an `imported_id` derived from account, date, amount,
running balance and text ([src/mapping.ts](src/mapping.ts)). That ID is how
Actual recognises rows it already has.

| File | What it does |
|---|---|
| `src/parser.ts` | BEC CSV parsing, amounts in integer øre, balance check |
| `src/mapping.ts` | Parsed row → Actual transaction, `imported_id` |
| `src/importer.ts` | Runs a batch against Actual per account, builds the report |
| `src/actual.ts` | Connection to Actual (connect, sync, mutex, shutdown) |
| `src/app.ts` | HTTP routes |
| `src/server.ts` | Entry point |
| `public/index.html` | The page (plain HTML + JS, no build step) |

## Configuration

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `ACTUAL_SERVER_URL` | yes | e.g. `https://budget.example.com` |
| `ACTUAL_PASSWORD` | yes | Actual server password |
| `ACTUAL_SYNC_ID` | yes | Actual → Settings → Advanced settings → Sync ID |
| `ACTUAL_E2E_PASSWORD` | no | Only if end-to-end encryption is turned on (it isn't today) |
| `ACTUAL_DATA_DIR` | no | Local budget cache. Default `/data/actual-cache` |
| `ACCOUNTS_FILE` | no | Default: `accounts.json` next to the data dir, i.e. `/data/accounts.json` |
| `PORT` | no | Default `3000` |

### accounts.json

Maps the bank's account number (`Exportkonto`) to the **name** of an account in
Actual. Lives on the data volume, not in the repo:

```json
{
  "11112222333344": "Budgetkonto",
  "55556666777788": "Opsparing"
}
```

See [accounts.example.json](accounts.example.json). The file is read on every
upload, so edits take effect without a restart. An account in the CSV with no
mapping, or mapped to a name Actual doesn't have, is shown as an error in the
preview; other accounts in the same file are still imported.

## Running locally

Node isn't needed on your machine; Docker is enough.

```bash
cp .env.example .env
```

Edit `.env`, then create the data folder with your mapping:

```bash
mkdir -p data && cp accounts.example.json data/accounts.json
```

```bash
docker compose up --build
```

The page is at http://localhost:3010. The container runs as UID 568, so on
Linux the `data` folder must be writable by that user (`sudo chown -R 568:568 data`).

### Development

With Node 24 installed:

```bash
npm install
```

```bash
npm test
```

`npm run typecheck` checks types, `npm run build` compiles to `dist/`.

There is also a manual integration check that does a **dry run** of a real
export against a real server and prints counts only. It's not part of `npm test`:

```bash
ACTUAL_SERVER_URL=https://budget.example.com ACTUAL_PASSWORD=... ACTUAL_SYNC_ID=... ACTUAL_DATA_DIR=./data/actual-cache npm run dry-run -- ~/Downloads/export.csv
```

## Deploying on TrueNAS SCALE

TrueNAS custom apps can't build images, so build it on the TrueNAS host first.

1. Copy this repo to the TrueNAS box (e.g. `git clone` into
   `/mnt/<pool>/apps/actual-importer-src`) and, in a TrueNAS shell, build it:

   ```bash
   docker build -t actual-importer:latest /mnt/<pool>/apps/actual-importer-src
   ```

2. Create the data dataset/folder, e.g. `/mnt/<pool>/apps/actual-importer`, put
   `accounts.json` in it, and make it owned by the `apps` user:

   ```bash
   chown -R 568:568 /mnt/<pool>/apps/actual-importer
   ```

3. **Apps → Discover Apps → ⋮ → Install via YAML.** Paste `compose.yaml` with
   these changes: delete the `build: .` line, add `pull_policy: never` under
   the service, fill in the environment values directly (the `${...}`
   placeholders come from `.env`, which TrueNAS doesn't read), and set the
   volume to `/mnt/<pool>/apps/actual-importer:/data`.

4. Check `http://<truenas-ip>:3010/healthz` returns `{"ok":true}`.

**If the container can't resolve `budget.example.com`** (local DNS not
reachable from inside Docker), point `ACTUAL_SERVER_URL` at Actual's own
address on the TrueNAS host instead, e.g. `http://<truenas-ip>:<actual-port>`
(the port shown for the Actual app under Apps). That skips Nginx Proxy Manager
entirely, which is fine since both run on the same host.

## Nginx Proxy Manager (lan-proxy)

Give the page its own LAN hostname, e.g. `budget-import.example.com`:

1. In `lan-proxy`: **Hosts → Proxy Hosts → Add Proxy Host**
   - Domain: `budget-import.example.com`
   - Scheme `http`, forward host `<truenas-ip>`, forward port `3010`
   - SSL tab: pick the existing wildcard certificate, enable **Force SSL**
     (and HTTP/2).
2. In your local DNS, add a record for `budget-import.example.com` pointing
   at `lan-proxy` (same as the other LAN-only names).
3. Do **not** add it to the WAN-facing proxy or forward any ports. The page
   has no login; anyone who can reach it can import into the budget.

## Updating Actual

`@actual-app/api` must match the Actual server version. Mismatches are a
known cause of breakage. The API is pinned to an exact version in
`package.json` (currently `26.10.0`).

When you update the Actual app on TrueNAS:

1. Bump the API to the same version as the server:

   ```bash
   npm install --save-exact @actual-app/api@<new server version>
   ```

   (Without Node installed: `docker run --rm -v "$PWD":/app -w /app node:24-bookworm-slim npm install --save-exact @actual-app/api@<version>`.)

2. Run `npm test`, commit `package.json` and `package-lock.json`.
3. Rebuild the image on TrueNAS (`git pull`, then the `docker build` command
   above) and restart the app.
4. Upload a recent export and check that the preview shows everything as
   already imported.

It's simplest to update both on the same day: upgrade Actual, then
immediately rebuild this.

## Notes

- **Logs** contain one line per preview/import with Actual account names,
  counts and duration. Never transaction text, amounts or account numbers.
  The Actual API runs with `verbose: false` because in verbose mode it prints
  every transaction.
- **Rejected lines** are never imported. Fix them in Actual by hand.
- **Deleted transactions stay deleted**: re-importing a row you deleted in
  Actual does not bring it back (`reimportDeleted: false`, same as Actual's
  own importer).
- **Payee names** are kept exactly as the bank writes them
  (`payeeNameNormalization: 'original'`), so rules can match on the bank's text.
- Don't change the `imported_id` formula in `src/mapping.ts`. If you do,
  every previously imported row will look new and be imported again.
- Only connects to the Actual server; no other outbound network calls.
