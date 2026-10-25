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
      throw new Error(`Account mapping file not found: ${path}. Copy accounts.example.json there and edit it.`);
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${path} must be a JSON object like {"<bank account number>": "<Actual account name>"}.`);
  }
  for (const value of Object.values(data)) {
    if (typeof value !== 'string') throw new Error(`${path}: every value must be an Actual account name (a string).`);
  }
  return data as AccountMap;
}
