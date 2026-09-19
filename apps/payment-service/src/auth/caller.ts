import type { AuthIdentity } from '@nawara/service-kit';

/** Who is making the request: a service (identified by its token) or an end user (identified live by Auth). */
export type Caller = { kind: 'service'; service: string } | { kind: 'user'; identity: AuthIdentity };
