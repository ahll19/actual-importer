import { describe, expect, it } from 'vitest';
import { importedId, toActualTransaction } from '../src/mapping.js';
import { parseBecCsv } from '../src/parser.js';
import { file, HEADER, ROW1, ROW2, ROW3 } from './helpers.js';

const ACCOUNT = '11112222333344';

describe('toActualTransaction', () => {
  it('maps a row to an Actual transaction', () => {
    const [, row2] = parseBecCsv(file(HEADER, ROW1, ROW2)).accounts.get(ACCOUNT)!;
    expect(toActualTransaction(row2)).toEqual({
      date: '2026-08-03',
      amount: 26456,
      payee_name: 'EKSEMPEL',
      imported_payee: 'EKSEMPEL',
      notes: 'EKSEMPELFORENINGEN, ÆBLEVEJ 5 1234 TESTRUP Ø | Tilskud fra Eksempelforeningen "eksem pel"',
      imported_id: importedId(row2),
      cleared: true,
    });
  });

  it('joins only non-empty note fields', () => {
    const [row1, , row3] = parseBecCsv(file(HEADER, ROW1, ROW2, ROW3)).accounts.get(ACCOUNT)!;
    expect(toActualTransaction(row1).notes).toBe('Forretning: ABC*Testbutik By .......: Testby');
    expect(toActualTransaction(row3).notes).toBe('Test Person Testvej 1 1234 Testrup | Fra Testkonto');
  });

  it('leaves notes out when there are none', () => {
    const row = '"11112222333344";"";"";05-08-2026;"Rema 1000";-112.25;12900.00;"";"";"";';
    const [parsed] = parseBecCsv(file(HEADER, row)).accounts.get(ACCOUNT)!;
    expect(toActualTransaction(parsed).notes).toBeUndefined();
  });
});

describe('importedId', () => {
  it('has the documented shape', () => {
    const [row] = parseBecCsv(file(HEADER, ROW1)).accounts.get(ACCOUNT)!;
    expect(importedId(row)).toMatch(/^bec-[0-9a-f]{32}$/);
  });

  it('gives identical same-day purchases different ids', () => {
    const coffee1 = '"11112222333344";"";"";05-08-2026;"Kaffe";-30.00;970.00;"";"";"";';
    const coffee2 = '"11112222333344";"";"";05-08-2026;"Kaffe";-30.00;940.00;"";"";"";';
    const [a, b] = parseBecCsv(file(HEADER, coffee1, coffee2)).accounts.get(ACCOUNT)!;
    expect(importedId(a)).not.toBe(importedId(b));
  });

  it('gives the same row the same id when exported again', () => {
    const first = parseBecCsv(file(HEADER, ROW1, ROW2)).accounts.get(ACCOUNT)!;
    // A later, overlapping export: different line numbers, no header row.
    const second = parseBecCsv(file(ROW2, ROW3)).accounts.get(ACCOUNT)!;
    expect(importedId(second[0])).toBe(importedId(first[1]));
  });
});
