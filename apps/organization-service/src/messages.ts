import { defineMessages } from '@nawara/service-kit';

/**
 * Organization's own human-readable API error messages (ADR-0054 D13, Core V1 refactor R6.2), in English, French and Arabic. The keys
 * are INTERNAL message identities, never a public `code`. Every `en` text is Organization's existing English, byte for byte (D6).
 *
 * Parameters (D10):
 *   - `{name}` / `{max}`: a field or query-parameter name Organization defines itself, or a configured bound;
 *   - `{phase}`: the ownership phase, a closed machine enum (`OWNERSHIP_PHASES`), never translated;
 *   - `unknownField`'s `{name}` is the one client-derived value: the name of a body property the client sent, inserted verbatim (the
 *     class-validator property-name echo D10 allows; never a value). The unknown QUERY key message is deliberately not here (D10 deferred).
 */
export const ORGANIZATION_MESSAGES = defineMessages({
  notFound: { en: 'Not found.', fr: 'Introuvable.', ar: 'غير موجود.' },
  forbidden: { en: 'Forbidden.', fr: 'Accès refusé.', ar: 'الوصول مرفوض.' },
  stepUpRequired: {
    en: 'A fresh step-up is required for this operation.',
    fr: 'Une nouvelle vérification renforcée est requise pour cette opération.',
    ar: 'يلزم إجراء تحقق إضافي جديد لتنفيذ هذه العملية.',
  },
  notAuthorizedCreatePlatform: {
    en: 'Not authorized to create a platform for this company.',
    fr: 'Non autorisé à créer une plateforme pour cette entreprise.',
    ar: 'غير مصرح بإنشاء منصة لهذه الشركة.',
  },
  notAuthorizedUpdatePlatform: {
    en: 'Not authorized to update this platform.',
    fr: 'Non autorisé à modifier cette plateforme.',
    ar: 'غير مصرح بتعديل هذه المنصة.',
  },
  notAuthorizedCreateOrganization: {
    en: 'Not authorized to create an organization on this platform.',
    fr: 'Non autorisé à créer une organisation sur cette plateforme.',
    ar: 'غير مصرح بإنشاء مؤسسة على هذه المنصة.',
  },
  notAuthorizedUpdateOrganization: {
    en: 'Not authorized to update this organization.',
    fr: 'Non autorisé à modifier cette organisation.',
    ar: 'غير مصرح بتعديل هذه المؤسسة.',
  },
  ownershipNotInitialised: {
    en: 'The ownership state is not initialised.',
    fr: "L'état de propriété n'est pas initialisé.",
    ar: 'لم تتم تهيئة حالة الملكية.',
  },
  notAuthoritativeReads: {
    en: 'organization-service is not authoritative yet (phase {phase}).',
    fr: "organization-service ne fait pas encore autorité (phase {phase}).",
    ar: 'لا تُعدّ organization-service مرجعية بعد (المرحلة {phase}).',
  },
  notAuthoritativeWrites: {
    en: 'organization-service is not authoritative yet (phase {phase}): hierarchy writes are refused.',
    fr: "organization-service ne fait pas encore autorité (phase {phase}) : les écritures de la hiérarchie sont refusées.",
    ar: 'لا تُعدّ organization-service مرجعية بعد (المرحلة {phase}): تُرفض عمليات الكتابة على الهيكل التنظيمي.',
  },
  idempotencyKeyRequired: {
    en: 'A valid Idempotency-Key header (8 to 128 characters of A-Z a-z 0-9 . _ : -) is required.',
    fr: "Un en-tête Idempotency-Key valide (8 à 128 caractères parmi A-Z a-z 0-9 . _ : -) est requis.",
    ar: 'يلزم ترويسة Idempotency-Key صالحة (من 8 إلى 128 حرفًا من A-Z a-z 0-9 . _ : -).',
  },
  idempotencyKeyReused: {
    en: 'This Idempotency-Key was already used with a different request.',
    fr: 'Cette Idempotency-Key a déjà été utilisée avec une autre requête.',
    ar: 'تم استخدام مفتاح Idempotency-Key هذا من قبل مع طلب مختلف.',
  },
  noSuchPlatform: { en: 'No such platform.', fr: 'Plateforme inexistante.', ar: 'المنصة غير موجودة.' },
  noSuchCompany: { en: 'No such company.', fr: 'Entreprise inexistante.', ar: 'الشركة غير موجودة.' },
  // pagination and request-body grammar (400)
  cursorInvalid: { en: 'cursor is not valid', fr: "cursor n'est pas valide", ar: 'cursor غير صالح' },
  limitRange: {
    en: 'limit must be an integer from 1 to {max}',
    fr: 'limit doit être un entier de 1 à {max}',
    ar: 'يجب أن يكون limit عددًا صحيحًا من 1 إلى {max}',
  },
  givenOnce: { en: '{name} must be given once', fr: '{name} doit être fourni une seule fois', ar: 'يجب تقديم {name} مرة واحدة فقط' },
  mustBeUuid: { en: '{name} must be a uuid', fr: '{name} doit être un uuid', ar: 'يجب أن يكون {name} معرّفًا من نوع uuid' },
  bodyMustBeObject: {
    en: 'the request body must be a JSON object',
    fr: 'le corps de la requête doit être un objet JSON',
    ar: 'يجب أن يكون نص الطلب كائن JSON',
  },
  cannotBeChanged: { en: '{name} cannot be changed', fr: '{name} ne peut pas être modifié', ar: 'لا يمكن تغيير {name}' },
  unknownField: { en: 'unknown field: {name}', fr: 'champ inconnu : {name}', ar: 'حقل غير معروف: {name}' },
  textLength: {
    en: '{name} must be 1 to {max} characters',
    fr: '{name} doit contenir de 1 à {max} caractères',
    ar: 'يجب أن يحتوي {name} على 1 إلى {max} حرفًا',
  },
  atLeastOneField: {
    en: 'at least one field must be provided',
    fr: 'au moins un champ doit être fourni',
    ar: 'يجب تقديم حقل واحد على الأقل',
  },
});
