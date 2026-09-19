import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (dir: string, ext: string) =>
  readdirSync(new URL(dir, import.meta.url))
    .filter((f) => f.endsWith(ext) && !f.endsWith('.spec.ts'))
    .map((f) => ({ file: f, text: readFileSync(fileURLToPath(new URL(`${dir}${f}`, import.meta.url)), 'utf8') }));

/** Strips comments so a sentence saying "never a float" is not mistaken for using one. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/--.*$/gm, '');

describe('no floating point touches an amount (BI-01, ADR-0036)', () => {
  it('the domain and persistence source never parses, rounds or formats a number as a float', () => {
    const banned = [/parseFloat/, /\.toFixed\(/, /Math\.(round|floor|ceil|trunc|fround)\(/, /\bparseInt\(/, /Number\.parse/];
    for (const dir of ['./', '../invoices/']) {
      for (const { file, text } of read(dir, '.ts')) for (const re of banned) expect(re.test(code(text)), `${file} matches ${re}`).toBe(false);
    }
  });

  it('every Number(...) on an amount is the JSON output of an already range-checked bigint or a database integer string', () => {
    const allowed = new Set(['money.ts', 'billing-events.ts']);
    for (const dir of ['./', '../invoices/']) {
      for (const { file, text } of read(dir, '.ts')) if (!allowed.has(file)) expect(/\bNumber\(/.test(code(text)), `${file} calls Number(...)`).toBe(false);
    }
  });

  it('no migration declares a floating-point or money column type; numeric appears only as an exact, scale-free cast or PL/pgSQL local (overflow-safe sums), never as a column', () => {
    const migrations = read('../../db/migrations/', '.sql');
    expect(migrations.length).toBeGreaterThanOrEqual(8);
    for (const { file, text } of migrations) {
      const sql = code(text);
      expect(/\b(real|double precision|float4|float8|float|money|smallmoney)\b/i.test(sql), `${file} declares a float or money type`).toBe(false);
      for (const m of sql.matchAll(/\bnumeric\b[^\n]*/gi)) expect(m[0], `${file}: numeric outside a cast`).toMatch(/::numeric|^numeric;$/); // `numeric` with no scale is exact arbitrary-precision INTEGER arithmetic here
    }
  });
});
