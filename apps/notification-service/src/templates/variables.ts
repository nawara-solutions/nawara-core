import { VARIABLE_NAME } from './syntax.js';

/**
 * The closed variable type system of a template version (SDD §6.2), stored in `notification_template_version.variables`.
 * `secret: true` is a flag, not a type: such a variable is sealed (Stage 16.5), never stored in `notification.data`, never logged.
 * Values are validated against this schema at intake (Stage 16.5); here only the schema itself is checked.
 */
export const VARIABLE_TYPES = ['string', 'integer', 'datetime', 'code', 'url'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export interface VariableSpec {
  type: VariableType;
  required: boolean;
  secret?: boolean;
  /** Required for `string`, `code` and `url`: every value is bounded. */
  maxLength?: number;
}
export type VariableSchema = Record<string, VariableSpec>;

const NEEDS_MAX_LENGTH: ReadonlySet<VariableType> = new Set(['string', 'code', 'url']);
/** Only a code or a free string can hold a secret (a one-time code); a date, number or link is never sealed. */
const MAY_BE_SECRET: ReadonlySet<VariableType> = new Set(['string', 'code']);
const KEYS = new Set(['type', 'required', 'secret', 'maxLength']);
export const MAX_VARIABLE_LENGTH = 2048;

export function validateVariableSchema(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['variables must be an object'];
  const errors: string[] = [];
  for (const [name, spec] of Object.entries(raw)) {
    if (!VARIABLE_NAME.test(name)) {
      errors.push(`variable name "${name.slice(0, 40)}" must match ${VARIABLE_NAME}`);
      continue;
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      errors.push(`${name}: must be an object`);
      continue;
    }
    for (const k of Object.keys(spec)) if (!KEYS.has(k)) errors.push(`${name}: unknown property "${k}"`);
    const s = spec as Record<string, unknown>;
    if (!VARIABLE_TYPES.includes(s.type as VariableType)) {
      errors.push(`${name}: type must be one of ${VARIABLE_TYPES.join(', ')}`);
      continue;
    }
    const type = s.type as VariableType;
    if (typeof s.required !== 'boolean') errors.push(`${name}: required must be true or false`);
    if (s.secret !== undefined && typeof s.secret !== 'boolean') errors.push(`${name}: secret must be true or false`);
    if (s.secret === true && !MAY_BE_SECRET.has(type)) errors.push(`${name}: a ${type} cannot be secret`);
    if (NEEDS_MAX_LENGTH.has(type)) {
      if (!Number.isInteger(s.maxLength) || (s.maxLength as number) < 1 || (s.maxLength as number) > MAX_VARIABLE_LENGTH) {
        errors.push(`${name}: a ${type} needs maxLength between 1 and ${MAX_VARIABLE_LENGTH}`);
      }
    } else if (s.maxLength !== undefined) {
      errors.push(`${name}: a ${type} takes no maxLength`);
    }
  }
  return errors;
}

/** ISO 8601 in UTC, as producers write it (`Date.prototype.toISOString`): `2026-09-24T10:05:00Z` or with milliseconds. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CODE_VALUE = /^[A-Za-z0-9]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function valueProblem(spec: VariableSpec, v: unknown): string | undefined {
  switch (spec.type) {
    case 'string':
      if (typeof v !== 'string') return 'must be a string';
      if (v.length < 1 || v.length > (spec.maxLength ?? 0)) return `must be 1-${spec.maxLength} characters`;
      if (CONTROL.test(v)) return 'must not contain control characters';
      return undefined;
    case 'code':
      if (typeof v !== 'string') return 'must be a string';
      if (v.length > (spec.maxLength ?? 0) || !CODE_VALUE.test(v)) return `must be 1-${spec.maxLength} letters or digits`;
      return undefined;
    case 'integer':
      return Number.isSafeInteger(v) ? undefined : 'must be an integer';
    case 'datetime':
      return typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19)
        ? undefined
        : 'must be an ISO 8601 UTC date-time';
    case 'url': {
      if (typeof v !== 'string' || v.length > (spec.maxLength ?? 0)) return `must be a URL of at most ${spec.maxLength} characters`;
      try {
        return new URL(v).protocol === 'https:' && !CONTROL.test(v) ? undefined : 'must be an https URL';
      } catch {
        return 'must be an https URL';
      }
    }
  }
}

/**
 * Validates template variable VALUES against a version's schema (SDD §6.2), at intake, before anything is stored: a missing required
 * variable, an unknown variable, a wrong type, an over-length value, an invalid date-time or a non-https URL is refused. Nothing is
 * coerced. Problems name the variable only, never its value (a value can be a one-time code).
 */
export function validateVariableValues(schema: VariableSchema, values: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    const v = values[name];
    if (v === undefined || v === null) {
      if (spec.required) errors.push(`${name}: is required`);
      continue;
    }
    const problem = valueProblem(spec, v);
    if (problem) errors.push(`${name}: ${problem}`);
  }
  for (const name of Object.keys(values)) if (!(name in schema)) errors.push(`${name}: is not a variable of this template`);
  return errors;
}
