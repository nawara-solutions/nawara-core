import { defineMessages } from '@nawara/service-kit';

/**
 * Release's own human-readable API error messages (ADR-0054 D13, Core V1 refactor R6.3), in English, French and Arabic. The keys are
 * INTERNAL message identities, never a public `code`. Every `en` text is Release's existing English, byte for byte (D6).
 *
 * Each "… is invalid." case is its own complete sentence (never a translated frame around an English noun phrase), so no response can
 * mix languages. The one parameter, `{status}`, is the release status, a closed machine enum (`registered | published | withdrawn`)
 * that is never translated (D10).
 */
export const RELEASE_MESSAGES = defineMessages({
  // validation_error: "<what> is invalid."
  invalidProductOrComponentKey: {
    en: 'The product or component key is invalid.',
    fr: 'La clé du produit ou du composant est invalide.',
    ar: 'مفتاح المنتج أو المكوّن غير صالح.',
  },
  invalidComponentKey: { en: 'The component key is invalid.', fr: 'La clé du composant est invalide.', ar: 'مفتاح المكوّن غير صالح.' },
  invalidVersion: { en: 'The version is invalid.', fr: 'La version est invalide.', ar: 'الإصدار غير صالح.' },
  invalidMinimumVersion: { en: 'The minimum version is invalid.', fr: 'La version minimale est invalide.', ar: 'الحد الأدنى للإصدار غير صالح.' },
  invalidExpectedPolicyVersion: {
    en: 'The expected policy version is invalid.',
    fr: 'La version de politique attendue est invalide.',
    ar: 'إصدار السياسة المتوقع غير صالح.',
  },
  invalidRelease: { en: 'The release is invalid.', fr: 'La version soumise est invalide.', ar: 'الإصدار المقدَّم غير صالح.' },
  // owner administration
  stepUpRequired: {
    en: 'A valid factor step-up for this operation is required.',
    fr: 'Une vérification renforcée valide est requise pour cette opération.',
    ar: 'يلزم إجراء تحقق إضافي صالح لتنفيذ هذه العملية.',
  },
  noSuchRelease: { en: 'No such release.', fr: 'Version inexistante.', ar: 'الإصدار غير موجود.' },
  neverPublishedCannotBeWithdrawn: {
    en: 'A registered release that was never published cannot be withdrawn.',
    fr: "Une version enregistrée qui n'a jamais été publiée ne peut pas être retirée.",
    ar: 'لا يمكن سحب إصدار مسجل لم يُنشر قط.',
  },
  cannotBeWithdrawn: { en: 'This release cannot be withdrawn.', fr: 'Cette version ne peut pas être retirée.', ar: 'لا يمكن سحب هذا الإصدار.' },
  minimumHasNoPrerelease: {
    en: 'A minimum version has no pre-release tag.',
    fr: "Une version minimale ne comporte pas d'étiquette de préversion.",
    ar: 'لا يحتوي الحد الأدنى للإصدار على وسم إصدار تجريبي.',
  },
  noSuchComponent: { en: 'No such component.', fr: 'Composant inexistant.', ar: 'المكوّن غير موجود.' },
  backendHasNoPolicy: {
    en: 'A backend component has no compatibility policy.',
    fr: "Un composant backend n'a pas de politique de compatibilité.",
    ar: 'لا تمتلك مكوّنات الواجهة الخلفية سياسة توافق.',
  },
  minimumAboveLatest: {
    en: 'The minimum would exceed the latest published release.',
    fr: 'Le minimum dépasserait la dernière version publiée.',
    ar: 'سيتجاوز الحد الأدنى أحدث إصدار منشور.',
  },
  minimumMustBePublished: {
    en: 'The minimum must be a published, not withdrawn, release of this component.',
    fr: 'Le minimum doit être une version publiée, et non retirée, de ce composant.',
    ar: 'يجب أن يكون الحد الأدنى إصدارًا منشورًا وغير مسحوب لهذا المكوّن.',
  },
  wouldBreakMinimum: {
    en: 'Withdrawing this release would leave the minimum version above the latest release; lower the minimum first.',
    fr: "Retirer cette version laisserait la version minimale au-dessus de la dernière version ; abaissez d'abord le minimum.",
    ar: 'سيؤدي سحب هذا الإصدار إلى بقاء الحد الأدنى للإصدار أعلى من أحدث إصدار؛ اخفض الحد الأدنى أولًا.',
  },
  policyConflict: {
    en: 'The policy changed since you read it; read it again.',
    fr: 'La politique a changé depuis votre lecture ; relisez-la.',
    ar: 'تغيّرت السياسة منذ قراءتك لها؛ أعد قراءتها.',
  },
  authorityUnverified: {
    en: 'Authority could not be verified; nothing was changed.',
    fr: "L'autorité n'a pas pu être vérifiée ; rien n'a été modifié.",
    ar: 'تعذّر التحقق من الصلاحية؛ لم يتم تغيير أي شيء.',
  },
  ownerOnly: {
    en: 'Only the owner of the operating Company may administer releases.',
    fr: "Seul le propriétaire de l'entreprise exploitante peut administrer les versions.",
    ar: 'لا يحق إدارة الإصدارات إلا لمالك الشركة المشغّلة.',
  },
  // automation (CI)
  componentKindConflict: {
    en: 'The component exists with another kind.',
    fr: "Le composant existe avec un autre type.",
    ar: 'المكوّن موجود بنوع آخر.',
  },
  releaseIdentityConflict: {
    en: 'This version is registered with a different identity.',
    fr: 'Cette version est enregistrée avec une identité différente.',
    ar: 'هذا الإصدار مسجل بهوية مختلفة.',
  },
  cannotPublishInStatus: {
    en: 'A {status} release cannot be published.',
    fr: "Une version à l'état {status} ne peut pas être publiée.",
    ar: 'لا يمكن نشر إصدار في الحالة {status}.',
  },
  // public compatibility endpoint
  tooManyRequests: { en: 'Too many requests.', fr: 'Trop de requêtes.', ar: 'عدد كبير جدًا من الطلبات.' },
  onlyVersionParameter: {
    en: 'Only the version query parameter is accepted.',
    fr: 'Seul le paramètre de requête version est accepté.',
    ar: 'لا يُقبل إلا معامل الاستعلام version.',
  },
  notCanonicalVersion: {
    en: 'The version is not a canonical release version.',
    fr: "La version n'est pas une version canonique.",
    ar: 'الإصدار ليس إصدارًا قياسيًا.',
  },
  noSuchClientComponent: { en: 'No such client component.', fr: 'Composant client inexistant.', ar: 'مكوّن العميل غير موجود.' },
  notRegisteredRelease: {
    en: 'This version is not a registered release of the component.',
    fr: "Cette version n'est pas une version enregistrée du composant.",
    ar: 'هذا الإصدار ليس إصدارًا مسجلًا للمكوّن.',
  },
  // caller policy (automation)
  productNotAllowed: {
    en: 'This caller has no authority on this product.',
    fr: "Cet appelant n'a aucune autorité sur ce produit.",
    ar: 'لا يملك هذا المستدعي أي صلاحية على هذا المنتج.',
  },
  operationNotAllowed: {
    en: 'Operation not allowed for this caller.',
    fr: 'Opération non autorisée pour cet appelant.',
    ar: 'العملية غير مسموح بها لهذا المستدعي.',
  },
});
