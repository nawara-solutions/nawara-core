import { defineMessages, type MessageTexts } from '../i18n/catalog.js';
import { SUPPORTED_LOCALES } from '../i18n/locale.js';

/**
 * ADR-0054 D5 / D13 (Core V1 refactor R4): the class-validator constraint messages, owned by the kit. The keys are class-validator's
 * constraint identities (the `constraints` keys of a `ValidationError`), plus a variant suffix where class-validator chooses between
 * several messages. They are INTERNAL identities: never a public code.
 *
 * Each `en` text is class-validator 0.15's default message with `$property` → `{property}` and `$constraintN` → `{cN}`, byte for byte
 * (D6): the validation pipe localizes an element only when this English rendering equals the message class-validator actually
 * produced, so a custom message, a new class-validator wording or an unknown validator simply stays English.
 * Parameters are the property name (already echoed today, D10) and the DTO's own declared constraints; never the submitted value.
 */
export const VALIDATION_MESSAGES = defineMessages({
  isString: { en: '{property} must be a string', fr: '{property} doit être une chaîne de caractères', ar: 'يجب أن يكون {property} سلسلة نصية' },
  isInt: { en: '{property} must be an integer number', fr: '{property} doit être un nombre entier', ar: 'يجب أن يكون {property} عددًا صحيحًا' },
  isBoolean: { en: '{property} must be a boolean value', fr: '{property} doit être une valeur booléenne', ar: 'يجب أن يكون {property} قيمة منطقية' },
  isObject: { en: '{property} must be an object', fr: '{property} doit être un objet', ar: 'يجب أن يكون {property} كائنًا' },
  isArray: { en: '{property} must be an array', fr: '{property} doit être un tableau', ar: 'يجب أن يكون {property} مصفوفة' },
  isUuid: { en: '{property} must be a UUID', fr: '{property} doit être un UUID', ar: 'يجب أن يكون {property} معرّفًا من نوع UUID' },
  isUrl: { en: '{property} must be a URL address', fr: '{property} doit être une adresse URL', ar: 'يجب أن يكون {property} عنوان URL' },
  isEmail: { en: '{property} must be an email', fr: '{property} doit être une adresse e-mail', ar: 'يجب أن يكون {property} عنوان بريد إلكتروني' },
  isIn: {
    en: '{property} must be one of the following values: {c1}',
    fr: "{property} doit être l'une des valeurs suivantes : {c1}",
    ar: 'يجب أن يكون {property} إحدى القيم التالية: {c1}',
  },
  matches: {
    en: '{property} must match {c1} regular expression',
    fr: "{property} doit correspondre à l'expression régulière {c1}",
    ar: 'يجب أن يطابق {property} التعبير النمطي {c1}',
  },
  min: { en: '{property} must not be less than {c1}', fr: '{property} ne doit pas être inférieur à {c1}', ar: 'يجب ألا يقل {property} عن {c1}' },
  max: { en: '{property} must not be greater than {c1}', fr: '{property} ne doit pas être supérieur à {c1}', ar: 'يجب ألا يزيد {property} عن {c1}' },
  minLength: {
    en: '{property} must be longer than or equal to {c1} characters',
    fr: '{property} doit contenir au moins {c1} caractères',
    ar: 'يجب ألا يقل طول {property} عن {c1} حرفًا',
  },
  maxLength: {
    en: '{property} must be shorter than or equal to {c1} characters',
    fr: '{property} doit contenir au plus {c1} caractères',
    ar: 'يجب ألا يزيد طول {property} عن {c1} حرفًا',
  },
  // @Length chooses between three messages
  'isLength.min': {
    en: '{property} must be longer than or equal to {c1} characters',
    fr: '{property} doit contenir au moins {c1} caractères',
    ar: 'يجب ألا يقل طول {property} عن {c1} حرفًا',
  },
  'isLength.max': {
    en: '{property} must be shorter than or equal to {c2} characters',
    fr: '{property} doit contenir au plus {c2} caractères',
    ar: 'يجب ألا يزيد طول {property} عن {c2} حرفًا',
  },
  'isLength.range': {
    en: '{property} must be longer than or equal to {c1} and shorter than or equal to {c2} characters',
    fr: '{property} doit contenir entre {c1} et {c2} caractères',
    ar: 'يجب أن يكون طول {property} بين {c1} و{c2} حرفًا',
  },
  arrayNotEmpty: { en: '{property} should not be empty', fr: '{property} ne doit pas être vide', ar: 'يجب ألا يكون {property} فارغًا' },
  arrayMaxSize: {
    en: '{property} must contain no more than {c1} elements',
    fr: '{property} doit contenir au plus {c1} éléments',
    ar: 'يجب ألا يحتوي {property} على أكثر من {c1} عناصر',
  },
  // emitted by class-validator itself (forbidNonWhitelisted, @ValidateNested): no parameter but the property name
  whitelistValidation: { en: 'property {property} should not exist', fr: 'la propriété {property} ne doit pas être présente', ar: 'يجب ألا تكون الخاصية {property} موجودة' },
  nestedValidation: {
    en: 'nested property {property} must be either object or array',
    fr: 'la propriété imbriquée {property} doit être un objet ou un tableau',
    ar: 'يجب أن تكون الخاصية المتداخلة {property} كائنًا أو مصفوفة',
  },
});

/** class-validator's `{ each: true }` prefix ("each value in "), as a phrase wrapping the property. */
export const EACH_VALUE_IN: MessageTexts = Object.freeze({ en: 'each value in {property}', fr: 'chaque valeur de {property}', ar: 'كل قيمة في {property}' });

/**
 * The `{ each: true }` variant of a message: `{property}` becomes "each value in {property}" in every language. For the messages whose
 * English does not START with the property (whitelist, nested) this does not reproduce class-validator's text, so the English check
 * fails and those elements stay English: a safe fallback, never a wrong translation.
 */
export function eachVariant(texts: MessageTexts): MessageTexts {
  const out = {} as Record<(typeof SUPPORTED_LOCALES)[number], string>;
  for (const l of SUPPORTED_LOCALES) out[l] = texts[l].replace('{property}', EACH_VALUE_IN[l]);
  return Object.freeze(out);
}
