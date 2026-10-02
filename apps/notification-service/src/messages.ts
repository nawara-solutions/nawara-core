import { defineMessages } from '@nawara/service-kit';

/**
 * Notification's own human-readable API error messages (ADR-0054 D13, Core V1 refactor R6.7), in English, French and Arabic. The keys
 * are INTERNAL message identities, never a public `code`. Every `en` text, once its parameters are filled, is Notification's existing
 * English, byte for byte (D6). These are API errors only: notification CONTENT (templates, subjects, bodies, SMS text) is never here.
 *
 * Parameters are server-defined only (D10): configured limits and server counts; the channel enum (`EMAIL`, `SMS`), kept verbatim; a
 * request property NAME (never its value); a template's own variable name. A key of the caller's free-form `data` object is never a
 * parameter: its `… is invalid` element stays English (D10, deferred).
 */
export const NOTIFICATION_MESSAGES = defineMessages({
  // single messages
  idempotencyKeyRequired: {
    en: 'The Idempotency-Key header is required.',
    fr: "L'en-tête Idempotency-Key est requis.",
    ar: 'ترويسة Idempotency-Key مطلوبة.',
  },
  templateNotAllowed: {
    en: 'This caller may not use this template.',
    fr: "Cet appelant ne peut pas utiliser ce modèle.",
    ar: 'لا يحق لهذا المستدعي استخدام هذا القالب.',
  },
  channelNotAllowed: {
    en: 'This caller may not use this channel.',
    fr: 'Cet appelant ne peut pas utiliser ce canal.',
    ar: 'لا يحق لهذا المستدعي استخدام هذه القناة.',
  },
  organizationNotAllowed: {
    en: 'This caller may not address an organization.',
    fr: "Cet appelant ne peut pas s'adresser à une organisation.",
    ar: 'لا يحق لهذا المستدعي مخاطبة منظمة.',
  },
  duplicateChannel: {
    en: 'A channel is listed twice: one delivery per channel.',
    fr: 'Un canal est indiqué deux fois : une seule livraison par canal.',
    ar: 'قناة مذكورة مرتين: عملية تسليم واحدة لكل قناة.',
  },
  scheduledAtRange: {
    en: 'scheduledAt must be in the future and at most {max} s ahead.',
    fr: "scheduledAt doit être dans le futur et au plus {max} s à l'avance.",
    ar: 'يجب أن يكون scheduledAt في المستقبل وألا يتجاوز {max} ثانية مقدمًا.',
  },
  expiresAtRange: {
    en: 'expiresAt must be in the future and after scheduledAt.',
    fr: 'expiresAt doit être dans le futur et postérieur à scheduledAt.',
    ar: 'يجب أن يكون expiresAt في المستقبل وبعد scheduledAt.',
  },
  unknownTemplate: {
    en: 'No published version of this template exists for this channel.',
    fr: "Aucune version publiée de ce modèle n'existe pour ce canal.",
    ar: 'لا توجد نسخة منشورة من هذا القالب لهذه القناة.',
  },
  // invalid_destination: one complete sentence per shape (never a translated frame around the English joiner "and")
  invalidDestinationOne: {
    en: 'The {channel} destination is not valid (SMS: E.164 such as +21620000000; EMAIL: an address).',
    fr: "La destination {channel} n'est pas valide (SMS : E.164, par exemple +21620000000 ; EMAIL : une adresse).",
    ar: 'وجهة {channel} غير صالحة (SMS: بصيغة E.164 مثل +21620000000؛ EMAIL: عنوان بريد).',
  },
  invalidDestinationTwo: {
    en: 'The {first} and {second} destination is not valid (SMS: E.164 such as +21620000000; EMAIL: an address).',
    fr: "Les destinations {first} et {second} ne sont pas valides (SMS : E.164, par exemple +21620000000 ; EMAIL : une adresse).",
    ar: 'وجهتا {first} و{second} غير صالحتين (SMS: بصيغة E.164 مثل +21620000000؛ EMAIL: عنوان بريد).',
  },
  notificationNotFound: { en: 'Notification not found.', fr: 'Notification introuvable.', ar: 'الإشعار غير موجود.' },
  deliveryInProgress: {
    en: '{cancelled} pending deliveries were cancelled; {sending} already being sent cannot be recalled.',
    fr: '{cancelled} livraisons en attente ont été annulées ; {sending} déjà en cours d\'envoi ne peuvent pas être rappelées.',
    ar: 'أُلغيت {cancelled} من عمليات التسليم المعلّقة؛ ولا يمكن استرجاع {sending} قيد الإرسال بالفعل.',
  },
  idempotencyKeyReused: {
    en: 'This Idempotency-Key was already used with a different request.',
    fr: 'Cette Idempotency-Key a déjà été utilisée pour une requête différente.',
    ar: 'استُخدمت قيمة Idempotency-Key هذه بالفعل مع طلب مختلف.',
  },
  // list elements (message: string[])
  idempotencyKeyFormat: {
    en: 'Idempotency-Key: must be 8-128 characters of letters, digits and . _ : -',
    fr: 'Idempotency-Key : doit comporter de 8 à 128 caractères parmi les lettres, les chiffres et . _ : -',
    ar: 'Idempotency-Key: يجب أن تتكوّن من 8 إلى 128 حرفًا من الحروف والأرقام و . _ : -',
  },
  bodyMustBeObject: { en: 'the body must be a JSON object', fr: 'le corps doit être un objet JSON', ar: 'يجب أن يكون متن الطلب كائن JSON' },
  notAField: { en: '{name}: is not a field of this request', fr: "{name} : n'est pas un champ de cette requête", ar: '{name}: ليس حقلًا في هذا الطلب' },
  templateKey: { en: 'template: must be a template key', fr: 'template : doit être une clé de modèle', ar: 'template: يجب أن يكون مفتاح قالب' },
  organizationId: { en: 'organizationId: must be a uuid or null', fr: 'organizationId : doit être un uuid ou null', ar: 'organizationId: يجب أن يكون uuid أو null' },
  recipient: {
    en: 'recipient: must be {"type", "id"} (a lowercase type, an id of 1-128 characters)',
    fr: 'recipient : doit être {"type", "id"} (un type en minuscules, un id de 1 à 128 caractères)',
    ar: 'recipient: يجب أن يكون {"type", "id"} (نوع بأحرف صغيرة، ومعرّف من 1 إلى 128 حرفًا)',
  },
  locale: { en: 'locale: must be a BCP 47 locale', fr: 'locale : doit être une locale BCP 47', ar: 'locale: يجب أن تكون لغة بصيغة BCP 47' },
  channelsCount: {
    en: 'channels: must list 1-{max} channels',
    fr: 'channels : doit indiquer de 1 à {max} canaux',
    ar: 'channels: يجب أن تتضمن من 1 إلى {max} قنوات',
  },
  channelItem: {
    en: 'channels[{index}]: must be {"channel": {channels}, "destination": a string of 1-320 characters}',
    fr: 'channels[{index}] : doit être {"channel": {channels}, "destination": une chaîne de 1 à 320 caractères}',
    ar: 'channels[{index}]: يجب أن يكون {"channel": {channels}, "destination": سلسلة من 1 إلى 320 حرفًا}',
  },
  dataObject: { en: 'data: must be an object', fr: 'data : doit être un objet', ar: 'data: يجب أن يكون كائنًا' },
  utcDateTime: {
    en: '{field}: must be an ISO 8601 UTC date-time',
    fr: '{field} : doit être une date-heure ISO 8601 en UTC',
    ar: '{field}: يجب أن يكون تاريخًا ووقتًا بصيغة ISO 8601 بتوقيت UTC',
  },
  variableInvalid: { en: '{name}: is invalid', fr: '{name} : est invalide', ar: '{name}: غير صالح' },
});
