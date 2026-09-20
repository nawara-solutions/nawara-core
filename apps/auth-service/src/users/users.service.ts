import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '../db/db.service.js';

export type UserKind = 'member' | 'owner' | 'operator';

export interface UserRow {
  id: string;
  kind: UserKind;
  email: string | null;
  phone: string | null;
  passwordHash: string | null;
  /** 'admin' for owners/operators (reserved word), the neutral 'member' for members. Never a business role. */
  role: string;
  isActive: boolean;
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
export const normalizePhone = (p: string) => p.replace(/[\s()-]/g, '');
export const PHONE_RE = /^\+?[0-9]{8,15}$/;

export interface Identifier {
  email?: string;
  phone?: string;
}

/** Exactly one of email/phone, normalized; throws 400 otherwise. */
export function toIdentifier(i: Identifier): { email: string } | { phone: string } {
  const hasE = !!i.email, hasP = !!i.phone;
  if (hasE === hasP) throw new BadRequestException('Provide exactly one of email or phone.');
  if (hasE) return { email: normalizeEmail(i.email!) };
  const phone = normalizePhone(i.phone!);
  if (!PHONE_RE.test(phone)) throw new BadRequestException('Invalid phone number.');
  return { phone };
}

const COLS = `u.id, u.kind, u.email, u.phone, u."passwordHash", u.role, u."isActive"`;

@Injectable()
export class UsersService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async findByIdentifier(i: { email?: string; phone?: string }, q: Queryable = this.db): Promise<UserRow | null> {
    const id = toIdentifier(i);
    const { rows } = await q.query<UserRow>(
      `SELECT ${COLS} FROM "user" u WHERE ${'email' in id ? 'u.email = $1' : 'u.phone = $1'}`,
      ['email' in id ? id.email : id.phone],
    );
    return rows[0] ?? null;
  }

  async findById(id: string, q: Queryable = this.db): Promise<UserRow | null> {
    const { rows } = await q.query<UserRow>(`SELECT ${COLS} FROM "user" u WHERE u.id = $1`, [id]);
    return rows[0] ?? null;
  }

  /**
   * A member identity. It carries NO organization and NO business role: the relationship to each organization is an
   * OrganizationMembership row (with its own opaque `audience`). A member may have zero or more memberships
   * (owner decision 2026-09-20, migration 0009); zero memberships grants zero organization authority — every
   * organization-scoped check still derives authority live from actual ACTIVE membership rows.
   */
  async createMember(
    a: { email?: string; phone?: string; passwordHash: string },
    q: Queryable = this.db,
  ): Promise<UserRow> {
    try {
      const { rows } = await q.query<UserRow>(
        `INSERT INTO "user"(kind, email, phone, "passwordHash", role)
         VALUES ('member',$1,$2,$3,'member') RETURNING id, kind, email, phone, "passwordHash", role, "isActive"`,
        [a.email ?? null, a.phone ?? null, a.passwordHash],
      );
      return rows[0];
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('An account with these details already exists.');
      throw e;
    }
  }

  /** Owner = User(kind=owner) + Owner row in ONE transaction (the DB rejects a half-created owner). */
  async createOwner(a: { companyId: string; email?: string; phone?: string; passwordHash: string }, q: Queryable): Promise<UserRow> {
    const { rows } = await q.query<UserRow>(
      `INSERT INTO "user"(kind, email, phone, "passwordHash", role) VALUES ('owner',$1,$2,$3,'admin')
       RETURNING id, kind, email, phone, "passwordHash", role, "isActive"`,
      [a.email ?? null, a.phone ?? null, a.passwordHash],
    );
    await q.query(`INSERT INTO owner("userId","companyId") VALUES ($1,$2)`, [rows[0].id, a.companyId]);
    return rows[0];
  }

  async createOperator(a: { companyId: string; email?: string; phone?: string }, q: Queryable): Promise<UserRow> {
    try {
      const { rows } = await q.query<UserRow>(
        `INSERT INTO "user"(kind, email, phone, role) VALUES ('operator',$1,$2,'admin')
         RETURNING id, kind, email, phone, "passwordHash", role, "isActive"`,
        [a.email ?? null, a.phone ?? null],
      );
      await q.query(`INSERT INTO operator("userId","companyId") VALUES ($1,$2)`, [rows[0].id, a.companyId]);
      return rows[0];
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('An account with these details already exists.');
      throw e;
    }
  }

  async ownerCompany(ownerId: string, q: Queryable = this.db): Promise<string | null> {
    const { rows } = await q.query<{ companyId: string }>(`SELECT "companyId" FROM owner WHERE "userId"=$1`, [ownerId]);
    return rows[0]?.companyId ?? null;
  }

  async setActive(id: string, active: boolean, q: Queryable = this.db) {
    await q.query(`UPDATE "user" SET "isActive"=$2, "updatedAt"=now() WHERE id=$1`, [id, active]);
  }
}
