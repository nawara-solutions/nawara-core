import { defineMessages } from '@nawara/service-kit';

/**
 * Payment's own human-readable API error messages (ADR-0054 D13, Core V1 refactor R6.5), in English, French and Arabic. The keys are
 * INTERNAL message identities, never a public `code`. Every `en` text is Payment's existing English, byte for byte (D6).
 *
 * The one parameter, `{status}`, is the payment status, a closed machine enum (`created | pending | succeeded | failed | cancelled |
 * expired`) read from Payment's own row; it is never translated (D10). Field and header names (`payer`, `seller.id`, `expiresAt`,
 * `Idempotency-Key`…) are protocol identifiers and stay verbatim. Two messages that echo a client-sent value (the currency, the provider
 * id) are deliberately NOT here: they stay English until the D10 reflection policy is decided.
 */
export const PAYMENT_MESSAGES = defineMessages({
  notFound: { en: 'Not found.', fr: 'Introuvable.', ar: 'غير موجود.' },
  operationNotPermitted: {
    en: 'You may not perform this operation.',
    fr: "Vous n'êtes pas autorisé à effectuer cette opération.",
    ar: 'لا يحق لك تنفيذ هذه العملية.',
  },
  organizationNotPermitted: {
    en: "The organization is not within the calling service's scope.",
    fr: "L'organisation ne fait pas partie du périmètre du service appelant.",
    ar: 'المنظمة ليست ضمن نطاق الخدمة المستدعية.',
  },
  idempotencyKeyRequired: {
    en: 'A valid Idempotency-Key header is required.',
    fr: 'Un en-tête Idempotency-Key valide est requis.',
    ar: 'يلزم وجود ترويسة Idempotency-Key صالحة.',
  },
  idempotencyKeyReused: {
    en: 'This Idempotency-Key was already used with a different request.',
    fr: 'Cette Idempotency-Key a déjà été utilisée pour une requête différente.',
    ar: 'استُخدمت قيمة Idempotency-Key هذه بالفعل مع طلب مختلف.',
  },
  // payments
  payerSellerMustDiffer: {
    en: 'payer and seller must differ.',
    fr: 'payer et seller doivent être différents.',
    ar: 'يجب أن يختلف payer عن seller.',
  },
  sellerIdMustBeUuid: {
    en: 'seller.id must be a uuid when seller.type is organization.',
    fr: 'seller.id doit être un uuid lorsque seller.type vaut organization.',
    ar: 'يجب أن يكون seller.id بصيغة uuid عندما تكون قيمة seller.type هي organization.',
  },
  payerIdMustBeUuid: {
    en: 'payer.id must be a uuid when payer.type is organization.',
    fr: 'payer.id doit être un uuid lorsque payer.type vaut organization.',
    ar: 'يجب أن تكون قيمة payer.id معرّف uuid عندما تكون قيمة payer.type هي organization.',
  },
  organizationIdMustEqualPayer: {
    en: 'organizationId must equal payer.id when payer.type is organization.',
    fr: 'organizationId doit être égal à payer.id lorsque payer.type vaut organization.',
    ar: 'يجب أن يساوي organizationId قيمة payer.id عندما تكون قيمة payer.type هي organization.',
  },
  organizationIdMustEqualSeller: {
    en: 'organizationId must equal seller.id when seller.type is organization.',
    fr: 'organizationId doit être égal à seller.id lorsque seller.type vaut organization.',
    ar: 'يجب أن يساوي organizationId قيمة seller.id عندما تكون قيمة seller.type هي organization.',
  },
  expiresAtInvalid: {
    en: 'expiresAt is not a valid timestamp.',
    fr: "expiresAt n'est pas un horodatage valide.",
    ar: 'قيمة expiresAt ليست طابعًا زمنيًا صالحًا.',
  },
  providerOptionsNotAccepted: {
    en: 'This provider does not accept providerOptions: a payer cannot choose a simulated outcome.',
    fr: 'Ce fournisseur n’accepte pas providerOptions : un payeur ne peut pas choisir un résultat simulé.',
    ar: 'لا يقبل هذا المزوّد providerOptions: لا يمكن للدافع اختيار نتيجة محاكاة.',
  },
  invalidSimulationCommand: {
    en: 'failureCode and delivery apply only to the outcomes that carry them.',
    fr: 'failureCode et delivery ne s’appliquent qu’aux résultats qui les comportent.',
    ar: 'لا ينطبق failureCode وdelivery إلا على النتائج التي تتضمنهما.',
  },
  simulationCommandConflict: {
    en: 'This commandId was already used for a different simulation command.',
    fr: 'Ce commandId a déjà été utilisé pour une autre commande de simulation.',
    ar: 'سبق استخدام commandId هذا لأمر محاكاة مختلف.',
  },
  simulationNothingToDeliver: {
    en: 'This simulation command produced no provider notification.',
    fr: 'Cette commande de simulation n’a produit aucune notification du fournisseur.',
    ar: 'لم ينتج أمر المحاكاة هذا أي إشعار من المزوّد.',
  },
  paymentUncertain: {
    en: 'An earlier attempt may still settle this payment; no new attempt is possible until it is resolved.',
    fr: 'Une tentative précédente peut encore régler ce paiement ; aucune nouvelle tentative n’est possible avant sa résolution.',
    ar: 'قد تؤدي محاولة سابقة إلى تسوية هذه الدفعة؛ لا يمكن إجراء محاولة جديدة قبل حسمها.',
  },
  purposeRequired: {
    en: 'purpose is required for a new payment.',
    fr: 'purpose est obligatoire pour un nouveau paiement.',
    ar: 'الحقل purpose مطلوب لعملية دفع جديدة.',
  },
  purposeNotAccepted: {
    en: 'purpose must be organization_subscription, direct_purchase, non_entitlement, assisted_settlement or recovery_settlement.',
    fr: 'purpose doit valoir organization_subscription, direct_purchase, non_entitlement, assisted_settlement ou recovery_settlement.',
    ar: 'يجب أن تكون قيمة purpose هي organization_subscription أو direct_purchase أو non_entitlement أو assisted_settlement أو recovery_settlement.',
  },
  beneficiaryRequired: {
    en: 'beneficiaryUserId is required for purpose {purpose}.',
    fr: 'beneficiaryUserId est obligatoire pour l’objet {purpose}.',
    ar: 'الحقل beneficiaryUserId مطلوب للغرض {purpose}.',
  },
  beneficiaryNotAllowed: {
    en: 'beneficiaryUserId is not allowed for purpose {purpose}.',
    fr: 'beneficiaryUserId n’est pas autorisé pour l’objet {purpose}.',
    ar: 'الحقل beneficiaryUserId غير مسموح به للغرض {purpose}.',
  },
  payerPurposeMismatch: {
    en: 'This payer cannot pay for purpose {purpose}.',
    fr: 'Ce payeur ne peut pas payer pour l’objet {purpose}.',
    ar: 'لا يمكن لهذا الدافع الدفع للغرض {purpose}.',
  },
  paymentRequestConflict: {
    en: 'A payment already exists for this paymentRequestId with a different snapshot.',
    fr: 'Un paiement existe déjà pour ce paymentRequestId avec un instantané différent.',
    ar: 'توجد بالفعل عملية دفع لقيمة paymentRequestId هذه بلقطة مختلفة.',
  },
  cannotCancelInStatus: {
    en: 'Cannot cancel a payment in status {status}.',
    fr: "Impossible d'annuler un paiement à l'état {status}.",
    ar: 'لا يمكن إلغاء عملية دفع في الحالة {status}.',
  },
  attemptStillOpen: { en: 'An attempt is still open.', fr: 'Une tentative est encore ouverte.', ar: 'لا تزال هناك محاولة مفتوحة.' },
  // attempts
  paymentExpired: { en: 'This payment has expired.', fr: 'Ce paiement a expiré.', ar: 'انتهت صلاحية عملية الدفع هذه.' },
  attemptAlreadyOpen: {
    en: 'An attempt is already open for this payment.',
    fr: 'Une tentative est déjà ouverte pour ce paiement.',
    ar: 'توجد بالفعل محاولة مفتوحة لعملية الدفع هذه.',
  },
  cannotStartAttemptInStatus: {
    en: 'Cannot start an attempt on a payment in status {status}.',
    fr: "Impossible de démarrer une tentative sur un paiement à l'état {status}.",
    ar: 'لا يمكن بدء محاولة على عملية دفع في الحالة {status}.',
  },
  amountCurrencyMismatch: {
    en: 'Provider-reported amount/currency does not match the payment snapshot.',
    fr: "Le montant ou la devise indiqués par le prestataire ne correspondent pas à l'instantané du paiement.",
    ar: 'المبلغ أو العملة التي أبلغ عنها مزوّد الدفع لا تطابق لقطة عملية الدفع.',
  },
  providerSuccessConflicts: {
    en: 'Provider success conflicts with a payment that is already {status}.',
    fr: 'Le succès signalé par le prestataire est en conflit avec un paiement déjà à l\'état {status}.',
    ar: 'يتعارض النجاح الذي أبلغ عنه مزوّد الدفع مع عملية دفع حالتها بالفعل {status}.',
  },
  lateSuccessConflicts: {
    en: 'Late success conflicts with a provider-confirmed failure.',
    fr: 'Un succès tardif est en conflit avec un échec confirmé par le prestataire.',
    ar: 'يتعارض نجاح متأخر مع فشل أكّده مزوّد الدفع.',
  },
  cannotFailSucceeded: {
    en: 'Cannot fail an attempt that already succeeded.',
    fr: "Impossible de faire échouer une tentative qui a déjà réussi.",
    ar: 'لا يمكن إفشال محاولة نجحت بالفعل.',
  },
});
