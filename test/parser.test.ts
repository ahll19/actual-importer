import { describe, expect, it } from 'vitest';
import { cleanField, parseAmountToOre, parseBecCsv, parseDate, UploadError } from '../src/parser.js';
import { cp1252, file, HEADER, ROW1, ROW2, ROW3 } from './helpers.js';

const ACCOUNT = '11112222333344';

describe('parseBecCsv', () => {
  it('parses a file with a header row', () => {
    const result = parseBecCsv(file(HEADER, ROW1, ROW2, ROW3));
    const rows = result.accounts.get(ACCOUNT)!;
    expect(rows).toHaveLength(3);
    expect(result.rejects).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(rows[0]).toMatchObject({
      lineNo: 2,
      account: ACCOUNT,
      fromAccount: ACCOUNT,
      toAccount: '',
      date: '2026-08-03',
      text: 'Debetkort ABC*Testbutik',
      amount: -2900,
      balance: 1323096,
      message: 'Forretning: ABC*Testbutik By .......: Testby',
    });
  });

  it('parses a file without a header row using the default column order', () => {
    const result = parseBecCsv(file(ROW1, ROW2, ROW3));
    const rows = result.accounts.get(ACCOUNT)!;
    expect(rows).toHaveLength(3);
    expect(rows[0].lineNo).toBe(1);
    expect(rows[2]).toMatchObject({ text: 'Til Ønskeopsparing p', amount: -25000, extra: 'Fra Testkonto' });
  });

  it('maps header columns by name, not position', () => {
    const header = '"Dato";"Exportkonto";"Tekst";"Beløb";"Saldo";';
    const row = '03-08-2026;"11112222333344";"Kaffe";-30.00;100.00;';
    const [parsed] = parseBecCsv(file(header, row)).accounts.get(ACCOUNT)!;
    expect(parsed).toMatchObject({ date: '2026-08-03', text: 'Kaffe', amount: -3000, balance: 10000, counterparty: '' });
  });

  it('strips unescaped double quotes and keeps inner quotes', () => {
    const [, row2] = parseBecCsv(file(HEADER, ROW1, ROW2)).accounts.get(ACCOUNT)!;
    expect(row2.text).toBe('EKSEMPEL');
    expect(row2.message).toBe('Tilskud fra Eksempelforeningen "eksem pel"');
  });

  it('decodes æøå from Windows-1252', () => {
    const [, row2, row3] = parseBecCsv(file(HEADER, ROW1, ROW2, ROW3)).accounts.get(ACCOUNT)!;
    expect(row2.counterparty).toBe('EKSEMPELFORENINGEN, ÆBLEVEJ 5 1234 TESTRUP Ø');
    expect(row3.text).toBe('Til Ønskeopsparing p');
    expect(row3.extra).toBe('Fra Testkonto');
    // Sanity check: the fixture really is single-byte cp1252, not UTF-8.
    expect(cp1252('ø')).toEqual(Buffer.from([0xf8]));
  });

  it('handles trailing ; with and without CRLF, and blank lines', () => {
    const lf = cp1252([HEADER, ROW1, '', ROW2].join('\n'));
    const crlf = cp1252([HEADER, ROW1, '', ROW2].join('\r\n') + '\r\n\r\n');
    for (const bytes of [lf, crlf]) {
      const result = parseBecCsv(bytes);
      expect(result.rejects).toEqual([]);
      expect(result.accounts.get(ACCOUNT)!.map((r) => r.lineNo)).toEqual([2, 4]);
    }
  });

  it('rejects a line with a ; inside the text, with its line number', () => {
    const bad = ROW2.replace('""EKSEMPEL""', '"EKS;EMPEL"');
    const result = parseBecCsv(file(HEADER, ROW1, bad, ROW3));
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]).toMatchObject({ lineNo: 3, raw: bad, account: undefined });
    expect(result.rejects[0].reason).toMatch(/^expected 10 fields, got 11/);
    expect(result.accounts.get(ACCOUNT)).toHaveLength(2);
  });

  it('rejects an invalid date', () => {
    const bad = ROW1.replace('03-08-2026', '31-02-2026');
    const result = parseBecCsv(file(HEADER, bad));
    expect(result.rejects[0]).toMatchObject({ lineNo: 2, account: ACCOUNT });
    expect(result.rejects[0].reason).toMatch(/invalid date/);
  });

  it('rejects a non-numeric amount', () => {
    const bad = ROW1.replace('-29.00', 'abc');
    const result = parseBecCsv(file(HEADER, bad, ROW2));
    expect(result.rejects[0].reason).toMatch(/not a number/);
    expect(result.accounts.get(ACCOUNT)).toHaveLength(1);
  });

  it('accepts the decimal comma variant', () => {
    const row = ROW1.replace('-29.00', '-1.234,56').replace(' 13230.96', ' 13.230,96');
    const [parsed] = parseBecCsv(file(HEADER, row)).accounts.get(ACCOUNT)!;
    expect(parsed.amount).toBe(-123456);
    expect(parsed.balance).toBe(1323096);
  });

  it('warns about a balance gap but still keeps the rows', () => {
    // Skip ROW2: 13230.96 - 250.00 != 13245.52
    const result = parseBecCsv(file(HEADER, ROW1, ROW3));
    expect(result.accounts.get(ACCOUNT)).toHaveLength(2);
    expect(result.warnings).toEqual([
      { account: ACCOUNT, lineNo: 3, date: '2026-08-03', expectedBalance: 1298096, actualBalance: 1324552 },
    ]);
  });

  it('checks balances per account', () => {
    const other = '"55556666777788";"";"";04-08-2026;"Rente";1.00;500.00;"";"";"";';
    const result = parseBecCsv(file(HEADER, ROW1, other, ROW2, ROW3));
    expect(result.warnings).toEqual([]);
    expect(result.accounts.get('55556666777788')).toHaveLength(1);
  });

  it('fails the whole upload on an unknown header column', () => {
    const header = HEADER.replace('"Saldo"', '"Rentedato"');
    expect(() => parseBecCsv(file(header, ROW1))).toThrow(UploadError);
    expect(() => parseBecCsv(file(header, ROW1))).toThrow(/"Rentedato"/);
  });

  it('fails the whole upload when a required column is missing', () => {
    const header = '"Exportkonto";"Dato";"Tekst";"Beløb";';
    expect(() => parseBecCsv(file(header))).toThrow(/missing required column\(s\): Saldo/);
  });

  it('fails on an empty file', () => {
    expect(() => parseBecCsv(cp1252('\r\n'))).toThrow(UploadError);
  });
});

