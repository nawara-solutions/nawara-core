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
  // Core V2 S6b refunds (register PAY-07, PAY-08)
  invalidRefundRequest: {
    en: 'The refund request is malformed.',
    fr: 'La demande de remboursement est mal formée.',
    ar: 'طلب الاسترداد غير صحيح البنية.',
  },
  paymentNotRefundable: {
    en: 'This payment cannot be refunded.',
    fr: 'Ce paiement ne peut pas être remboursé.',
    ar: 'لا يمكن استرداد عملية الدفع هذه.',
  },
  refundCaptureUnverified: {
    en: 'This payment has no verified capture to refund.',
    fr: "Ce paiement n'a pas de capture vérifiée à rembourser.",
    ar: 'لا توجد لعملية الدفع هذه عملية تحصيل موثّقة يمكن استردادها.',
  },
  refundCaptureNotEligible: {
    en: 'This captured payment cannot be refunded on its own: it is the last capture backing the sale.',
    fr: "Cette capture ne peut pas être remboursée seule : c'est la dernière capture qui couvre la vente.",
    ar: 'لا يمكن استرداد عملية التحصيل هذه بمفردها: إنها آخر عملية تحصيل تغطي عملية البيع.',
  },
  captureNotFound: {
    en: 'No verified capture of this payment has this identifier.',
    fr: "Aucune capture vérifiée de ce paiement ne porte cet identifiant.",
    ar: 'لا توجد عملية تحصيل موثّقة لعملية الدفع هذه بهذا المعرّف.',
  },
  refundAmountNotFull: {
    en: 'Only a full refund of the captured amount, in its currency, is supported.',
    fr: 'Seul un remboursement intégral du montant capturé, dans sa devise, est pris en charge.',
    ar: 'لا يُدعم إلا الاسترداد الكامل للمبلغ المحصَّل وبعملته.',
  },
  refundDisputeOpen: {
    en: 'A dispute on this payment blocks a new refund attempt.',
    fr: 'Un litige sur ce paiement empêche une nouvelle tentative de remboursement.',
    ar: 'يمنع نزاع قائم على عملية الدفع هذه محاولة استرداد جديدة.',
  },
  refundDisputeUnavailable: {
    en: 'The dispute status of this payment could not be verified; nothing was changed.',
    fr: "L'état des litiges de ce paiement n'a pas pu être vérifié ; rien n'a été modifié.",
    ar: 'تعذّر التحقق من حالة النزاعات على عملية الدفع هذه؛ لم يتغيّر شيء.',
  },
  refundInProgress: {
    en: 'Another refund attempt for this payment is unresolved or may still take effect.',
    fr: 'Une autre tentative de remboursement de ce paiement est non résolue ou peut encore prendre effet.',
    ar: 'توجد محاولة استرداد أخرى لعملية الدفع هذه لم تُحسم أو قد تنفذ بعد.',
  },
  refundAlreadyRecorded: {
    en: 'Refund evidence already exists for this payment.',
    fr: 'Une preuve de remboursement existe déjà pour ce paiement.',
    ar: 'يوجد بالفعل دليل استرداد لعملية الدفع هذه.',
  },
  refundAttemptConflict: {
    en: 'This refund attempt already exists with different content or another authorization receipt.',
    fr: "Cette tentative de remboursement existe déjà avec un contenu différent ou un autre reçu d'autorisation.",
    ar: 'محاولة الاسترداد هذه موجودة بالفعل بمحتوى مختلف أو بإيصال تفويض آخر.',
  },
  refundAuthorizationInvalid: {
    en: 'The refund authorization receipt is not valid for this refund.',
    fr: "Le reçu d'autorisation de remboursement n'est pas valide pour ce remboursement.",
    ar: 'إيصال تفويض الاسترداد غير صالح لهذا الاسترداد.',
  },
  refundAuthorizationExpired: {
    en: 'The refund authorization receipt expired before it was used.',
    fr: "Le reçu d'autorisation de remboursement a expiré avant d'être utilisé.",
    ar: 'انتهت صلاحية إيصال تفويض الاسترداد قبل استخدامه.',
  },
  refundAuthorizationUnresolved: {
    en: 'The refund authorization could not be confirmed yet; retry with the same key and receipt.',
    fr: "L'autorisation de remboursement n'a pas encore pu être confirmée ; réessayez avec la même clé et le même reçu.",
    ar: 'تعذّر تأكيد تفويض الاسترداد بعد؛ أعد المحاولة بالمفتاح نفسه والإيصال نفسه.',
  },
  refundCaseCompleted: { // Core V2 S6c (FC-3)
    en: 'This refund case is completed: it accepts no new refund attempt.',
    fr: "Ce dossier de remboursement est terminé : il n'accepte aucune nouvelle tentative de remboursement.",
    ar: 'اكتمل ملف الاسترداد هذا: لا يقبل أي محاولة استرداد جديدة.',
  },
  cannotFailSucceeded: {
    en: 'Cannot fail an attempt that already succeeded.',
    fr: "Impossible de faire échouer une tentative qui a déjà réussi.",
    ar: 'لا يمكن إفشال محاولة نجحت بالفعل.',
  },
  invalidDisputeRequest: { // Core V2 S6e-D
    en: 'The dispute request is invalid.',
    fr: 'La demande relative au litige est invalide.',
    ar: 'طلب النزاع غير صالح.',
  },
  disputeNotOpen: { // Core V2 S6e-D
    en: 'This dispute is no longer open.',
    fr: "Ce litige n'est plus ouvert.",
    ar: 'لم يعد هذا النزاع مفتوحًا.',
  },
  disputeEvidenceInvalid: { // Core V2 S6e-D
    en: 'This file is not granted to Payment as evidence of this dispute.',
    fr: "Ce fichier n'est pas accordé au service de paiement comme preuve de ce litige.",
    ar: 'هذا الملف غير ممنوح لخدمة الدفع كدليل على هذا النزاع.',
  },
  disputeEvidenceUnavailable: { // Core V2 S6e-D
    en: 'The evidence grant could not be verified; nothing was recorded.',
    fr: "L'autorisation de preuve n'a pas pu être vérifiée ; rien n'a été enregistré.",
    ar: 'تعذّر التحقق من منح الدليل؛ لم يُسجَّل شيء.',
  },
  disputeDecisionExists: { // Core V2 S6e-D
    en: 'A decision on this dispute is already recorded or pending.',
    fr: 'Une décision sur ce litige est déjà enregistrée ou en attente.',
    ar: 'يوجد قرار مسجّل أو معلّق بالفعل بشأن هذا النزاع.',
  },
  disputeDecisionRefused: { // Core V2 S6e-D
    en: 'The authorization of this decision was refused or has expired.',
    fr: "L'autorisation de cette décision a été refusée ou a expiré.",
    ar: 'رُفض تفويض هذا القرار أو انتهت صلاحيته.',
  },
  disputeDecisionConflict: { // Core V2 S6e-D
    en: 'This Idempotency-Key names a decision authorized by another receipt.',
    fr: 'Cette Idempotency-Key désigne une décision autorisée par un autre reçu.',
    ar: 'يشير مفتاح Idempotency-Key هذا إلى قرار مفوَّض بإيصال آخر.',
  },
  disputeDecisionUnresolved: { // Core V2 S6e-D
    en: 'The authorization of this decision could not be confirmed; repeat the same request.',
    fr: "L'autorisation de cette décision n'a pas pu être confirmée ; répétez la même requête.",
    ar: 'تعذّر تأكيد تفويض هذا القرار؛ أعد إرسال الطلب نفسه.',
  },
  invalidReconciliationRequest: { // Core V2 S6h
    en: 'The reconciliation request is invalid.',
    fr: "La demande de rapprochement n'est pas valide.",
    ar: 'طلب التسوية غير صالح.',
  },
  providerFactMatched: { // Core V2 S6h
    en: 'This provider fact is already matched to its payment.',
    fr: 'Ce fait du fournisseur est déjà rattaché à son paiement.',
    ar: 'هذه الواقعة من المزوّد مرتبطة بالفعل بدفعتها.',
  },
  factAlreadyAssociated: { // Core V2 S6h
    en: 'This provider fact is already associated or being associated.',
    fr: 'Ce fait du fournisseur est déjà associé ou en cours d’association.',
    ar: 'هذه الواقعة من المزوّد مرتبطة بالفعل أو قيد الربط.',
  },
  providerFactAssociationInvalid: { // Core V2 S6h
    en: 'This provider fact cannot be associated with that destination.',
    fr: 'Ce fait du fournisseur ne peut pas être associé à cette destination.',
    ar: 'لا يمكن ربط هذه الواقعة من المزوّد بهذه الوجهة.',
  },
  providerFactAssociationRefused: { // Core V2 S6h
    en: 'The authorization of this association was refused or has expired.',
    fr: "L'autorisation de cette association a été refusée ou a expiré.",
    ar: 'رُفض تفويض هذا الربط أو انتهت صلاحيته.',
  },
  providerFactAssociationConflict: { // Core V2 S6h
    en: 'This Idempotency-Key names an association authorized by another receipt.',
    fr: 'Cette clé Idempotency-Key désigne une association autorisée par un autre reçu.',
    ar: 'يشير مفتاح Idempotency-Key هذا إلى ربط مفوَّض بإيصال آخر.',
  },
  providerFactAssociationUnresolved: { // Core V2 S6h
    en: 'The authorization of this association could not be confirmed; repeat the same request.',
    fr: "L'autorisation de cette association n'a pas pu être confirmée ; répétez la même requête.",
    ar: 'تعذّر تأكيد تفويض هذا الربط؛ أعد إرسال الطلب نفسه.',
  },
  ownerAuthorityUnavailable: { // Core V2 S6e-D
    en: "The Owner's authority could not be verified; nothing was changed.",
    fr: "L'autorité du propriétaire n'a pas pu être vérifiée ; rien n'a été modifié.",
    ar: 'تعذّر التحقق من صلاحية المالك؛ لم يتغيّر شيء.',
  },
  simulationNothingToDispute: { // Core V2 S6e-D
    en: 'This payment has no verified capture to dispute.',
    fr: "Ce paiement n'a aucune capture vérifiée à contester.",
    ar: 'لا يوجد لهذه الدفعة تحصيل موثَّق يمكن الاعتراض عليه.',
  },
});
