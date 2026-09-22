import type { Caller as AuthCaller } from '@nawara/service-kit';
import type { Caller as DomainCaller } from '../domain/actors.js';

/**
 * Maps the guard's `Caller` (which carries the full `AuthIdentity` from the kit) to the domain layer's `Caller` (which
 * carries only `userId`). The domain layer (relations, repositories) deliberately does not depend on `AuthIdentity`: it
 * needs to know WHO is calling, never anything else Auth knows about them.
 */
export function toDomainCaller(caller: AuthCaller): DomainCaller {
  return caller.kind === 'service' ? { kind: 'service', service: caller.service } : { kind: 'user', userId: caller.identity.id };
}
