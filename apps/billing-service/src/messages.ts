import { defineMessages } from '@nawara/service-kit';

/**
 * Billing's own human-readable API error messages (ADR-0054 D13, Core V1 refactor R6.6), in English, French and Arabic. The keys are
 * INTERNAL message identities, never a public `code`. Every `en` text, once its parameters are filled, is Billing's existing English,
 * byte for byte (D6).
 *
 * Parameters are server-defined only (D10): `{status}` is a closed machine enum read from Billing's own row (an invoice is
 * `draft | open | paid | void`; a subscription `pending | active | grace | expired`) and is never translated; `{field}` is a field path
 * Billing names itself (`seller`, `lines[2].quantity`…); `{name}` is a request property NAME (never its value), as for Organization's
 * unknown body field; `{max}` and `{pattern}` are server constants. Field, header and enum names stay verbatim in every language.
 *
 * Deliberately NOT here (D10, deferred): the snapshot-validation messages (`SnapshotError`), which carry arbitrary keys of a client's
 * free-form JSON, and the anchored-period message, which carries a date computed from a client-supplied start. They stay English.
 */
export const BILLING_MESSAGES = defineMessages({
  // access
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
  // pagination (code-less)
  limitRange: {
    en: 'limit must be an integer from 1 to {max}',
    fr: 'limit doit être un entier compris entre 1 et {max}',
    ar: 'يجب أن تكون قيمة limit عددًا صحيحًا من 1 إلى {max}',
  },
  cursorInvalid: { en: 'cursor is not valid', fr: "cursor n'est pas valide", ar: 'قيمة cursor غير صالحة' },
  // request bodies (manual validation)
  requestMustBeObject: { en: 'the request must be an object', fr: 'la requête doit être un objet', ar: 'يجب أن يكون الطلب كائنًا' },
  unknownField: { en: 'unknown field: {name}', fr: 'champ inconnu : {name}', ar: 'حقل غير معروف: {name}' },
  mustBeObject: { en: '{field} must be an object', fr: '{field} doit être un objet', ar: 'يجب أن يكون {field} كائنًا' },
  mustBeUuid: { en: '{field} must be a uuid', fr: '{field} doit être un uuid', ar: 'يجب أن يكون {field} بصيغة uuid' },
  partyTypeValues: {
    en: '{field} must be user, organization or company',
    fr: '{field} doit valoir user, organization ou company',
    ar: 'يجب أن تكون قيمة {field} إحدى القيم user أو organization أو company',
  },
  lengthRange: {
    en: '{field} must be 1 to {max} characters',
    fr: '{field} doit contenir de 1 à {max} caractères',
    ar: 'يجب أن يتكوّن {field} من 1 إلى {max} حرفًا',
  },
  patternMatch: { en: '{field} must match {pattern}', fr: '{field} doit correspondre à {pattern}', ar: 'يجب أن يطابق {field} النمط {pattern}' },
  timestampWithOffset: {
    en: '{field} must be an absolute timestamp with an offset',
    fr: '{field} doit être un horodatage absolu avec un décalage',
    ar: 'يجب أن يكون {field} طابعًا زمنيًا مطلقًا مع إزاحة',
  },
  integerRange: {
    en: '{field} must be an integer from 1 to {max}',
    fr: '{field} doit être un entier compris entre 1 et {max}',
    ar: 'يجب أن يكون {field} عددًا صحيحًا من 1 إلى {max}',
  },
  notValid: { en: '{field} is not valid', fr: "{field} n'est pas valide", ar: 'قيمة {field} غير صالحة' },
  sourcePair: {
    en: '{field} needs both sourceType and sourceId, or neither',
    fr: '{field} nécessite à la fois sourceType et sourceId, ou aucun des deux',
    ar: 'يتطلب {field} كلًا من sourceType وsourceId معًا، أو لا شيء منهما',
  },
  sellerIdUuidWhenOrganization: {
    en: 'seller.id must be a uuid when seller.type is organization',
    fr: 'seller.id doit être un uuid lorsque seller.type vaut organization',
    ar: 'يجب أن يكون seller.id بصيغة uuid عندما تكون قيمة seller.type هي organization',
  },
  entitlementKindValues: {
    en: 'entitlementKind must be none, organization_license or user_subscription',
    fr: 'entitlementKind doit valoir none, organization_license ou user_subscription',
    ar: 'يجب أن تكون قيمة entitlementKind إحدى القيم none أو organization_license أو user_subscription',
  },
  payerSellerDiffer: { en: 'payer and seller must differ', fr: 'payer et seller doivent être différents', ar: 'يجب أن يختلف payer عن seller' },
  organizationIdEqualsSeller: {
    en: 'organizationId must equal seller.id when the seller is an organization',
    fr: 'organizationId doit être égal à seller.id lorsque le vendeur est une organisation',
    ar: 'يجب أن يساوي organizationId قيمة seller.id عندما يكون البائع منظمة',
  },
  linesCount: { en: 'lines must have 1 to {max} entries', fr: 'lines doit contenir de 1 à {max} éléments', ar: 'يجب أن يحتوي lines على 1 إلى {max} عنصرًا' },
  localeTag: {
    en: 'locale must be a language tag such as fr or ar-TN',
    fr: 'locale doit être une étiquette de langue telle que fr ou ar-TN',
    ar: 'يجب أن تكون قيمة locale وسم لغة مثل fr أو ar-TN',
  },
  invoiceStatusValues: {
    en: 'status must be draft, open, paid or void',
    fr: 'status doit valoir draft, open, paid ou void',
    ar: 'يجب أن تكون قيمة status إحدى القيم draft أو open أو paid أو void',
  },
  clientReferencePattern: {
    en: 'clientReference must be 1 to 128 characters of [A-Za-z0-9._:-]',
    fr: 'clientReference doit contenir de 1 à 128 caractères parmi [A-Za-z0-9._:-]',
    ar: 'يجب أن يتكوّن clientReference من 1 إلى 128 حرفًا من [A-Za-z0-9._:-]',
  },
  currencyIso: {
    en: 'currency must be a three-letter ISO 4217 code',
    fr: 'currency doit être un code ISO 4217 à trois lettres',
    ar: 'يجب أن تكون قيمة currency رمز ISO 4217 من ثلاثة أحرف',
  },
  unitAmountPositive: {
    en: 'unitAmount must be a positive integer number of minor units',
    fr: 'unitAmount doit être un nombre entier positif de sous-unités',
    ar: 'يجب أن تكون قيمة unitAmount عددًا صحيحًا موجبًا من الوحدات الصغرى',
  },
  unitAmountMax: { en: 'unitAmount must be at most {max}', fr: 'unitAmount doit être au plus {max}', ar: 'يجب ألا تتجاوز قيمة unitAmount {max}' },
  intervalValues: {
    en: 'interval must be one_time or recurring',
    fr: 'interval doit valoir one_time ou recurring',
    ar: 'يجب أن تكون قيمة interval إما one_time أو recurring',
  },
  intervalUnitValues: {
    en: 'intervalUnit must be day, week, month or year for a recurring price',
    fr: 'intervalUnit doit valoir day, week, month ou year pour un prix récurrent',
    ar: 'يجب أن تكون قيمة intervalUnit إحدى القيم day أو week أو month أو year للسعر المتكرر',
  },
  intervalCountPositive: {
    en: 'intervalCount must be a positive integer for a recurring price',
    fr: 'intervalCount doit être un entier positif pour un prix récurrent',
    ar: 'يجب أن تكون قيمة intervalCount عددًا صحيحًا موجبًا للسعر المتكرر',
  },
  oneTimeNoInterval: {
    en: 'a one_time price cannot carry intervalUnit or intervalCount',
    fr: 'un prix one_time ne peut pas comporter intervalUnit ni intervalCount',
    ar: 'لا يمكن أن يتضمن سعر one_time القيمة intervalUnit أو intervalCount',
  },
  // catalog
  productConflict: {
    en: 'This seller and code were used with different content.',
    fr: 'Ce vendeur et ce code ont été utilisés avec un contenu différent.',
    ar: 'استُخدم هذا البائع وهذا الرمز بمحتوى مختلف.',
  },
  priceConflict: {
    en: 'This productId and clientReference were used with different content.',
    fr: 'Ce productId et cette clientReference ont été utilisés avec un contenu différent.',
    ar: 'استُخدم productId وclientReference هذان بمحتوى مختلف.',
  },
  currencyNotSupported: { en: 'The currency is not supported.', fr: "La devise n'est pas prise en charge.", ar: 'العملة غير مدعومة.' },
  currencyNotEnabledForPlatform: {
    en: 'The currency is not enabled for this platform.',
    fr: "La devise n'est pas activée pour cette plateforme.",
    ar: 'العملة غير مفعّلة لهذه المنصة.',
  },
  currencyDoesNotExist: { en: 'The currency does not exist.', fr: "La devise n'existe pas.", ar: 'العملة غير موجودة.' },
  // invoices
  priceNotAvailable: { en: 'A price is not available.', fr: "Un prix n'est pas disponible.", ar: 'أحد الأسعار غير متاح.' },
  linesShareCurrency: {
    en: 'All lines of an invoice must share one currency.',
    fr: "Toutes les lignes d'une facture doivent avoir la même devise.",
    ar: 'يجب أن تشترك جميع بنود الفاتورة في عملة واحدة.',
  },
  oneRecurringLine: {
    en: 'An invoice may contain at most one recurring line.',
    fr: 'Une facture peut contenir au plus une ligne récurrente.',
    ar: 'يمكن أن تحتوي الفاتورة على بند متكرر واحد على الأكثر.',
  },
  invoiceRequestConflict: {
    en: 'The invoice request conflicts with another request.',
    fr: 'La demande de facture est en conflit avec une autre demande.',
    ar: 'يتعارض طلب الفاتورة مع طلب آخر.',
  },
  invoiceRequestIdReused: {
    en: 'This invoiceRequestId was used with different content.',
    fr: 'Cet invoiceRequestId a été utilisé avec un contenu différent.',
    ar: 'استُخدمت قيمة invoiceRequestId هذه بمحتوى مختلف.',
  },
  invoiceCannotBeIssued: {
    en: 'An invoice that is {status} cannot be issued.',
    fr: "Une facture à l'état {status} ne peut pas être émise.",
    ar: 'لا يمكن إصدار فاتورة في الحالة {status}.',
  },
  invoiceCannotBeDiscarded: {
    en: 'An invoice that is {status} cannot be discarded.',
    fr: "Une facture à l'état {status} ne peut pas être abandonnée.",
    ar: 'لا يمكن تجاهل فاتورة في الحالة {status}.',
  },
  // payment requests
  onlyOpenInvoicePayable: { en: 'Only an open invoice can be paid.', fr: 'Seule une facture ouverte peut être payée.', ar: 'لا يمكن دفع إلا فاتورة مفتوحة.' },
  onlyUserPayer: {
    en: 'Only a user payer can pay an invoice for now.',
    fr: "Seul un payeur utilisateur peut payer une facture pour l'instant.",
    ar: 'لا يمكن حاليًا دفع الفاتورة إلا من قِبل دافع من نوع مستخدم.',
  },
  requestAlreadySent: {
    en: 'This request has already been sent; it cannot be cancelled locally.',
    fr: 'Cette demande a déjà été envoyée ; elle ne peut pas être annulée localement.',
    ar: 'أُرسل هذا الطلب بالفعل؛ لا يمكن إلغاؤه محليًا.',
  },
  requestNotCancellableYet: {
    en: 'This request cannot be cancelled yet.',
    fr: 'Cette demande ne peut pas encore être annulée.',
    ar: 'لا يمكن إلغاء هذا الطلب بعد.',
  },
  paymentRefusedCancellation: {
    en: 'Payment refused the cancellation: a payment attempt or cash submission is in progress.',
    fr: "Le service de paiement a refusé l'annulation : une tentative de paiement ou un versement en espèces est en cours.",
    ar: 'رفضت خدمة الدفع الإلغاء: توجد محاولة دفع أو إيداع نقدي قيد التنفيذ.',
  },
  paymentCouldNotConfirm: {
    en: 'Payment could not confirm the cancellation. Retry the same request.',
    fr: "Le service de paiement n'a pas pu confirmer l'annulation. Réessayez la même requête.",
    ar: 'تعذّر على خدمة الدفع تأكيد الإلغاء. أعد محاولة الطلب نفسه.',
  },
  // subscriptions
  subscriptionRequestConflict: {
    en: 'The subscription request conflicts with another request.',
    fr: "La demande d'abonnement est en conflit avec une autre demande.",
    ar: 'يتعارض طلب الاشتراك مع طلب آخر.',
  },
  subscriptionDifferentProduct: {
    en: 'This organization already has a subscription to a different product or price.',
    fr: 'Cette organisation a déjà un abonnement à un autre produit ou à un autre prix.',
    ar: 'لدى هذه المنظمة اشتراك بالفعل في منتج أو سعر مختلف.',
  },
  periodEndAfterStart: {
    en: 'currentPeriodEnd must be after currentPeriodStart.',
    fr: 'currentPeriodEnd doit être postérieur à currentPeriodStart.',
    ar: 'يجب أن يكون currentPeriodEnd بعد currentPeriodStart.',
  },
  pendingMustBeActivated: {
    en: 'A pending subscription must be activated before it can be renewed.',
    fr: 'Un abonnement en attente doit être activé avant de pouvoir être renouvelé.',
    ar: 'يجب تفعيل الاشتراك المعلّق قبل أن يمكن تجديده.',
  },
  noGraceWindow: {
    en: 'This subscription has no grace window to enter.',
    fr: "Cet abonnement n'a pas de période de grâce dans laquelle entrer.",
    ar: 'لا يملك هذا الاشتراك فترة سماح للدخول فيها.',
  },
  subscriptionCannotBeActivated: {
    en: 'A subscription that is {status} cannot be activated.',
    fr: "Un abonnement à l'état {status} ne peut pas être activé.",
    ar: 'لا يمكن تفعيل اشتراك في الحالة {status}.',
  },
  subscriptionCannotEnterGrace: {
    en: 'A subscription that is {status} cannot enter grace.',
    fr: "Un abonnement à l'état {status} ne peut pas entrer en période de grâce.",
    ar: 'لا يمكن لاشتراك في الحالة {status} الدخول في فترة السماح.',
  },
  subscriptionCannotExpire: {
    en: 'A subscription that is {status} cannot expire.',
    fr: "Un abonnement à l'état {status} ne peut pas expirer.",
    ar: 'لا يمكن أن ينتهي اشتراك في الحالة {status}.',
  },
  subscriptionCannotChangeCancellation: {
    en: 'A subscription that is {status} cannot change its cancellation.',
    fr: "Un abonnement à l'état {status} ne peut pas modifier son annulation.",
    ar: 'لا يمكن لاشتراك في الحالة {status} تغيير إلغائه.',
  },
  subscriptionCannotBeTerminated: {
    en: 'A subscription that is {status} cannot be terminated.',
    fr: "Un abonnement à l'état {status} ne peut pas être résilié.",
    ar: 'لا يمكن إنهاء اشتراك في الحالة {status}.',
  },  // Core V2 S3a: subscription targets and invoice routing (ADR-0044 B1, B2)
  subscriptionTargetValues: {
    en: 'subscriptionTarget must be none, organization or personal',
    fr: 'subscriptionTarget doit valoir none, organization ou personal',
    ar: 'يجب أن تكون قيمة subscriptionTarget إحدى القيم none أو organization أو personal',
  },
  platformIdUuid: { en: 'platformId must be a uuid', fr: 'platformId doit être un uuid', ar: 'يجب أن يكون platformId بصيغة uuid' },
  subscriptionProductNeedsPlatform: {
    en: 'a subscription product (organization or personal) requires platformId',
    fr: "un produit d'abonnement (organization ou personal) exige platformId",
    ar: 'يتطلب منتج الاشتراك (organization أو personal) قيمة platformId',
  },
  platformNotPermitted: {
    en: 'This Platform is not permitted for the caller.',
    fr: "Cette plateforme n'est pas autorisée pour l'appelant.",
    ar: 'هذه المنصة غير مسموح بها للجهة المستدعية.',
  },
  subscriptionPriceNotRecurring: {
    en: 'A subscription product has recurring prices only.',
    fr: "Un produit d'abonnement n'a que des prix récurrents.",
    ar: 'لا يملك منتج الاشتراك إلا أسعارًا متكررة.',
  },
  invoiceRoutingInvalid: {
    en: 'The invoice cannot be routed ({reason}).',
    fr: 'La facture ne peut pas être acheminée ({reason}).',
    ar: 'لا يمكن توجيه الفاتورة ({reason}).',
  },
  // Core V2 S3d: the Platform commercial configuration (register BIL-01)
  platformNotConfigured: {
    en: 'The Platform has no billing configuration.',
    fr: "La plateforme n'a pas de configuration de facturation.",
    ar: 'لا تملك المنصة إعدادات فوترة.',
  },
  billingPlatformExists: {
    en: 'This Platform already has a different billing configuration.',
    fr: 'Cette plateforme a déjà une configuration de facturation différente.',
    ar: 'تملك هذه المنصة بالفعل إعدادات فوترة مختلفة.',
  },
  authorityUnverified: {
    en: 'The caller could not be verified. Nothing was changed.',
    fr: "L'appelant n'a pas pu être vérifié. Rien n'a été modifié.",
    ar: 'تعذّر التحقق من الجهة المستدعية. لم يتم تغيير أي شيء.',
  },
  // Core V2 S3f: fee caps, delegations and proposals (register BIL-04 to BIL-07)
  feeAboveCap: {
    en: "The fee is above the Platform's cap.",
    fr: 'Les frais dépassent le plafond de la plateforme.',
    ar: 'الرسوم أعلى من الحد الأقصى للمنصة.',
  },
  feeProposalNotPending: {
    en: 'The fee proposal is no longer pending.',
    fr: "La proposition de frais n'est plus en attente.",
    ar: 'لم يعد اقتراح الرسوم قيد الانتظار.',
  },
  feeProposalPendingExists: {
    en: 'A fee proposal for this Organization and product is already pending.',
    fr: 'Une proposition de frais pour cette organisation et ce produit est déjà en attente.',
    ar: 'يوجد بالفعل اقتراح رسوم قيد الانتظار لهذه المنظمة وهذا المنتج.',
  },
  productNotAvailable: {
    en: 'The product is not available.',
    fr: "Le produit n'est pas disponible.",
    ar: 'المنتج غير متاح.',
  },
  idempotencyKeyRequired: {
    en: 'An Idempotency-Key header of 8 to 128 characters of [A-Za-z0-9._:-] is required.',
    fr: "Un en-tête Idempotency-Key de 8 à 128 caractères parmi [A-Za-z0-9._:-] est requis.",
    ar: 'مطلوب ترويسة Idempotency-Key من 8 إلى 128 حرفًا من [A-Za-z0-9._:-].',
  },
  idempotencyKeyConflict: {
    en: 'This Idempotency-Key was already used for a different request.',
    fr: 'Cette Idempotency-Key a déjà été utilisée pour une autre requête.',
    ar: 'سبق استخدام مفتاح Idempotency-Key هذا لطلب مختلف.',
  },
  // Core V2 S3f: direct checkout (register BIL-10)
  memberNotEligible: {
    en: 'Only an active member may check out.',
    fr: 'Seul un membre actif peut effectuer un achat.',
    ar: 'لا يمكن إتمام الشراء إلا لعضو نشط.',
  },
  checkoutUncertain: {
    en: 'A checkout for this product is still in progress.',
    fr: 'Un achat de ce produit est encore en cours.',
    ar: 'لا تزال عملية شراء لهذا المنتج قيد التنفيذ.',
  },
  feeAmountRange: {
    en: 'amount must be an integer number of minor units from 0 to 9007199254740991',
    fr: 'amount doit être un nombre entier d’unités mineures de 0 à 9007199254740991',
    ar: 'يجب أن يكون amount عددًا صحيحًا من الوحدات الصغرى من 0 إلى 9007199254740991',
  },
  // Core V2 S5a: Organization assistance (register BIL-13 to BIL-15)
  assistanceMemberNotEligible: {
    en: 'Only an active member of the Organization may request assistance.',
    fr: "Seul un membre actif de l'organisation peut demander une aide.",
    ar: 'لا يمكن طلب المساعدة إلا لعضو نشط في المنظمة.',
  },
  assistanceConsentRequired: {
    en: 'consent must be true',
    fr: 'consent doit valoir true',
    ar: 'يجب أن تكون قيمة consent هي true',
  },
  mustBeTimestamp: {
    en: '{field} must be an ISO 8601 date-time with a time zone',
    fr: '{field} doit être une date-heure ISO 8601 avec un fuseau horaire',
    ar: 'يجب أن يكون {field} تاريخًا ووقتًا بصيغة ISO 8601 مع منطقة زمنية',
  },
  assistanceRequestOpen: {
    en: 'An assistance request for this product is already open with this Organization.',
    fr: 'Une demande d’aide pour ce produit est déjà ouverte auprès de cette organisation.',
    ar: 'يوجد بالفعل طلب مساعدة مفتوح لهذا المنتج لدى هذه المنظمة.',
  },
  assistanceRequestNotPending: {
    en: 'The assistance request is no longer pending.',
    fr: "La demande d’aide n'est plus en attente.",
    ar: 'لم يعد طلب المساعدة قيد الانتظار.',
  },
  cashCollectionAlreadyReported: {
    en: 'Cash collection was already reported for this request.',
    fr: 'La collecte des espèces a déjà été déclarée pour cette demande.',
    ar: 'سبق الإبلاغ عن تحصيل النقد لهذا الطلب.',
  },
  cashCollectionTimeInvalid: {
    en: 'cashCollectedAt must be no earlier than the consent and no later than now.',
    fr: 'cashCollectedAt ne doit être ni antérieur au consentement ni postérieur à maintenant.',
    ar: 'يجب ألا يسبق cashCollectedAt وقت الموافقة وألا يتجاوز الوقت الحالي.',
  },
  feeNotUsable: {
    en: "The Organization's approved fee is above the Platform's current cap.",
    fr: "Les frais approuvés de l'organisation dépassent le plafond actuel de la plateforme.",
    ar: 'الرسوم المعتمدة للمنظمة أعلى من الحد الأقصى الحالي للمنصة.',
  },
});
