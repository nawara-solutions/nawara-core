import { Inject, Injectable } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

export interface StoredPasskey {
  credentialId: Buffer;
  publicKey: Buffer;
  signCount: number;
  transports: string[] | null;
}

export class CloneSuspected extends Error {}

/**
 * Thin, policy-fixing wrapper over @simplewebauthn/server (the protocol verification — challenge,
 * origin, RP ID hash, client-data type, authenticator data flags, signature — is done by that
 * library; nothing is hand-rolled). Policy here:
 *   - user verification REQUIRED (owners are high-privilege),
 *   - RP ID and origins come from config, never from the request,
 *   - attestation "none" (we bind to the key, not a device make/model),
 *   - the expected challenge is the single-use server-side value, never a client-supplied one,
 *   - a signature counter that fails to advance (when either side is non-zero) is treated as a
 *     possible cloned authenticator: the assertion is rejected and the caller revokes the factor.
 */
@Injectable()
export class WebAuthnService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  registrationOptions(owner: { id: string; label: string }, existing: StoredPasskey[]) {
    return generateRegistrationOptions({
      rpName: this.cfg.webauthn.rpName,
      rpID: this.cfg.webauthn.rpId,
      userName: owner.label,
      userID: new TextEncoder().encode(owner.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId.toString('base64url') })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
  }

  async verifyRegistration(response: RegistrationResponseJSON, expectedChallenge: string) {
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.cfg.webauthn.origins,
      expectedRPID: this.cfg.webauthn.rpId,
      requireUserVerification: true,
    });
    if (!v.verified) throw new Error('registration not verified');
    const c = v.registrationInfo.credential;
    return {
      credentialId: Buffer.from(c.id, 'base64url'),
      publicKey: Buffer.from(c.publicKey),
      signCount: c.counter,
      transports: c.transports ?? null,
    };
  }

  authenticationOptions(creds: StoredPasskey[]) {
    return generateAuthenticationOptions({
      rpID: this.cfg.webauthn.rpId,
      allowCredentials: creds.map((c) => ({ id: c.credentialId.toString('base64url'), transports: (c.transports ?? undefined) as any })),
      userVerification: 'required',
    });
  }

  /** Returns the new signature counter. Throws CloneSuspected / Error on any failure. */
  async verifyAssertion(response: AuthenticationResponseJSON, expectedChallenge: string, cred: StoredPasskey): Promise<number> {
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.cfg.webauthn.origins,
        expectedRPID: this.cfg.webauthn.rpId,
        requireUserVerification: true,
        credential: {
          id: cred.credentialId.toString('base64url'),
          publicKey: new Uint8Array(cred.publicKey),
          counter: cred.signCount,
          transports: (cred.transports ?? undefined) as any,
        },
      });
      if (!v.verified) throw new Error('assertion not verified');
      return v.authenticationInfo.newCounter;
    } catch (e) {
      if (/counter/i.test((e as Error).message)) throw new CloneSuspected('signature counter did not advance');
      throw e;
    }
  }
}
