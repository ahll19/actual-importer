// Checks that test/README.md documents every test, and nothing else.
// Run by CI as `npm run check:test-docs`.
//
// A test is an `it('name', ...)` call in test/*.test.ts. It counts as
// documented when test/README.md has a table row starting with | `name` |.

import { readdir, readFile } from 'node:fs/promises';

const testNames: string[] = [];
for (const name of await readdir('test')) {
  if (!name.endsWith('.test.ts')) continue;
  const source = await readFile(`test/${name}`, 'utf8');
  for (const match of source.matchAll(/\bit\(\s*(['"`])(.+?)\1/g)) testNames.push(match[2]);
}

const docs = await readFile('test/README.md', 'utf8');
const documented = [...docs.matchAll(/^\| `(.+?)` \|/gm)].map((m) => m[1]);

const problems: string[] = [];
const duplicates = testNames.filter((n, i) => testNames.indexOf(n) !== i);
for (const n of new Set(duplicates)) problems.push(`Test name used more than once: "${n}"`);
for (const n of testNames) if (!documented.includes(n)) problems.push(`Not documented in test/README.md: "${n}"`);
for (const n of documented) if (!testNames.includes(n)) problems.push(`test/README.md lists a test that doesn't exist: "${n}"`);

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`All ${testNames.length} tests are documented.`);
