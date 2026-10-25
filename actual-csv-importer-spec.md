# Spec: CSV upload importer for Actual Budget (BEC Netbank)

Build a small LAN-only web service. A user drops a bank CSV export on a page,
sees a preview of what will happen, clicks **Import**, and the transactions land
in the right accounts in a self-hosted Actual Budget server.

Read the whole spec before starting. If anything here conflicts with what you
find in the current `@actual-app/api` docs, stop and ask instead of guessing.

## Context

- **Actual Budget** server v26.10.0, running as a TrueNAS SCALE catalog app on
  the LAN, reached at `https://budget.example.com` through Nginx Proxy Manager
  (`lan-proxy`) with a valid wildcard certificate and local DNS. End-to-end
  encryption is **off**. Envelope budgeting. One shared budget file.
- **Bank**: Netbank on the BEC
  platform. Transactions are exported manually via
  *Konti og posteringer → Gem posteringer som fil* as CSV.
- **Deployment target**: a TrueNAS SCALE custom app (Docker container) on the
  same server as Actual, exposed LAN-only through `lan-proxy` on its own hostname.
- **Access**: anyone on the LAN. No app login. Never exposed to the internet.
- The owner maintains this himself afterwards. Prefer plain, readable code over
  clever abstractions, and explain non-obvious decisions in comments.

## Stack

- Node.js (current LTS) + TypeScript, single container.
- `@actual-app/api` for all writes to Actual. **Pin the version to match the
  server (26.10.0).** API/server version mismatches are a known source of
  breakage; document how to bump both together.
- A minimal HTTP server (Fastify or Express, your choice, justify briefly).
- Frontend: one static HTML page with plain JS and a little CSS. No framework,
  no build step for the frontend.
