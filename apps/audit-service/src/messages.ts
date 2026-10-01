import { defineMessages } from '@nawara/service-kit';

/**
 * Audit's own human-readable API error messages (ADR-0054 D13, Core V1 refactor R6.1), in English, French and Arabic. The keys are
 * INTERNAL message identities, never a public `code`. Every `en` text is Audit's existing English, byte for byte (D6). Parameters are
 * values Audit defines itself (a query-parameter name that passed the allow-list, a configured bound), never submitted values (D10);
 * query-parameter names stay as they are in every language, because they are the API's own identifiers.
 */
export const AUDIT_MESSAGES = defineMessages({
  accountabilityUnavailable: {
    en: 'The query could not be recorded; no evidence is returned.',
    fr: "La requête n'a pas pu être enregistrée ; aucune preuve n'est renvoyée.",
    ar: 'تعذّر تسجيل الاستعلام؛ لم تُعَد أي أدلة.',
  },
  authorizationUnverified: {
    en: 'Authorization could not be verified; no evidence is returned.',
    fr: "L'autorisation n'a pas pu être vérifiée ; aucune preuve n'est renvoyée.",
    ar: 'تعذّر التحقق من التفويض؛ لم تُعَد أي أدلة.',
  },
  tooManyRequests: { en: 'Too many requests.', fr: 'Trop de requêtes.', ar: 'عدد كبير جدًا من الطلبات.' },
  operationNotAllowed: {
    en: 'Operation not allowed for this caller.',
    fr: "Opération non autorisée pour cet appelant.",
    ar: 'العملية غير مسموح بها لهذا المستدعي.',
  },
  ownerOnly: {
    en: 'Only a Company owner may read audit evidence here.',
    fr: "Seul le propriétaire d'une entreprise peut consulter ici les preuves d'audit.",
    ar: 'لا يمكن قراءة أدلة التدقيق هنا إلا لمالك الشركة.',
  },
  categoryNotAllowed: {
    en: 'This caller may not read that category.',
    fr: 'Cet appelant ne peut pas consulter cette catégorie.',
    ar: 'لا يُسمح لهذا المستدعي بقراءة هذه الفئة.',
  },
  sourceNotAllowed: {
    en: 'This caller may not read that source service.',
    fr: 'Cet appelant ne peut pas consulter ce service source.',
    ar: 'لا يُسمح لهذا المستدعي بقراءة خدمة المصدر هذه.',
  },
  unexpectedBody: {
    en: 'A read takes no request body.',
    fr: "Une lecture n'accepte pas de corps de requête.",
    ar: 'لا تقبل عملية القراءة نصًا في الطلب.',
  },
  // the query grammar (400): `{name}`, `{typeKey}`, `{idKey}` are the API's own parameter names
  invalidInstant: {
    en: '{name} must be a UTC instant like 2026-01-31T00:00:00Z',
    fr: '{name} doit être un instant UTC comme 2026-01-31T00:00:00Z',
    ar: 'يجب أن يكون {name} لحظة بتوقيت UTC مثل 2026-01-31T00:00:00Z',
  },
  notRealInstant: { en: '{name} is not a real instant', fr: "{name} n'est pas un instant réel", ar: '{name} ليس لحظة زمنية حقيقية' },
  pairTogether: {
    en: '{typeKey} and {idKey} go together',
    fr: '{typeKey} et {idKey} doivent être fournis ensemble',
    ar: 'يجب تقديم {typeKey} و{idKey} معًا',
  },
  pairInvalid: { en: '{typeKey} / {idKey} is not valid', fr: "{typeKey} / {idKey} n'est pas valide", ar: '{typeKey} / {idKey} غير صالح' },
  invalidQueryString: { en: 'invalid query string', fr: 'chaîne de requête invalide', ar: 'سلسلة الاستعلام غير صالحة' },
  unknownParameter: { en: 'unknown query parameter', fr: 'paramètre de requête inconnu', ar: 'معامل استعلام غير معروف' },
  givenOnce: { en: '{name} must be given once', fr: '{name} doit être fourni une seule fois', ar: 'يجب تقديم {name} مرة واحدة فقط' },
  emptyOrTooLong: { en: '{name} is empty or too long', fr: '{name} est vide ou trop long', ar: '{name} فارغ أو طويل جدًا' },
  fromToRequired: { en: 'from and to are required', fr: 'from et to sont obligatoires', ar: 'المعاملان from وto مطلوبان' },
  toAfterFrom: { en: 'to must be after from', fr: 'to doit être postérieur à from', ar: 'يجب أن يكون to بعد from' },
  windowTooLarge: {
    en: 'the time window may not exceed {days} days',
    fr: 'la fenêtre de temps ne peut pas dépasser {days} jours',
    ar: 'لا يجوز أن تتجاوز النافذة الزمنية {days} يومًا',
  },
  limitRange: {
    en: 'limit must be an integer from 1 to {max}',
    fr: 'limit doit être un entier de 1 à {max}',
    ar: 'يجب أن يكون limit عددًا صحيحًا من 1 إلى {max}',
  },
  actionNotCataloged: {
    en: 'action is not a cataloged action',
    fr: "action n'est pas une action du catalogue",
    ar: 'action ليس إجراءً مدرجًا في الكتالوج',
  },
  categoryInvalid: { en: 'category is not valid', fr: "category n'est pas valide", ar: 'category غير صالح' },
  outcomeInvalid: { en: 'outcome is not valid', fr: "outcome n'est pas valide", ar: 'outcome غير صالح' },
  sourceNotCataloged: {
    en: 'sourceService is not a cataloged producer',
    fr: "sourceService n'est pas un producteur du catalogue",
    ar: 'sourceService ليس منتجًا مدرجًا في الكتالوج',
  },
  correlationInvalid: { en: 'correlationId is not valid', fr: "correlationId n'est pas valide", ar: 'correlationId غير صالح' },
  organizationPlatformExclusive: {
    en: 'organizationId and platform are exclusive',
    fr: "organizationId et platform s'excluent mutuellement",
    ar: 'لا يمكن الجمع بين organizationId وplatform',
  },
  platformMustBeTrue: {
    en: 'platform must be true when present',
    fr: "platform doit valoir true lorsqu'il est présent",
    ar: 'يجب أن تكون قيمة platform هي true عند وجوده',
  },
  organizationIdInvalid: { en: 'organizationId is not valid', fr: "organizationId n'est pas valide", ar: 'organizationId غير صالح' },
  cursorInvalid: {
    en: 'cursor is not valid for this query',
    fr: "cursor n'est pas valide pour cette requête",
    ar: 'cursor غير صالح لهذا الاستعلام',
  },
});
