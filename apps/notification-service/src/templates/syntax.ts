/**
 * The whole template language (SDD §6.3): `{{name}}` interpolation, nothing else. No expressions, conditionals, loops, partials,
 * helpers, includes or whitespace inside the braces. Any other use of `{{` or `}}` is an error, so a template can never smuggle in
 * syntax that a later renderer might interpret.
 */
export const VARIABLE_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export interface ParsedTemplateText {
  /** Variable names referenced, in first-use order, without duplicates. */
  names: string[];
  errors: string[];
}

export function parsePlaceholders(text: string): ParsedTemplateText {
  const names: string[] = [];
  const errors: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (!VARIABLE_NAME.test(name)) errors.push(`invalid placeholder {{${name.slice(0, 40)}}}: only {{variableName}} is allowed`);
    else if (!names.includes(name)) names.push(name);
  }
  const rest = text.replace(PLACEHOLDER, '');
  // Leftover double braces are unbalanced or nested; triple braces are another language's raw-output syntax. Single braces are text.
  if (rest.includes('{{') || rest.includes('}}') || /\{\{\{|\}\}\}/.test(text)) errors.push('unbalanced, nested or triple {{ }}: only {{variableName}} is allowed');
  return { names, errors };
}

/** Replaces every placeholder with the value `fill(name)` gives. Used by the publish check's worst-case SMS measurement. */
export function substitute(text: string, fill: (name: string) => string): string {
  return text.replace(PLACEHOLDER, (_, name: string) => fill(name));
}
