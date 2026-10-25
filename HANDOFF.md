# Handoff

Notes for whoever picks this up next (human or agent). Read
[README.md](README.md) for setup and usage and
[actual-csv-importer-spec.md](actual-csv-importer-spec.md) for the full spec.

## Status (2026-10-28)

The spec is implemented and committed. **Not done yet:**

1. Try it with a **real** bank export. So far it has only been tested with
   fake data (see "How it was tested").
2. Deploy on TrueNAS and set up the `lan-proxy` proxy host (steps in the README).

Nothing is known to be broken.

## How it was tested

- `npm test`: 33 Vitest tests (parser with cp1252 byte fixtures, mapping,
  importer with a fake Actual, HTTP routes via `fastify.inject`).
- End to end against a throwaway local `actualbudget/actual-server:26.10.0`
  container, through `docker compose up`, using fake account numbers:
  preview → import → re-upload (everything shown as "already imported"),
  rejects, balance warning, an account missing from Actual, and the page
  clicked through in a browser.

## Things that aren't obvious from the code

- **No Node on the owner's Mac.** Everything was run in Docker, e.g.:
  `docker run --rm -v "$PWD":/app -v ai-nm:/app/node_modules -w /app node:24-bookworm-slim npm test`
  (the named volume keeps Linux `node_modules` off the host).
- **`verbose: false` in `api.init()` is required.** In verbose mode
  `@actual-app/api` prints every imported transaction (payee, amount, notes)
  to stdout, which breaks the "never log transaction data" rule.
- **Empty notes are sent as `undefined`, not `""`.** Actual compares `""` and
  `null` as different, so `""` made every re-upload report the row as
  "updated".
- **Rows to add in the preview** come from `updatedPreview`: in a dry run,
  `added` only contains fresh random IDs, so the rows that matched existing
  transactions are subtracted instead (`rowsToAdd` in `src/importer.ts`).
- **Rejects without a known account** (wrong field count) are shown in a
  separate "account unknown" section rather than guessed into an account.
- **Build stage installs python3/make/g++**: `better-sqlite3` (dependency of
  `@actual-app/api`) had no prebuilt binary on arm64 and fell back to compiling.
  The runtime image doesn't include them.
- **TrueNAS custom apps can't build images**: build on the host with
  `docker build`, remove `build:` from the YAML, add `pull_policy: never`.
- **Fastify `disableRequestLogging` is deprecated**; a `LogController`
  subclass (`QuietRequests` in `src/app.ts`) is used instead.
- **TypeScript 7** (the Go-based `tsc`) is used and works with `skipLibCheck`.

## Rules to keep

- `@actual-app/api` is pinned to exactly the server version (26.10.0). Bump
  both together (README → "Updating Actual").
- Don't change the `imported_id` formula in `src/mapping.ts`: every
  previously imported row would be imported again.
- No real account numbers, exports, `.env` or `accounts.json` in the repo,
  tests or logs. Tests use the fake numbers `11112222333344`,
  `55556666777788` and `99990000111122`. `.gitignore` covers `.env`,
  `/accounts.json` and `data/`.
- Plain, readable code; the owner maintains it.

## Possible next steps (out of scope for v1)

From the spec's non-goals: categorisation, rule creation and an LLM step that
works on rejected lines and uncategorised payees. No scheduled imports (Netbank
needs MitID) and no multi-user auth.
