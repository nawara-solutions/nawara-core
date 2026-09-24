import { DATETIME_RENDERED_MAX } from '../templates/catalog.js';
import { smsSize } from '../templates/sms.js';
import { substitute } from '../templates/syntax.js';
import type { VariableSchema } from '../templates/variables.js';

/** A message ready for a provider. It exists in memory only, for one send: never stored, never logged. */
export interface RenderedMessage {
  channel: 'EMAIL' | 'SMS';
  destination: string;
  subject?: string;
  text: string;
  html?: string;
}

/** Why a pinned version and its data could not be rendered: a bounded code, never content. Terminal (`FAILED`), never retried. */
export class RenderError extends Error {
  constructor(readonly code: 'render_failed' | 'content_too_long') {
    super(code);
    this.name = 'RenderError';
  }
}

export interface PinnedVersion {
  channel: 'EMAIL' | 'SMS';
  locale: string;
  variables: VariableSchema;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  smsMaxSegments: number | null;
}

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);

/**
 * Renders the PINNED template version of a delivery (SDD §6.3): `{{name}}` interpolation only, no expression, no code. Variables are
 * HTML-escaped in the HTML part and inserted as text elsewhere; a subject never contains a line break; a datetime is formatted with
 * `Intl` for the delivery's locale in the platform time zone (D22), at most DATETIME_RENDERED_MAX characters (the publish check's
 * assumption); an SMS larger than its `smsMaxSegments` is refused (`content_too_long`), so the provider is never sent more.
 * Deterministic: the same version, values and locale give the same bytes. Values were validated at intake; any surprise here (a
 * missing variable, a corrupt value) is a `RenderError`, whose message is the code alone, never a value.
 */
export function render(v: PinnedVersion, values: Record<string, unknown>, destination: string, timeZone: string): RenderedMessage {
  const text = (name: string): string => {
    const spec = v.variables[name];
    const value = values[name];
    if (!spec) throw new RenderError('render_failed');
    if (value === undefined || value === null) {
      if (spec.required) throw new RenderError('render_failed');
      return '';
    }
    if (spec.type === 'datetime') {
      if (typeof value !== 'string') throw new RenderError('render_failed');
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw new RenderError('render_failed');
      const formatted = new Intl.DateTimeFormat(v.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(d);
      if (formatted.length > DATETIME_RENDERED_MAX) throw new RenderError('render_failed');
      return formatted;
    }
    if (spec.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new RenderError('render_failed');
      return String(value);
    }
    if (typeof value !== 'string') throw new RenderError('render_failed');
    if (spec.maxLength !== undefined && value.length > spec.maxLength) throw new RenderError('render_failed');
    if (spec.type === 'url' && !value.startsWith('https://')) throw new RenderError('render_failed'); // https only (SDD §6.2)
    return value;
  };
  const subject = v.subject === null ? undefined : substitute(v.subject, text);
  if (subject !== undefined && /[\r\n]/.test(subject)) throw new RenderError('render_failed'); // no header injection
  const body = substitute(v.bodyText, text);
  const html = v.bodyHtml === null ? undefined : substitute(v.bodyHtml, (n) => escapeHtml(text(n)));
  if (v.channel === 'SMS' && smsSize(body).segments > (v.smsMaxSegments ?? 1)) throw new RenderError('content_too_long');
  return { channel: v.channel, destination, subject, text: body, html };
}
