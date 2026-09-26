import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigError } from '../config/config.js';
import { getRequestContext } from '../context/request-context.js';
import type { ServiceTokenEntry } from './service-token.js';
import type { ServiceRequest } from './service-token.guard.js';
import type { CallerRequest } from './service-or-user.guard.js';

/**
 * Stage 21.C.2 (ADR-0052 decision 1, ADR-0042 decision 2): the GENERIC mechanics of a per-target, deny-by-default service caller
 * policy. It parses the `{"callers":{…}}` envelope every Core policy uses, cross-checks it both ways against `SERVICE_TOKENS`, refuses
 * unknown and duplicate keys, and offers list helpers and an operation guard. It knows NO vocabulary: operation names, Platforms,
 * templates, products and every other dimension are the service's own (shared mechanism ≠ shared authorization policy).
 *
 * Every error names the variable, the caller (only when it is a well-formed caller name), the property path and the rule. It never
 * contains a token, a digest, a list value, the raw document or the JSON parser's own message (which can quote input).
 */

const CALLER_NAME = /^[a-z][a-z0-9-]{1,62}$/; // the SERVICE_TOKENS caller pattern

const callerLabel = (name: string) => (CALLER_NAME.test(name) ? `"${name}"` : '<invalid caller name>');

/**
 * A JSON reader that REFUSES duplicate object keys at any depth. `JSON.parse` silently keeps the last duplicate, so a policy that names
 * a caller twice would be read as whichever entry came last: a configuration mistake that could widen authority without a trace.
 * Throws a bare `Error` whose message is a fixed rule (never input); the caller turns it into a `ConfigError`.
 */
export function parseJsonStrict(text: string): unknown {
  let i = 0;
  const fail = (rule: string): never => {
    throw new Error(rule);
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const str = (): string => {
    const start = i;
    i++; // opening quote
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\\') i++;
      else if (c === '"') {
        i++;
        return JSON.parse(text.slice(start, i)) as string; // exact JSON string semantics for the one token
      } else if (c < ' ') fail('invalid JSON');
    }
    return fail('invalid JSON');
  };
  const value = (depth: number): unknown => {
    if (depth > 32) fail('JSON nested too deeply');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return { ...obj };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('invalid JSON');
        const key = str();
        if (seen.has(key)) fail('duplicate key');
        seen.add(key);
        ws();
        if (text[i] !== ':') fail('invalid JSON');
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return { ...obj };
        }
        fail('invalid JSON');
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        fail('invalid JSON');
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail('invalid JSON');
    i += m![0].length;
    return JSON.parse(m![0]) as unknown;
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail('invalid JSON');
  return v;
}

/** One caller's parsed entry, keyed by caller name. `of()` of an unknown caller is `undefined`: the caller holds nothing. */
export class CallerPolicyMap<E> {
  constructor(private readonly entries: ReadonlyMap<string, E>) {}
  of(caller: string): E | undefined {
    return this.entries.get(caller);
  }
  callers(): string[] {
    return [...this.entries.keys()];
  }
  get size(): number {
    return this.entries.size;
  }
}

export interface CallerPolicySpec<E> {
  /** The environment variable the policy comes from, for error text only (for example `PAYMENT_SERVICE_POLICY`). */
  variable: string;
  /** The entry's allowed property names; any other property is refused. */
  keys: readonly string[];
  /** The service's OWN dimension checks. `at` is a safe label to prefix its `ConfigError`s with. */
  entry(at: string, e: Record<string, unknown>): E;
}

/** The distinct caller names registered in `SERVICE_TOKENS` (a caller may hold two digests during a rotation). */
export function registeredCallers(entries: readonly ServiceTokenEntry[]): string[] {
  return [...new Set(entries.map((e) => e.caller))];
}

/**
 * Parses and validates a caller policy at STARTUP. Deny by default:
 * - no document and no registered caller: an empty policy (nothing may call);
 * - no document while callers are registered: refused (every registered caller needs an explicit entry);
 * - a registered caller with no entry, or an entry for a caller with no registered token: refused;
 * - anything malformed (JSON, envelope, unknown or duplicate key, a non-object entry): refused.
 * The entry's own dimensions are validated by `spec.entry`, which should use `policyList` / `policyChoice`.
 */
