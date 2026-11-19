/**
 * Structural confidentiality check of a stored audit record: every value of the record (every string or number leaf, at any depth, `changes` included,
 * and every key) is searched for each private value, EXCEPT the identifier fields the audit contract defines as generated identifiers. Those are not
 * searched: each must instead match its own grammar exactly (a UUID, a decimal sequence id, an ISO-8601 UTC timestamp), so a field the contract keeps
 * for an identifier can never carry free text. A serialized whole-record substring search is not used: a short private value (a build number) can
 * occur by chance inside a random UUID or a growing sequence id, which is a false positive, not a leak.
 */
export type IdentifierGrammar = 'uuid' | 'integer' | 'timestamp';

const GRAMMAR: Record<IdentifierGrammar, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  integer: /^[0-9]{1,19}$/,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/,
};

/** The generated identifier fields of an `audit_record` row (ADR-0049; the audit-service record columns), by path. */
export const AUDIT_RECORD_IDENTIFIERS: Readonly<Record<string, IdentifierGrammar>> = {
  id: 'integer', eventId: 'uuid', resourceId: 'uuid', subjectId: 'uuid', organizationId: 'uuid', companyId: 'uuid', platformId: 'uuid',
  causationId: 'uuid', approvedByUserId: 'uuid', occurredAt: 'timestamp', recordedAt: 'timestamp',
};

/**
 * The violations of `record` against `privateValues` (empty when it leaks nothing). `identifiers` maps a dotted path (`changes.product_id`) to the
 * grammar of a generated identifier the contract places there; a null identifier is fine. Dates are compared as their JSON (ISO) form.
 */
export function privateValueLeaks(record: unknown, privateValues: readonly string[], identifiers: Readonly<Record<string, IdentifierGrammar>>): string[] {
  const values = privateValues.filter((v) => v.length > 0);
  if (values.length !== privateValues.length) throw new Error('privateValueLeaks: an empty private value matches everything');
  const out: string[] = [];
  const search = (path: string, text: string) => {
    for (const v of values) if (text.includes(v)) out.push(`${path} contains a private value`);
  };
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        search(`${p} (key)`, k);
        walk(v, p);
      }
      return;
    }
    const text = String(node);
    const grammar = identifiers[path];
    if (grammar) {
      if (!GRAMMAR[grammar].test(text)) out.push(`${path} does not match the ${grammar} grammar`);
      return;
    }
    search(path, text);
  };
  walk(JSON.parse(JSON.stringify(record)), '');
  return out;
}
