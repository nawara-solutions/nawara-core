/**
 * Core V2 S1b-2 (ADR-0057 §13.2 "Audit admission"): whether a delivered body is CANONICAL JSON, i.e. exactly the bytes the kit's own
 * publisher writes for its parsed value (`JSON.stringify` of the payload, UTF-8). Every kit publisher (the bus and the outbox relay)
 * produces such bytes. A body that is not canonical can carry bytes its parsed value never shows (a duplicate key whose first value is
 * dropped by `JSON.parse`, an invalid UTF-8 sequence, an escape or a number spelling), so a check of the parsed value says nothing
 * about them. Never throws: anything that is not canonical JSON (including non-JSON) is `false`.
 */
export function isCanonicalJsonBody(body: Uint8Array): boolean {
  try {
    const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const text = bytes.toString('utf8');
    return Buffer.from(JSON.stringify(JSON.parse(text)), 'utf8').equals(bytes);
  } catch {
    return false;
  }
}
