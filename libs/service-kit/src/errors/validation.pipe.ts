import { HttpException, ValidationPipe, type ValidationPipeOptions } from '@nestjs/common';
import { getMetadataStorage, type ValidationError } from 'class-validator';
import { renderMessage, type LocalizedMessage, type MessageTexts } from '../i18n/catalog.js';
import { DEFAULT_LOCALE } from '../i18n/locale.js';
import { attachLocalizedMessageList, type LocalizedListItem } from './http-error.js';
import { VALIDATION_MESSAGES, eachVariant } from './validation-messages.js';

/** ADR-0054 D4: the machine code of a class-validator failure (an existing Core code; added to validation failures in R4). */
export const VALIDATION_ERROR_CODE = 'validation_error';

interface Metadata {
  propertyName: string;
  name?: string;
  type: string;
  each?: boolean;
  constraints?: readonly unknown[];
}

// class-validator's own formatting of a `$constraintN` token (`ValidationUtils.constraintToString`)
function constraintToString(c: unknown): string {
  if (Array.isArray(c)) return c.join(', ');
  if (typeof c === 'symbol') return String(c.description);
  return `${c as string}`;
}

const CATALOG = VALIDATION_MESSAGES as Readonly<Record<string, MessageTexts>>;
const EACH_CATALOG: Readonly<Record<string, MessageTexts>> = Object.freeze(
  Object.fromEntries(Object.entries(CATALOG).map(([k, t]) => [k, eachVariant(t)])),
);
// the candidates for one constraint identity: @Length has three possible messages
const VARIANTS: Readonly<Record<string, readonly string[]>> = { isLength: ['isLength.min', 'isLength.max', 'isLength.range'] };

function metadataFor(error: ValidationError, key: string): Metadata | undefined {
  const target = error.target as object | undefined;
  if (!target || typeof target.constructor !== 'function') return undefined;
  const all = getMetadataStorage().getTargetValidationMetadatas(target.constructor, '', false, false) as unknown as Metadata[];
  return all.find((m) => m.propertyName === error.property && (m.name === key || m.type === key));
}

/**
 * The catalog message for one class-validator message, or undefined to keep it English. The identity is the structured constraint
 * key; the parameters are the property name and the DTO's DECLARED constraints (never `error.value`). It is accepted only when its
 * English rendering equals what class-validator produced, byte for byte: that pins both identity and parameters.
 */
function identify(error: ValidationError, key: string, english: string, property = error.property): LocalizedMessage | undefined {
  const meta = key === 'whitelistValidation' ? undefined : metadataFor(error, key);
  const params: Record<string, string> = { property };
  (meta?.constraints ?? []).forEach((c, i) => (params[`c${i + 1}`] = constraintToString(c)));
  const catalog = meta?.each ? EACH_CATALOG : CATALOG;
  for (const id of VARIANTS[key] ?? [key]) {
    const texts = catalog[id];
    if (texts && renderMessage(texts, DEFAULT_LOCALE, params).text === english) return { texts, params };
  }
  return undefined;
}

/**
 * The kit's validation pipe (ADR-0054 D5, Core V1 refactor R4): Nest's `ValidationPipe`, same options, same message list, plus
 *   - `code: 'validation_error'` (D4);
 *   - per message, a private catalog identity so the filter can render it in `en` / `fr` / `ar`.
 * `message` stays the same `string[]`, same elements, same order: it IS Nest's own flattened list. The pipe walks the errors in
 * Nest's order to identify each element; if that walk ever disagreed with Nest's list, nothing would be localized (English, exactly
 * as Nest produced it).
 */
export class LocalizedValidationPipe extends ValidationPipe {
  constructor(options?: ValidationPipeOptions) {
    super(options);
  }

  override createExceptionFactory(): (validationErrors?: ValidationError[]) => unknown {
    const nest = super.createExceptionFactory();
    return (validationErrors: ValidationError[] = []) => {
      const original = nest(validationErrors);
      if (!(original instanceof HttpException)) return original;
      const raw = original.getResponse() as { message?: unknown };
      if (!Array.isArray(raw.message)) return original; // detailed output disabled / grouped format: Nest's answer, unchanged
      const english = raw.message as string[];
      const exception = new HttpException({ message: english, code: VALIDATION_ERROR_CODE }, original.getStatus());
      const walked = walk(validationErrors);
      if (walked.length !== english.length || walked.some((w, i) => `${w.prefix}${w.english}` !== english[i])) return exception;
      const items: (LocalizedListItem | undefined)[] = walked.map((w) => {
        // a nested property: first as its full path (`address.street must …`, the same English, natural in every language), else the
        // path kept as Nest's verbatim prefix
        const asPath = w.prefix ? identify(w.error, w.key, `${w.prefix}${w.english}`, `${w.prefix}${w.error.property}`) : undefined;
        if (asPath) return { prefix: '', message: asPath };
        const message = identify(w.error, w.key, w.english);
        return message ? { prefix: w.prefix, message } : undefined;
      });
      return attachLocalizedMessageList(exception, items);
    };
  }
}

interface Walked {
  error: ValidationError;
  key: string;
  /** class-validator's message for this constraint */
  english: string;
  /** Nest's parent-path prefix for a nested property (`parent.`), already part of today's English text */
  prefix: string;
}

/** Nest's flattening (`mapChildrenToValidationErrors` + `Object.values(constraints)`), keeping each message's identity. */
function walk(errors: readonly ValidationError[]): Walked[] {
  const out: Walked[] = [];
  const push = (error: ValidationError, prefix: string) => {
    for (const [key, english] of Object.entries(error.constraints ?? {})) out.push({ error, key, english, prefix });
  };
  const visit = (error: ValidationError, parentPath?: string): void => {
    if (!(error.children && error.children.length)) return push(error, '');
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    for (const child of error.children) {
      if (child.children && child.children.length) visit(child, path);
      push(child, `${path}.`);
    }
  };
  for (const e of errors) visit(e);
  return out;
}
