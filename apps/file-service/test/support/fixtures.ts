import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

/** A test token of the real shape (32 random bytes, base64url) and its digest, as 17.5 / 17.6 will generate them. */
export function newToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, digest: createHash('sha256').update(token).digest('hex') };
}

export const sha = () => randomBytes(32).toString('hex');

/** A valid UPLOADING `file` row; `over` replaces any column (quoted camelCase names, as in the schema). */
export function fileRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = (over.id as string | undefined) ?? randomUUID();
  return {
    id,
    ownerService: 'core-drive',
    organizationId: null,
    storageProvider: 'filesystem',
    storageKey: `files/${id}/${randomBytes(16).toString('hex')}`,
    uploadExpiresAt: new Date(Date.now() + 3_600_000),
    attachDeadline: new Date(Date.now() + 86_400_000),
    ...over,
  };
}

/** A valid download `file_access_ticket` row for `file` (same issuer and organization). */
export function downloadTicketRow(file: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    operation: 'download',
    fileId: file.id,
    issuedBy: file.ownerService,
    organizationId: file.organizationId ?? null,
    tokenDigest: newToken().digest,
    disposition: 'attachment',
    singleUse: false,
    expiresAt: new Date(Date.now() + 120_000),
    ...over,
  };
}

export function uploadTicketRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    operation: 'upload',
    issuedBy: 'core-drive',
    organizationId: null,
    tokenDigest: newToken().digest,
    maxBytes: 1_048_576,
    mediaTypes: ['application/pdf'],
    attach: true,
    singleUse: true,
    expiresAt: new Date(Date.now() + 120_000),
    ...over,
  };
}

/** One connection for a whole suite (the schema suites run hundreds of statements). */
export class Sql {
  private constructor(private readonly client: pg.Client) {}

  static async connect(url: string): Promise<Sql> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return new Sql(client);
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query(text, params)).rows as T[];
  }

  insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const cols = Object.keys(row);
    return this.query(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(row));
  }

  update(table: string, id: unknown, set: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const cols = Object.keys(set);
    return this.query(`UPDATE ${table} SET ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...Object.values(set)]);
  }

  /** The statement must fail: returns the SQLSTATE and the constraint (or trigger message), never row data. */
  async refused(text: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string; message: string }> {
    try {
      await this.client.query(text, params); // autocommit: a refused statement leaves the session usable
    } catch (e) {
      const err = e as { code?: string; constraint?: string; message: string };
      return { code: err.code, constraint: err.constraint, message: err.message };
    }
    throw new Error(`statement unexpectedly succeeded: ${text.slice(0, 160)}`);
  }

  refusedInsert(table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row);
    return this.refused(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  }

  refusedUpdate(table: string, id: unknown, set: Record<string, unknown>) {
    const cols = Object.keys(set);
    return this.refused(`UPDATE ${table} SET ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(set)]);
  }

  end(): Promise<void> {
    return this.client.end();
  }
}