export function parseCallerPolicy<E>(raw: string | undefined, registered: readonly string[], spec: CallerPolicySpec<E>): CallerPolicyMap<E> {
  const v = spec.variable;
  if (raw === undefined || raw.trim() === '') {
    if (registered.length > 0) {
      throw new ConfigError(`${v} is required: every registered caller needs an explicit entry (deny by default): ${registered.map(callerLabel).join(', ')}`);
    }
    return new CallerPolicyMap(new Map());
  }
  let doc: unknown;
  try {
    doc = parseJsonStrict(raw);
  } catch (e) {
    const rule = e instanceof Error && e.message === 'duplicate key' ? 'must not repeat a key (a repeated key would silently replace an entry)' : 'must be valid JSON';
    throw new ConfigError(`${v} ${rule}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc) || Object.keys(doc).length !== 1 || !('callers' in doc)) {
    throw new ConfigError(`${v} must be {"callers": {...}} and nothing else`);
  }
  const callers = (doc as { callers: unknown }).callers;
  if (typeof callers !== 'object' || callers === null || Array.isArray(callers)) throw new ConfigError(`${v} must be {"callers": {...}} and nothing else`);
  const map = new Map<string, E>();
  for (const [name, entry] of Object.entries(callers as Record<string, unknown>)) {
    const at = `${v}: ${callerLabel(name)}`;
    if (!registered.includes(name)) throw new ConfigError(`${v} names ${callerLabel(name)}, which has no registered service token`);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new ConfigError(`${at} must be an object`);
    // The unknown name itself is never echoed: a mistyped key can be a pasted secret. The allowed names are listed instead.
    for (const k of Object.keys(entry)) if (!spec.keys.includes(k)) throw new ConfigError(`${at} has an unknown property (allowed: ${spec.keys.join(', ')})`);
    map.set(name, spec.entry(at, entry as Record<string, unknown>));
  }
  for (const r of registered) if (!map.has(r)) throw new ConfigError(`registered caller ${callerLabel(r)} has no ${v} entry (deny by default)`);
  return new CallerPolicyMap(map);
}

export interface PolicyListOptions {
  /** A closed vocabulary; a value outside it is refused (the message lists the vocabulary, never the value). */
  allowed?: readonly string[];
  /** A shape every value must match (for example a canonical lowercase uuid). */
  pattern?: RegExp;
  /** Whether an empty list is meaningful (for example "no Platform"). Default false: an empty list is refused. */
  allowEmpty?: boolean;
}

/** An explicit list of distinct strings: no wildcard, no duplicate, no normalization (a non-canonical value is refused, never rewritten). */
export function policyList(at: string, value: unknown, opts: PolicyListOptions = {}): ReadonlySet<string> {
  if (!Array.isArray(value)) throw new ConfigError(`${at} must be an explicit list`);
  if (value.length === 0 && !opts.allowEmpty) throw new ConfigError(`${at} must be an explicit, non-empty list`);
  for (const x of value) {
    if (typeof x !== 'string') throw new ConfigError(`${at} lists something that is not a string`);
    if (opts.allowed && !opts.allowed.includes(x)) throw new ConfigError(`${at} lists a value other than ${opts.allowed.join(' / ')}`);
    if (opts.pattern && !opts.pattern.test(x)) throw new ConfigError(`${at} lists a value of the wrong form`);
  }
  const set = new Set(value as string[]);
  if (set.size !== value.length) throw new ConfigError(`${at} lists a value twice`);
  return set;
}

/** Exactly one of a closed set of choices. */
export function policyChoice<C extends string>(at: string, value: unknown, choices: readonly C[]): C {
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) throw new ConfigError(`${at} must be ${choices.map((c) => `"${c}"`).join(' or ')}`);
  return value as C;
}

/** Provided by each service: does this authenticated service caller hold this operation? */
export interface ServiceOperationPolicy {
  allows(caller: string, operation: string): boolean;
}
export const SERVICE_OPERATION_POLICY = Symbol('SERVICE_OPERATION_POLICY');

const OPERATION_KEY = 'nawara:service-operation';
/** A value no policy can hold: routes marked with it never admit a service caller (the payer-only routes, for example). */
export const NO_SERVICE_OPERATION = '\u0000no-service-operation';

/** The operation a SERVICE caller must hold for this route. User bearers are unaffected (their object rules apply). */
export const RequireServiceOperation = (operation: string) => SetMetadata(OPERATION_KEY, operation);
/** This route admits no service caller at all, whatever its policy says. */
export const RefuseServiceCallers = () => SetMetadata(OPERATION_KEY, NO_SERVICE_OPERATION);

/** The 403 a service caller gets for an operation it does not hold. The same answer for every reason (no enumeration). */
export const operationNotPermitted = () => new HttpException({ message: 'This operation is not permitted for the calling service.', code: 'operation_not_permitted' }, 403);

/**
 * Runs AFTER `ServiceTokenGuard` or `ServiceOrUserGuard`. When the request authenticated as a SERVICE, the route's operation must be
 * held by that caller's policy; a route with no operation metadata, or marked `RefuseServiceCallers`, is refused (fail closed). A request
 * that authenticated as a USER passes through unchanged. Identity comes only from the authentication guard: no header is ever read here.
 * A denial is logged (caller, operation, correlation id: the ADR-0042 decision 9 floor); it is not audit evidence.
 */
@Injectable()
export class ServiceOperationGuard implements CanActivate {
  private readonly log = new Logger('ServiceOperationGuard');

  constructor(
    private readonly reflector: Reflector,
    @Inject(SERVICE_OPERATION_POLICY) private readonly policy: ServiceOperationPolicy,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ServiceRequest & CallerRequest>();
    const service = req.serviceCaller ?? (req.caller?.kind === 'service' ? req.caller.service : undefined);
    if (service === undefined) {
      if (req.caller?.kind === 'user') return true;
      throw operationNotPermitted(); // no authentication guard ran before this one: a wiring fault, refused
    }
    const operation = this.reflector.getAllAndOverride<string | undefined>(OPERATION_KEY, [context.getHandler(), context.getClass()]);
    if (operation !== undefined && operation !== NO_SERVICE_OPERATION && this.policy.allows(service, operation)) return true;
    const label = operation === undefined ? 'none' : operation === NO_SERVICE_OPERATION ? 'refused' : operation;
    this.log.warn(`service_operation_denied caller=${service} operation=${label} correlationId=${getRequestContext()?.correlationId ?? '-'}`);
    throw operationNotPermitted();
  }
}

/** A `ServiceOperationPolicy` over a parsed map whose entries carry an `operations` set. */
export function operationsPolicy<E extends { operations: ReadonlySet<string> }>(map: CallerPolicyMap<E>): ServiceOperationPolicy {
  return { allows: (caller, operation) => map.of(caller)?.operations.has(operation) === true };
}
