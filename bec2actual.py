#!/usr/bin/env python3
"""Clean a BEC Netbank export for import into Actual Budget.

Fixes what breaks Actual's importer:
  - Windows-1252 encoding  -> UTF-8 (æøå survive)
  - unescaped quotes inside fields, e.g. ""EKSEMPEL""  -> rewritten as valid CSV
  - dd-mm-yyyy dates        -> yyyy-mm-dd
  - padded amounts " 264.56" -> 264.56

Also checks the running balance per account, which catches rows missing
from an export (e.g. after the "only not previously exported" trap).

Writes one UTF-8 CSV per own account next to the input, plus a
<input>-rejects.txt listing any line it could not parse safely.

Usage: python3 bec2actual.py Posteringer.csv
"""

import csv
import sys
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

# Netbank header names -> internal names. Used when the export has a header
# row; without one, the columns are assumed to be in this order.
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
    """Strip whitespace and any wrapping quotes; collapse inner whitespace."""
    field = field.strip().strip('"').strip()
    return " ".join(field.split())


def split_fields(line: str, ncols: int) -> list[str]:
    parts = line.split(";")
    if len(parts) == ncols + 1 and parts[-1].strip() == "":
        parts = parts[:-1]  # trailing ';'
    if len(parts) != ncols:
        raise ValueError(
            f"expected {ncols} fields, got {len(parts)} " "(a ';' inside the text?)"
        )
    return parts


def read_header(line: str) -> list[str] | None:
    """Return internal column names if this line is a header, else None."""
    names = [clean(f) for f in line.split(";")]
    if names and names[-1] == "":
        names = names[:-1]
    if "Dato" not in names:
        return None
    unknown = [n for n in names if n not in HEADERS]
    if unknown:
        sys.exit(
            f"Unknown column(s) in header: {unknown}. "
            "Add them to HEADERS in the script."
        )
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
        cols = list(HEADERS.values())  # no header: default column order
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

    warnings = []
    for account, rows in by_account.items():
        # Running-balance check: each row's balance = previous balance + amount.
        for prev, cur in zip(rows, rows[1:]):
            if prev["balance"] + cur["amount"] != cur["balance"]:
                warnings.append(
                    f"{account}: balance jump before {cur['date']} "
                    f"'{cur['text']}' (expected {prev['balance'] + cur['amount']}, "
                    f"file says {cur['balance']}). Rows missing?"
                )

        out = path.with_name(f"{path.stem}-{account[-4:]}-actual.csv")
        with out.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(
                [
                    "Date",
                    "Payee",
                    "Amount",
                    "Notes",
                    "FromAccount",
                    "ToAccount",
                    "Balance",
                ]
            )
            for r in rows:
                notes = " | ".join(
                    x for x in (r["counterparty"], r["message"], r["extra"]) if x
                )
                w.writerow(
                    [
                        r["date"],
                        r["text"],
                        f"{r['amount']:.2f}",
                        notes,
                        r["from_account"],
                        r["to_account"],
                        f"{r['balance']:.2f}",
                    ]
                )
        print(
            f"wrote {out.name}: {len(rows)} rows "
            f"({rows[0]['date']} to {rows[-1]['date']})"
        )

    for w in warnings:
        print("WARNING", w)
    if rejects:
        rej = path.with_name(f"{path.stem}-rejects.txt")
        rej.write_text("\n".join(rejects) + "\n", encoding="utf-8")
        print(f"{len(rejects)} line(s) rejected, see {rej.name}")
    return 1 if rejects else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(Path(sys.argv[1])))
