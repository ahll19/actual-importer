// Parser for BEC Netbank CSV exports.
//
// Ported from the Python reference parser (bec2actual.py). The export is not
// valid CSV: quotes inside fields are not escaped (e.g. `""EKSEMPEL""`), so we
// deliberately do NOT use a CSV library. Each line is split on `;` and every
// field is cleaned by hand. A line with the wrong number of fields is rejected
// rather than guessed at.

import iconv from 'iconv-lite';

/** Bank header name -> internal column name. Order = column order when there is no header row. */
export const HEADERS = {
  Exportkonto: 'account',
  Afsenderkonto: 'fromAccount',
  Modtagerkonto: 'toAccount',
  Dato: 'date',
  Tekst: 'text',
  Beløb: 'amount',
  Saldo: 'balance',
  Indbetaler: 'counterparty',
  'Supp. tekst til modtager': 'message',
  'Tekst til modtager': 'extra',
} as const;

type Column = (typeof HEADERS)[keyof typeof HEADERS];

const DEFAULT_COLUMNS: Column[] = Object.values(HEADERS);
const REQUIRED: Column[] = ['account', 'date', 'text', 'amount', 'balance'];

export interface ParsedRow {
  /** 1-based line number in the uploaded file. */
  lineNo: number;
  account: string;
  fromAccount: string;
  toAccount: string;
  /** ISO date, yyyy-mm-dd. */
  date: string;
  text: string;
  /** Integer øre (1 DKK = 100 øre). */
  amount: number;
  /** Running balance after this row, integer øre. */
  balance: number;
  counterparty: string;
  message: string;
  extra: string;
}

export interface RejectedLine {
  lineNo: number;
  reason: string;
  raw: string;
  /**
   * The own account the line belongs to, when we can tell for sure (the line
   * split into the right number of fields). Undefined when the line is too
   * broken to know.
   */
  account?: string;
}

export interface BalanceWarning {
  account: string;
  lineNo: number;
  date: string;
  /** previous balance + this amount (øre). */
  expectedBalance: number;
  /** balance the bank reported on this row (øre). */
  actualBalance: number;
}

export interface ParseResult {
  /** Rows grouped by `account`, in file order. */
  accounts: Map<string, ParsedRow[]>;
  rejects: RejectedLine[];
  warnings: BalanceWarning[];
}

/** Problem with the file as a whole (bad header, empty file). Nothing is imported. */
export class UploadError extends Error {}

/** Thrown for a single bad line; turned into a RejectedLine. */
class LineError extends Error {}

/**
 * Clean one raw field: trim, strip leading/trailing `"` characters, trim again,
 * collapse internal whitespace. `""EKSEMPEL""` -> `EKSEMPEL`, while quotes in the
 * middle of the text (`Tilskud "eksem pel"`) are kept.
 */
export function cleanField(field: string): string {
  return field
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Split a line on `;`, dropping the trailing empty field the bank always adds. */
function splitLine(line: string): string[] {
  const parts = line.split(';');
  if (parts.length > 1 && parts[parts.length - 1].trim() === '') parts.pop();
  return parts;
}

/**
 * Parse an amount like `-29.00`, ` 264.56`, `-1.234,56` or `264,56` into
 * integer øre without going through floating point.
 */
export function parseAmountToOre(value: string): number {
  let s = value.replace(/\s+/g, '');
  // Decimal comma variant: `.` is a thousands separator, `,` the decimal point.
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new LineError(`not a number: "${value.trim()}"`);
  const kroner = Number(m[2]);
  const ore = kroner * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(ore)) throw new LineError(`number too large: "${value.trim()}"`);
  return m[1] === '-' ? -ore || 0 : ore; // `|| 0` turns -0 into 0
}

/** `dd-mm-yyyy` -> `yyyy-mm-dd`, rejecting impossible dates like 31-02-2026. */
export function parseDate(value: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!m) throw new LineError(`invalid date: "${value}"`);
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (d.getUTCFullYear() !== Number(yyyy) || d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) {
    throw new LineError(`invalid date: "${value}"`);
  }
  return `${yyyy}-${mm}-${dd}`;
}

