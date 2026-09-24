import { randomBytes } from 'node:crypto';

/** The key grammar every adapter enforces (SDD §6): lowercase letters, digits, `-` and `/`, at most 200 characters. */
export const STORAGE_KEY_GRAMMAR = /^[a-z0-9/-]{1,200}$/;
/** A key prefix: one or more `/`-separated segments of the grammar, no empty segment, no leading or trailing `/`. */
const PREFIX = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A prefix leaves room for `/<36-char fileId>/<32 hex>` (70 characters) within the grammar's 200. */
export const STORAGE_KEY_PREFIX_MAX = 130;

/**
 * The storage key of a new file (SDD §6, F30): `<prefix>/<fileId>/<16 random bytes, hex>`. Server-generated from the server's own
 * values only: the configured prefix and the file id the server generated. No filename, type, organization or caller input goes in, so
 * a key can neither traverse a path nor leak anything through a listing or a log, and knowing it grants nothing. The random part
 * keeps keys unguessable and unique even if a prefix is ever shared.
 */
export function newStorageKey(prefix: string, fileId: string): string {
  if (!PREFIX.test(prefix) || prefix.length > STORAGE_KEY_PREFIX_MAX) throw new Error('storage key prefix is not in the key grammar');
  if (!UUID.test(fileId)) throw new Error('file id is not a lowercase UUID');
  return `${prefix}/${fileId}/${randomBytes(16).toString('hex')}`;
}

/** True for a key this service could have generated (the adapters re-check the grammar before any storage call, 17.4). */
export function isStorageKey(key: string): boolean {
  return STORAGE_KEY_GRAMMAR.test(key) && /^[a-z0-9-]+(\/[a-z0-9-]+)*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{32}$/.test(key);
}
