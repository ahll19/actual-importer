# actual-importer

LAN-only web page that imports BEC Netbank CSV exports into a self-hosted Actual
Budget. Upload → dry-run preview → Import. Node 24 + TypeScript, Fastify, plain
HTML page (`public/index.html`, no build step). `README.md` is the owner's
setup guide; keep it short and user-facing. Developer detail belongs here.

## Commands

Docker is the only local dependency. Never use or install Node on the host,
even if one is present. Run commands from the repo root, exactly as written:
`--user` keeps files owned by you, `:z` is needed on SELinux hosts (Fedora)
and harmless on macOS.

Install dependencies (first time, and after `package-lock.json` changes):

`docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app:z -w /app node:24-bookworm-slim npm ci --ignore-scripts`

Tests, typecheck and test-docs check (run all three before saying a change is done; CI runs the same on every PR):

`docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app:z -w /app node:24-bookworm-slim sh -c "npm test && npm run typecheck && npm run check:test-docs"`

One test file: same command with `npx vitest run test/parser.test.ts`.

Run the app (needs `.env` and `data/accounts.json`, see README): `docker compose up --build`, then http://localhost:3010.

Dry run of a real export against the real Actual server (writes nothing, prints counts only; put the CSV in the git-ignored `data/` folder):

`docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp --env-file .env -e ACTUAL_DATA_DIR=/tmp/actual-cache -e ACCOUNTS_FILE=/app/data/accounts.json -v "$PWD":/app:z -w /app node:24-bookworm-slim npm run dry-run -- data/export.csv`

Bump the Actual API (only together with the server, see Rules):

`docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app:z -w /app node:24-bookworm-slim npm install --package-lock-only --save-exact @actual-app/api@<version>`

`--ignore-scripts` is deliberate: `better-sqlite3` ships prebuilt binaries for
Linux and macOS (x64 and arm64), and its install script would try to compile
and fail in the slim image. The Dockerfile's build stage does run scripts and
has a compiler toolchain for that reason.

## Layout

| Path | What it does |
|---|---|
| `src/parser.ts` | BEC CSV parsing (cp1252, unescaped quotes, no CSV library), amounts in integer øre, running-balance check |
| `src/mapping.ts` | Parsed row → Actual transaction, `imported_id` |
| `src/importer.ts` | Runs a batch against Actual per account, builds the preview/result report |
| `src/actual.ts` | Actual connection: init, download/sync, mutex, shutdown |
| `src/batches.ts` | Parsed batches kept in memory for 15 min under a random token |
| `src/accounts.ts` | Reads `accounts.json` (bank account number → Actual account name) |
| `src/app.ts`, `src/server.ts` | HTTP routes (`/`, `/preview`, `/import`, `/healthz`) and entry point |
| `scripts/dry-run.ts` | Manual dry run against a real server, not part of `npm test` |
| `test/` | Vitest tests; fixtures are built as cp1252 bytes in `test/helpers.ts`. `test/README.md` documents every test |
| `scripts/check-test-docs.ts` | Fails if a test is missing from `test/README.md` (run in CI) |
| `.github/workflows/ci.yml` | CI: tests, typecheck and test-docs check on every PR and push to `main` |
| `plans/` | Plans and open work. Plans go here, not in this file |
| `.archive/` | The original v1 spec, kept for history only. The code wins where they differ |

Flow: `POST /preview` parses the upload and calls
`importTransactions(..., { dryRun: true })`. `POST /import` takes the token and
imports the exact same parsed batch (never re-parses), then syncs.

## Rules

- **Never change the `imported_id` formula** in `src/mapping.ts`. It is what
  makes re-uploading an overlapping export safe; changing it re-imports every
  row ever imported.
- **`@actual-app/api` is pinned to exactly the Actual server version** (now
  26.10.0). Never bump it on its own.
- **Never log or print transaction data**: no transaction text, amounts or
  account numbers. One log line per preview/import with counts, Actual account
  names and duration. Keep `verbose: false` in `api.init()`; verbose mode
  prints every transaction.
- **No private details in anything committed**: no real account numbers,
  exports, `.env`, `accounts.json`, hostnames, domains or bank names. Use
  `example.com` hosts and the fake account numbers `11112222333344`,
  `55556666777788`, `99990000111122`. Real values live in `CLAUDE.local.md`
  (git-ignored).
- **No network calls** other than to the Actual server.
- **Text users see is Danish** (the page, error messages shown on it). Code,
  comments, logs, commit messages and docs are English.
- **Keep code plain and readable.** The owner maintains it. Prefer simple
  functions over abstractions, and comment the non-obvious *why*.

## Non-obvious decisions

- Empty notes are sent as `undefined`, not `""`: Actual treats `""` and `null`
  as different, so `""` made every re-upload report rows as "updated".
- In a dry run, `added` only holds fresh random IDs, so the preview's "rows to
  add" are all rows minus those matched in `updatedPreview` (`rowsToAdd` in
  `src/importer.ts`).
- Rejected lines with an unknown account (wrong field count) get their own
  section instead of being guessed into an account.
- `CREATE_MISSING_ACCOUNTS=true` (off by default, meant for a test budget)
  creates accounts that `accounts.json` names but Actual lacks, on import only;
  the preview just says so. The starting balance is the oldest row's balance
  minus its amount. Actual dates it today, so it is moved to the oldest row's
  date (`createAccount` in `src/importer.ts`).
- Import options: `payeeNameNormalization: 'original'` keeps the bank's exact
  text for rules; `reimportDeleted: false` keeps deletions in Actual.
- All Actual calls go through one mutex: the API is a process-wide singleton.
- Request logging is silenced with a `LogController` subclass (`QuietRequests`
  in `src/app.ts`); Fastify's `disableRequestLogging` is deprecated.
- TypeScript 7 (the Go-based `tsc`) with `skipLibCheck`.
- Deployment: Dockge stack on TrueNAS SCALE. The repo is cloned into Dockge's
  stacks folder and `compose.yaml` builds the image there (`pull_policy:
  build`). The container runs as UID 568 (TrueNAS `apps` user).
- End-to-end testing has been done against a throwaway local
  `actualbudget/actual-server:<same version>` container with fake data.

## Workflow

- Work on a branch and open a PR. Ask before every commit, push or PR.
- Ask before adding or upgrading any dependency.
- **Describe test changes and wait for approval before making them.** This
  covers adding, changing or removing a test, its assertions or its fixtures.
  For each test, say what changes and why. Every test must stay documented in
  `test/README.md` (CI checks this), so update that file in the same change.
- The dry run against the real server is fine without asking. Ask before
  anything else that touches the real Actual server or the deployment.
- When a change affects setup or deployment, update `README.md`. When it
  changes a rule or decision above, update this file.