/** Returns the column list if `line` is a header row, otherwise null. */
function readHeader(line: string): Column[] | null {
  const names = splitLine(line).map(cleanField);
  if (!names.includes('Dato')) return null;

  const unknown = names.filter((n) => !(n in HEADERS));
  if (unknown.length > 0) {
    throw new UploadError(`Unknown column(s) in header: ${unknown.map((n) => `"${n}"`).join(', ')}.`);
  }
  const cols = names.map((n) => HEADERS[n as keyof typeof HEADERS]);
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length > 0) {
    const bankNames = missing.map((c) => Object.keys(HEADERS).find((k) => HEADERS[k as keyof typeof HEADERS] === c));
    throw new UploadError(`Export is missing required column(s): ${bankNames.join(', ')}.`);
  }
  return cols;
}

function parseLine(line: string, cols: Column[], lineNo: number): ParsedRow {
  const parts = splitLine(line);
  if (parts.length !== cols.length) {
    throw new LineError(`expected ${cols.length} fields, got ${parts.length} (a ';' inside the text?)`);
  }
  const f: Record<string, string> = {};
  cols.forEach((name, i) => (f[name] = cleanField(parts[i])));

  return {
    lineNo,
    account: f.account,
    fromAccount: f.fromAccount ?? '',
    toAccount: f.toAccount ?? '',
    date: parseDate(f.date),
    text: f.text,
    amount: parseAmountToOre(f.amount),
    balance: parseAmountToOre(f.balance),
    counterparty: f.counterparty ?? '',
    message: f.message ?? '',
    extra: f.extra ?? '',
  };
}

/** Decode the raw upload. BEC exports are Windows-1252, not UTF-8. */
export function decodeExport(bytes: Buffer): string {
  return iconv.decode(bytes, 'win1252');
}

export function parseBecCsv(bytes: Buffer): ParseResult {
  const lines = decodeExport(bytes).split(/\r\n|\n|\r/);

  const firstContent = lines.findIndex((l) => l.trim() !== '');
  if (firstContent === -1) throw new UploadError('The file is empty.');

  const header = readHeader(lines[firstContent]);
  const cols = header ?? DEFAULT_COLUMNS;
  const startIndex = header ? firstContent + 1 : firstContent;

  const accounts = new Map<string, ParsedRow[]>();
  const rejects: RejectedLine[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const lineNo = i + 1;
    try {
      const row = parseLine(line, cols, lineNo);
      if (!row.account) throw new LineError('missing Exportkonto');
      const list = accounts.get(row.account) ?? [];
      list.push(row);
      accounts.set(row.account, list);
    } catch (err) {
      if (!(err instanceof LineError)) throw err;
      rejects.push({ lineNo, reason: err.message, raw: line, account: accountOf(line, cols) });
    }
  }

  if (accounts.size === 0 && rejects.length === 0) throw new UploadError('The file contains no transactions.');

  return { accounts, rejects, warnings: checkBalances(accounts) };
}

/** The account of a rejected line, but only when the line has the right shape. */
function accountOf(line: string, cols: Column[]): string | undefined {
  const parts = splitLine(line);
  if (parts.length !== cols.length) return undefined;
  return cleanField(parts[cols.indexOf('account')]) || undefined;
}

/**
 * Within each account, in file order: previous balance + this amount must equal
 * this balance. A mismatch usually means rows are missing from the export
 * (e.g. the "only not previously exported" option), so it is a warning, not a reject.
 */
export function checkBalances(accounts: Map<string, ParsedRow[]>): BalanceWarning[] {
  const warnings: BalanceWarning[] = [];
  for (const [account, rows] of accounts) {
    for (let i = 1; i < rows.length; i++) {
      const expected = rows[i - 1].balance + rows[i].amount;
      if (expected !== rows[i].balance) {
        warnings.push({
          account,
          lineNo: rows[i].lineNo,
          date: rows[i].date,
          expectedBalance: expected,
          actualBalance: rows[i].balance,
        });
      }
    }
  }
  return warnings;
}