describe('field helpers', () => {
  it('cleanField', () => {
    expect(cleanField('""EKSEMPEL""')).toBe('EKSEMPEL');
    expect(cleanField(' "Debetkort    NYX" ')).toBe('Debetkort NYX');
    expect(cleanField('"Tilskud "eksem pel" "')).toBe('Tilskud "eksem pel"');
    expect(cleanField('""')).toBe('');
  });

  it('parseAmountToOre', () => {
    expect(parseAmountToOre(' 264.56')).toBe(26456);
    expect(parseAmountToOre('-29.00')).toBe(-2900);
    expect(parseAmountToOre('-29.5')).toBe(-2950);
    expect(parseAmountToOre('1000')).toBe(100000);
    expect(parseAmountToOre('264,56')).toBe(26456);
    expect(parseAmountToOre('-1.234,56')).toBe(-123456);
    expect(parseAmountToOre('-0.00')).toBe(0);
    // No float rounding errors: 0.1 + 0.2 territory
    expect(parseAmountToOre('1234567.89')).toBe(123456789);
    expect(() => parseAmountToOre('')).toThrow();
    expect(() => parseAmountToOre('1.234.567')).toThrow();
    expect(() => parseAmountToOre('12.345')).toThrow();
  });

  it('parseDate', () => {
    expect(parseDate('03-08-2026')).toBe('2026-08-03');
    expect(parseDate('29-02-2028')).toBe('2028-02-29');
    expect(() => parseDate('29-02-2026')).toThrow();
    expect(() => parseDate('2026-08-03')).toThrow();
    expect(() => parseDate('3-8-2026')).toThrow();
  });
});
