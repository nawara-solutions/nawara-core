import bcrypt from 'bcryptjs';
import { BadRequestException, Injectable } from '@nestjs/common';

/**
 * Password hashing: bcrypt (pure-JS `bcryptjs`), cost from config (default 12, ~250 ms), salt
 * generated per hash by the library. bcrypt only reads the first 72 BYTES, so longer inputs are
 * rejected rather than silently truncated.
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_BYTES = 72;

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || Buffer.byteLength(password) > MAX_PASSWORD_BYTES || password.includes('\0')) {
    throw new BadRequestException(
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_BYTES} bytes long.`,
    );
  }
}

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;
  constructor(private readonly cost: number) {}

  async hash(password: string): Promise<string> {
    assertPasswordPolicy(password);
    return bcrypt.hash(password, this.cost);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false;
    // Unknown account / no password: burn the same bcrypt work so response time does not reveal
    // whether an identifier exists.
    this.dummyHash ??= bcrypt.hash('nawara-dummy-password', this.cost);
    const ok = await bcrypt.compare(password, hash ?? (await this.dummyHash));
    return hash ? ok : false;
  }
}
