// Loads accounts.json: bank account number (Exportkonto) -> Actual account name.
// Read fresh for every operation, so editing the file needs no restart.

import { readFile } from 'node:fs/promises';

export type AccountMap = Record<string, string>;

export async function loadAccountMap(path: string): Promise<AccountMap> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Kontofilen findes ikke: ${path}. Kopiér accounts.example.json dertil og ret den til.`);
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} er ikke gyldig JSON.`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${path} skal være et JSON-objekt som {"<bankkontonummer>": "<navn på Actual-konto>"}.`);
  }
  for (const value of Object.values(data)) {
    if (typeof value !== 'string') throw new Error(`${path}: hver værdi skal være navnet på en Actual-konto (en tekst).`);
  }
  return data as AccountMap;
}
