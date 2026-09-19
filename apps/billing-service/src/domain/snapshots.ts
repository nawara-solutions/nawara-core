/**
 * The historical snapshots an invoice carries (SDD section 9, BI-20). Their job is to preserve who the parties were and how the invoice
 * was presented; they are HISTORY, never authority (the typed ids stay the authority) and never hold an amount.
 */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const MAX_SNAPSHOT_BYTES = 8192;
export const SYSTEM_TEMPLATE_V1 = 'system:1'; // the built-in default presentation, frozen in code (SDD 36.3)

const MAX_DEPTH = 3;
const MAX_STRING = 512;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type PartySnapshot = { schemaVersion: number } & Record<string, unknown>;

/**
 * Party snapshots (issuer and bill-to). The CONTENT is B-007 and is not decided: this fixes only the container. A plain JSON object with an
 * integer `schemaVersion`, at most 8 KB, nested at most 3 levels, whose leaves are bounded STRINGS (opaque, never interpreted; a number
 * here could be mistaken for a financial value). No arrays, no prototype-polluting keys, no NUL character (jsonb refuses it).
 */
export function validatePartySnapshot(input: unknown, field: string): PartySnapshot {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new SnapshotError(`${field} must be a JSON object`);
  const obj = input as Record<string, unknown>;
  if (!Number.isInteger(obj.schemaVersion) || (obj.schemaVersion as number) < 1) throw new SnapshotError(`${field}.schemaVersion must be a positive integer`);
  for (const [k, v] of Object.entries(obj)) if (k !== 'schemaVersion') walk(v, k, 1, field);
  if (Buffer.byteLength(JSON.stringify(obj), 'utf8') > MAX_SNAPSHOT_BYTES) throw new SnapshotError(`${field} exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  return obj as PartySnapshot;
}

function walk(value: unknown, path: string, depth: number, field: string): void {
  if (FORBIDDEN_KEYS.has(path.split('.').pop() as string)) throw new SnapshotError(`${field}.${path} is not an allowed key`);
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) throw new SnapshotError(`${field}.${path} is longer than ${MAX_STRING} characters`);
    if (value.includes('\u0000')) throw new SnapshotError(`${field}.${path} contains a NUL character`);
    return;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (depth >= MAX_DEPTH) throw new SnapshotError(`${field}.${path} is nested too deeply`);
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) throw new SnapshotError(`${field}.${path}.${k} is not an allowed key`);
      walk(v, `${path}.${k}`, depth + 1, field);
    }
    return;
  }
  throw new SnapshotError(`${field}.${path} must be a string or an object of strings`);
}

const TEMPLATE_REF = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

export interface PresentationSnapshot {
  schemaVersion: 1;
  template: string;
  locale: string;
}

/**
 * The presentation snapshot: WHICH immutable presentation definition and locale the invoice was issued with, and nothing else. Version 1
 * has exactly these three keys, so it can hold no amount, no markup and no executable content. It names a template; it is not one.
 */
export function buildPresentationSnapshot(input: { template: string; locale: string }): PresentationSnapshot {
  if (typeof input.template !== 'string' || !TEMPLATE_REF.test(input.template)) throw new SnapshotError('template must be an identifier such as system:1');
  if (typeof input.locale !== 'string' || !LOCALE.test(input.locale)) throw new SnapshotError('locale must be a language tag such as fr or ar-TN');
  return { schemaVersion: 1, template: input.template, locale: input.locale };
}