- Tests: Vitest (or Node's built-in test runner).

## User flow

1. Open the page, drag a CSV in (or pick a file).
2. Server parses it and runs a **dry run** against Actual (no writes).
3. Page shows a preview **per account**:
   - Actual account it maps to
   - date range and row count
   - how many would be **added**, how many are **already imported** (skipped),
     how many **updated**
   - **balance warnings** (see parser) and **rejected lines** with line number,
     reason and raw text
   - a table of the rows to be added (date, payee, amount, notes)
4. User clicks **Import** (or **Cancel**). If there are balance warnings, the
   Import button requires ticking "I've checked the warnings".
5. Server performs the real import with the exact same parsed batch, syncs to
   the server, and the page shows the result (added / updated / errors).

Rejected lines are never imported; the rest of the file can be. Show the
rejects clearly so they can be fixed by hand or by a later LLM-assisted step.

Store the parsed batch server-side between preview and confirm, keyed by a
random token, and expire it after 15 minutes. Confirm must not re-parse the
upload.

## Input format (BEC Netbank CSV)

Verified against a real export. The parser must handle all of this:

- **Encoding: Windows-1252** (cp1252), not UTF-8. Decode explicitly (e.g.
  `iconv-lite`). Danish letters æøå must survive.
- **Delimiter: `;`**. Lines end with a **trailing `;`** (one extra empty field).
  Line endings may be CRLF.
- **Optional header row.** When present, map columns **by name**. Known header
  names:

  | Header | Internal name | Required |
  |---|---|---|
  | `Exportkonto` | `account` (the own account the row belongs to) | yes |
  | `Afsenderkonto` | `fromAccount` | no |
  | `Modtagerkonto` | `toAccount` | no |
  | `Dato` | `date` | yes |
  | `Tekst` | `text` (becomes the payee) | yes |
  | `Beløb` | `amount` | yes |
  | `Saldo` | `balance` (running balance after this row) | yes |
  | `Indbetaler` | `counterparty` (name + address) | no |
  | `Supp. tekst til modtager` | `message` | no |
  | `Tekst til modtager` | `extra` | no |

  A header is detected by a field equal to `Dato`. Unknown header names → fail
  the whole upload with a clear message naming the column. Missing required
  columns → fail with a clear message. Without a header row, assume the column
  order in the table above.
- **Quotes are not escaped.** Fields are wrapped in `"…"`, but quotes inside
  text are left raw, e.g. `""EKSEMPEL""` and `"Tilskud fra Eksempelforeningen
  "eksem pel" "`. A standard CSV parser rejects these. **Do not use a CSV
  library to read the input.** Split each line on `;`, then per field: trim
  whitespace, strip leading/trailing `"` characters, trim again, and collapse
  runs of internal whitespace to a single space. `""EKSEMPEL""` → `EKSEMPEL`.
- If a line splits into the wrong number of fields (a `;` inside the text),
  **reject that line** with reason "expected N fields, got M". Never guess.
- **Dates**: `dd-mm-yyyy` → convert to `yyyy-mm-dd`. Invalid date → reject line.
- **Amounts and balances**: may have leading spaces (`" 264.56"`). The export
  option "convert decimal comma to point" is normally on, but also accept a
  comma decimal (`-1.234,56` / `264,56`): if the value contains `,`, remove `.`
  thousands separators and treat `,` as the decimal point. Parse as decimal
  strings into **integer øre**, never via floating point. Non-numeric → reject.
- **Running-balance check**: group rows by `account` in file order. For each
  row after the first, `previous.balance + row.amount` must equal
  `row.balance`. Each mismatch is a **warning** (rows probably missing from the
  export), not a reject.

Example rows (account numbers and names are fake):

```
"Exportkonto";"Afsenderkonto";"Modtagerkonto";"Dato";"Tekst";"Beløb";"Saldo";"Indbetaler";"Supp. tekst til modtager";"Tekst til modtager";
"11112222333344";"11112222333344";"";03-08-2026;"Debetkort    ABC*Testbutik";-29.00; 13230.96;"";"Forretning: ABC*Testbutik By .......: Testby";"";
"11112222333344";"";"11112222333344";03-08-2026;""EKSEMPEL""; 264.56; 13495.52;"EKSEMPELFORENINGEN, ÆBLEVEJ 5 1234 TESTRUP Ø ";"Tilskud fra Eksempelforeningen "eksem pel" ";"";
"11112222333344";"11112222333344";"55556666777788";03-08-2026;"Til Ønskeopsparing p";-250.00; 13245.52;"Test Person Testvej 1 1234 Testrup ";"";"Fra Testkonto";
```

A working Python reference implementation of this parser (`bec2actual.py`) is
in the appendix. Port its behaviour, not necessarily its structure.

## Mapping to Actual transactions

For each parsed row:

| Actual field | Value |
|---|---|
| `date` | ISO date |
| `amount` | integer øre (Actual's integer amount format) |
| `payee_name` | `text` |
| `imported_payee` | `text` |
| `notes` | non-empty of `counterparty`, `message`, `extra` joined with ` \| ` |
| `imported_id` | see below |
| `cleared` | `true` |

**`imported_id`**: the export has no transaction ID, so derive a stable one:
`"bec-" + sha256(account|date|amountØre|balanceØre|text)` truncated to 32 hex
chars. Including the running balance makes two identical same-day purchases
distinct while staying stable across re-exports of the same period. Document
this in a comment: it is what makes re-uploading an overlapping export safe.

Call `importTransactions(accountId, transactions, { dryRun, payeeNameNormalization: 'original', reimportDeleted: false })`:

- `dryRun: true` for the preview, `false` for the real import.
- `payeeNameNormalization: 'original'`: the default title-cases payee names,
  which would break rules written against the bank's exact text.
- `reimportDeleted: false`: matches the UI importer; deleting a transaction in
  Actual should stick.

Use the returned `added` / `updated` / `errors` for the preview and result.
Rows neither added nor updated count as "already imported".

## Account mapping

Config file `accounts.json` on the persistent volume, mapping the bank's
`Exportkonto` to an Actual account **name**:

```json
{
  "11112222333344": "Budgetkonto",
  "55556666777788": "Opsparing"
}
```

Resolve names to IDs via `getAccounts()` at the start of each operation. An
`Exportkonto` with no mapping, or a mapped name that doesn't exist in Actual,
fails that account's section in the preview with a clear message (other
accounts in the same file still proceed). Provide `accounts.example.json` with
fake numbers. Do **not** put real account numbers in the repo, in tests or in
logs.

## Actual connection

Environment variables:

- `ACTUAL_SERVER_URL`: e.g. `https://budget.example.com`. The container must
  be able to resolve this via local DNS. Document the alternative of pointing
  at Actual's internal address on the TrueNAS host if DNS inside the
  container is a problem.
- `ACTUAL_PASSWORD`: server password.
- `ACTUAL_SYNC_ID`: the budget's Sync ID (Settings → Advanced → Sync ID).
- `ACTUAL_E2E_PASSWORD`: optional, unused today, pass through to
  `downloadBudget` if set.
- `ACTUAL_DATA_DIR`: local cache dir, on the persistent volume.
- `PORT`: default 3000.

Lifecycle: `init` → `downloadBudget` → work → `sync` → keep the process
alive. Re-download or sync before each preview and each import so the cache
isn't stale. Serialize all Actual operations with a simple mutex: the API is a
process-wide singleton, so two concurrent uploads must queue, not interleave.
Call `shutdown()` on SIGTERM.

## Server details

- `GET /`: the page.
- `POST /preview`: multipart upload, max 5 MB, `.csv` only. Returns the
  preview JSON plus a batch token.
- `POST /import`: `{ token }`. Runs the real import for that batch.
- `GET /healthz`: 200 if the process is up and the last Actual connection
  succeeded.
- Log one line per preview/import (counts, account names, duration). **Never
  log transaction text, amounts or account numbers.**
- No outbound network calls other than the Actual server.

## Deployment

- `Dockerfile`: small Node LTS image, non-root user (UID/GID 568 to match
  TrueNAS's `apps` user), only production dependencies in the final image.
- `compose.yaml` suitable for a TrueNAS SCALE **custom app (YAML)**: one
  service, a host-path volume for `/data` (`accounts.json` + Actual cache),
  env vars as above, `restart: unless-stopped`, port mapping.
- README section for `lan-proxy`: proxy host e.g. `budget-import.example.com` →
  container port, wildcard cert, Force SSL, and a local DNS record pointing
  the name at `lan-proxy`. No WAN exposure.
- README section "Updating Actual": bump `@actual-app/api` to the server's new
  version, rebuild, redeploy.

## Tests

Parser unit tests with fixtures generated **as cp1252 bytes**:

- header row present / absent
- `""EKSEMPEL""` → `EKSEMPEL`; inner quotes in notes preserved and survive
- æøå decode correctly
- trailing `;` and CRLF handled
- `;` inside text → reject with line number
- invalid date / non-numeric amount → reject
- decimal comma variant (`-1.234,56`)
- balance gap → warning
- unknown header column → whole upload fails
- same-day identical purchases get different `imported_id`s; the same row
  exported twice gets the same `imported_id`

Plus one integration test script (not run in CI) that does a dry run against a
real server using env vars, for manual verification.

## Non-goals

- No categorisation, rule creation or LLM features. That comes later, as a
  separate step working on rejects and uncategorised payees.
- No scheduled imports or bank scraping (Netbank needs MitID).
- No multi-user auth.

## Done when

- `docker compose up` gives a working page on the LAN.
- Uploading a real export shows a correct preview, importing adds the rows,
  and uploading the same file again shows everything as already imported.
- Tests pass, README covers setup, config, lan-proxy and updating.

---

## Appendix: Python reference parser (`bec2actual.py`)

```python
#!/usr/bin/env python3
"""Clean a BEC Netbank export for import into Actual Budget.

Fixes what breaks Actual's importer:
  - Windows-1252 encoding  -> UTF-8 (æøå survive)
  - unescaped quotes inside fields, e.g. ""EKSEMPEL""  -> rewritten as valid CSV
  - dd-mm-yyyy dates        -> yyyy-mm-dd
  - padded amounts " 264.56" -> 264.56

Also checks the running balance per account, which catches rows missing
from an export (e.g. after the "only not previously exported" trap).
"""

import csv
import sys
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

HEADERS = {
    "Exportkonto": "account",
    "Afsenderkonto": "from_account",
    "Modtagerkonto": "to_account",
    "Dato": "date",
    "Tekst": "text",
    "Beløb": "amount",
    "Saldo": "balance",
    "Indbetaler": "counterparty",
    "Supp. tekst til modtager": "message",
    "Tekst til modtager": "extra",
}
REQUIRED = {"account", "date", "text", "amount", "balance"}


def clean(field: str) -> str:
    field = field.strip().strip('"').strip()
    return " ".join(field.split())


def split_fields(line: str, ncols: int) -> list[str]:
    parts = line.split(";")
    if len(parts) == ncols + 1 and parts[-1].strip() == "":
        parts = parts[:-1]  # trailing ';'
    if len(parts) != ncols:
        raise ValueError(f"expected {ncols} fields, got {len(parts)} "
                         "(a ';' inside the text?)")
    return parts


def read_header(line: str) -> list[str] | None:
    names = [clean(f) for f in line.split(";")]
    if names and names[-1] == "":
        names = names[:-1]
    if "Dato" not in names:
        return None
    unknown = [n for n in names if n not in HEADERS]
    if unknown:
        sys.exit(f"Unknown column(s) in header: {unknown}.")
    cols = [HEADERS[n] for n in names]
    missing = REQUIRED - set(cols)
    if missing:
        sys.exit(f"Export is missing required column(s): {sorted(missing)}")
    return cols


def parse_line(line: str, cols: list[str]) -> dict:
    parts = split_fields(line, len(cols))
    row = {name: clean(value) for name, value in zip(cols, parts)}
    for optional in HEADERS.values():
        row.setdefault(optional, "")
    row["date"] = datetime.strptime(row["date"], "%d-%m-%Y").strftime("%Y-%m-%d")
    try:
        row["amount"] = Decimal(row["amount"])
        row["balance"] = Decimal(row["balance"])
    except InvalidOperation:
        raise ValueError("amount or balance is not a number")
    return row


def main(path: Path) -> int:
    text = path.read_bytes().decode("cp1252")
    by_account: dict[str, list[dict]] = {}
    rejects = []

    lines = text.splitlines()
    cols = read_header(lines[0]) if lines else None
    start = 2 if cols else 1
    if cols is None:
        cols = list(HEADERS.values())
    else:
        lines = lines[1:]

    for lineno, line in enumerate(lines, start=start):
        if not line.strip():
            continue
        try:
            row = parse_line(line, cols)
        except ValueError as err:
            rejects.append(f"line {lineno}: {err}\n  {line}")
            continue
        by_account.setdefault(row["account"], []).append(row)

    for account, rows in by_account.items():
        for prev, cur in zip(rows, rows[1:]):
            if prev["balance"] + cur["amount"] != cur["balance"]:
                print(f"WARNING {account}: balance jump before {cur['date']}")
        # ... writes one UTF-8 CSV per account (Date, Payee, Amount, Notes, ...)
    return 1 if rejects else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
```

Note: the Python version only handles a decimal point. The Node version must
also accept a decimal comma, as specified above.
