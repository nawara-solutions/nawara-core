import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { cbor } from './cbor.js';

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/**
 * A SOFTWARE WebAuthn authenticator (ES256) for tests: it produces real, cryptographically valid
 * registration and assertion responses, so the service's verification path is exercised end to end
 * — including the negative cases (wrong origin, wrong RP, bad signature, no UV, replayed counter).
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private privateKey: KeyObject;
  private x: Buffer;
  private y: Buffer;
  counter = 0;

  constructor(private readonly rpId: string, private readonly origin: string) {
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = kp.privateKey;
    const jwk = kp.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.x = Buffer.from(jwk.x, 'base64url');
    this.y = Buffer.from(jwk.y, 'base64url');
  }

  private flags(o: { uv?: boolean; at?: boolean }) {
    return 0x01 | (o.uv === false ? 0 : 0x04) | (o.at ? 0x40 : 0);
  }

  register(options: { challenge: string }, o: { uv?: boolean; origin?: string; rpId?: string } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: o.origin ?? this.origin }));
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(o.rpId ?? this.rpId), Buffer.from([this.flags({ uv: o.uv, at: true })]), counter, Buffer.alloc(16), idLen, this.credentialId, cose]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
    };
  }

  assert(options: { challenge: string }, o: { uv?: boolean; origin?: string; rpId?: string; counter?: number; badSignature?: boolean; credentialId?: Buffer } = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin ?? this.origin }));
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(o.rpId ?? this.rpId), Buffer.from([this.flags({ uv: o.uv })]), counter]);
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const signature = sign('sha256', o.badSignature ? Buffer.concat([signed, Buffer.from('x')]) : signed, { key: this.privateKey, dsaEncoding: 'der' });
    const id = b64u(o.credentialId ?? this.credentialId);
    return {
      id, rawId: id, type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) },
      clientExtensionResults: {},
    };
  }
}
