import iconv from 'iconv-lite';

/** Encode test input the way the bank does: Windows-1252 bytes. */
export function cp1252(text: string): Buffer {
  return iconv.encode(text, 'win1252');
}

export const HEADER =
  '"Exportkonto";"Afsenderkonto";"Modtagerkonto";"Dato";"Tekst";"Beløb";"Saldo";"Indbetaler";"Supp. tekst til modtager";"Tekst til modtager";';

// Fake account numbers, same as the spec examples.
export const ROW1 =
  '"11112222333344";"11112222333344";"";03-08-2026;"Debetkort    ABC*Testbutik";-29.00; 13230.96;"";"Forretning: ABC*Testbutik By .......: Testby";"";';
export const ROW2 =
  '"11112222333344";"";"11112222333344";03-08-2026;""EKSEMPEL""; 264.56; 13495.52;"EKSEMPELFORENINGEN, ÆBLEVEJ 5 1234 TESTRUP Ø ";"Tilskud fra Eksempelforeningen "eksem pel" ";"";';
export const ROW3 =
  '"11112222333344";"11112222333344";"55556666777788";03-08-2026;"Til Ønskeopsparing p";-250.00; 13245.52;"Test Person Testvej 1 1234 Testrup ";"";"Fra Testkonto";';

export function file(...lines: string[]): Buffer {
  return cp1252(lines.join('\r\n') + '\r\n');
}
