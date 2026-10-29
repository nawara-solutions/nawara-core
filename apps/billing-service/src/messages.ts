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
  // Core V2 S5b: assisted settlement and cash return (register BIL-16, BIL-17)
  assistanceRequestNotSettleable: {
    en: 'This assistance request cannot be settled electronically now.',
    fr: "Cette demande d'aide ne peut pas être réglée électroniquement maintenant.",
    ar: 'لا يمكن تسوية طلب المساعدة هذا إلكترونيًا الآن.',
  },
  settlementChannelOpen: {
    en: 'A settlement of this assistance request is already in progress.',
    fr: "Un règlement de cette demande d'aide est déjà en cours.",
    ar: 'توجد بالفعل تسوية قيد التنفيذ لطلب المساعدة هذا.',
  },
  cashReturnNotOpen: {
    en: 'The cash-return obligation is not open.',
    fr: "L'obligation de restitution des espèces n'est pas ouverte.",
    ar: 'التزام إرجاع النقد غير مفتوح.',
  },
  cashReturnTimeInvalid: {
    en: 'returnedAt must be no earlier than the cash collection and no later than now.',
    fr: 'returnedAt ne doit être ni antérieur à la collecte des espèces ni postérieur à maintenant.',
    ar: 'يجب ألا يسبق returnedAt وقت تحصيل النقد وألا يتجاوز الوقت الحالي.',
  },
  // Core V2 S5c: cash-return confirmation, disputes and Owner corrections (register BIL-18 to BIL-22)
  valueOneOf: {
    en: '{field} must be one of: {values}',
    fr: "{field} doit être l'une des valeurs suivantes : {values}",
    ar: 'يجب أن يكون {field} إحدى القيم التالية: {values}',
  },
  cashReturnNotReported: {
    en: 'The Organization has not reported the cash return yet.',
    fr: "L'organisation n'a pas encore déclaré la restitution des espèces.",
    ar: 'لم تُبلغ المنظمة بعد عن إرجاع النقد.',
  },
  cashReturnAlreadyConfirmed: {
    en: 'The cash return is already confirmed.',
    fr: 'La restitution des espèces est déjà confirmée.',
    ar: 'تم تأكيد إرجاع النقد بالفعل.',
  },
  assistanceDisputeOpen: {
    en: 'A dispute of this assistance request is open.',
    fr: "Une contestation de cette demande d'aide est ouverte.",
    ar: 'يوجد اعتراض مفتوح على طلب المساعدة هذا.',
  },
  assistanceDisputeNotOpen: {
    en: 'The dispute is not open.',
    fr: "La contestation n'est pas ouverte.",
    ar: 'الاعتراض غير مفتوح.',
  },
  disputeNotPermitted: {
    en: 'This dispute concerns no recorded evidence of the assistance request.',
    fr: "Cette contestation ne porte sur aucune preuve enregistrée de la demande d'aide.",
    ar: 'لا يتعلق هذا الاعتراض بأي دليل مسجل لطلب المساعدة.',
  },
  disputeResponseExists: {
    en: 'The dispute has already been answered.',
    fr: 'La contestation a déjà reçu une réponse.',
    ar: 'تم الرد على الاعتراض بالفعل.',
  },
  correctionNotPermitted: {
    en: 'This time cannot be corrected: it has not been reported, or the value is unchanged.',
    fr: "Cette heure ne peut pas être corrigée : elle n'a pas été déclarée, ou la valeur est inchangée.",
    ar: 'لا يمكن تصحيح هذا الوقت: لم يُبلّغ عنه، أو أن القيمة لم تتغير.',
  },
  correctionTimeInvalid: {
    en: 'The corrected time breaks the recorded time order.',
    fr: "L'heure corrigée rompt l'ordre chronologique enregistré.",
    ar: 'الوقت المصحح يخالف الترتيب الزمني المسجل.',
  },
  resolutionNotPermitted: {
    en: 'This dispute has no permitted nonfinancial resolution with this correction.',
    fr: "Cette contestation n'a pas de résolution non financière autorisée avec cette correction.",
    ar: 'لا يوجد لهذا الاعتراض حل غير مالي مسموح به بهذا التصحيح.',
  },
  stepUpRequired: {
    en: 'A fresh step-up for this operation is required.',
    fr: 'Une nouvelle vérification renforcée pour cette opération est requise.',
    ar: 'يلزم تحقق معزز جديد لهذه العملية.',
  },
  // Core V2 S5d: Organization financial restrictions (register BIL-13 C, BIL-26)
  assistanceRestricted: {
    en: 'This Organization cannot accept new assistance requests while a financial restriction applies.',
    fr: "Cette organisation ne peut pas accepter de nouvelles demandes d'aide tant qu'une restriction financière s'applique.",
    ar: 'لا يمكن لهذه المنظمة قبول طلبات مساعدة جديدة ما دام هناك قيد مالي سارٍ.',
  },
  // Core V2 S6a: refund cases (register BIL-23, BIL-25)
  refundNotEligible: {
    en: 'This payment is not eligible for a refund case.',
    fr: "Ce paiement n'est pas éligible à un dossier de remboursement.",
    ar: 'هذه الدفعة غير مؤهلة لملف استرداد.',
  },
  refundCaseExists: {
    en: 'This payment already has an open or completed refund case.',
    fr: 'Ce paiement a déjà un dossier de remboursement ouvert ou terminé.',
    ar: 'لهذه الدفعة بالفعل ملف استرداد مفتوح أو مكتمل.',
  },
  refundDisputeOpen: {
    en: 'A dispute on this payment is open: no refund case can be opened.',
    fr: "Un litige sur ce paiement est ouvert : aucun dossier de remboursement ne peut être ouvert.",
    ar: 'يوجد نزاع مفتوح على هذه الدفعة: لا يمكن فتح ملف استرداد.',
  },
  refundDisputeUnavailable: { // Core V2 S6e-D (R6E-4)
    en: "The dispute status of this payment could not be verified; nothing was changed.",
    fr: "L'état des litiges de ce paiement n'a pas pu être vérifié ; rien n'a été modifié.",
    ar: 'تعذّر التحقق من حالة النزاعات على هذه الدفعة؛ لم يتغيّر شيء.',
  },
  invalidFraudHoldRequest: { // Core V2 S6e-H
    en: 'The fraud hold request is invalid.',
    fr: 'La demande de blocage pour fraude est invalide.',
    ar: 'طلب الحجز بسبب الاحتيال غير صالح.',
  },
  fraudHoldActive: { // Core V2 S6e-H
    en: 'Another fraud hold still restricts this entitlement.',
    fr: "Un autre blocage pour fraude restreint encore ce droit d'accès.",
    ar: 'لا يزال حجز آخر بسبب الاحتيال يقيّد هذا الاستحقاق.',
  },
  fraudHoldNotActive: { // Core V2 S6e-H
    en: 'This fraud hold has already ended.',
    fr: 'Ce blocage pour fraude est déjà terminé.',
    ar: 'انتهى هذا الحجز بسبب الاحتيال بالفعل.',
  },
  fraudHoldConflict: { // Core V2 S6e-H
    en: 'This hold identifier or evidence already belongs to another fraud hold.',
    fr: 'Cet identifiant ou cette preuve appartient déjà à un autre blocage pour fraude.',
    ar: 'ينتمي هذا المعرّف أو هذا الدليل بالفعل إلى حجز آخر بسبب الاحتيال.',
  },
  fraudEvidenceInvalid: { // Core V2 S6e-H
    en: 'The evidence is not a fraud_evidence grant to Billing for exactly this hold, Company and beneficiary.',
    fr: "La preuve n'est pas une autorisation fraud_evidence accordée à la facturation pour exactement ce blocage, cette entreprise et ce bénéficiaire.",
    ar: 'الدليل ليس منحًا من نوع fraud_evidence للفوترة يخص هذا الحجز وهذه الشركة وهذا المستفيد تحديدًا.',
  },
  fraudEvidenceUnavailable: { // Core V2 S6e-H
    en: 'The evidence could not be verified; nothing was changed.',
    fr: "La preuve n'a pas pu être vérifiée ; rien n'a été modifié.",
    ar: 'تعذّر التحقق من الدليل؛ لم يتغيّر شيء.',
  },
  fraudHoldAuthorizationRefused: { // Core V2 S6e-H
    en: 'The authorization of this fraud hold operation was refused or has expired.',
    fr: "L'autorisation de cette opération de blocage pour fraude a été refusée ou a expiré.",
    ar: 'رُفض تفويض عملية الحجز هذه أو انتهت صلاحيته.',
  },
  fraudHoldAuthorizationUnresolved: { // Core V2 S6e-H
    en: 'The authorization could not be confirmed; repeat the same request.',
    fr: "L'autorisation n'a pas pu être confirmée ; répétez la même requête.",
    ar: 'تعذّر تأكيد التفويض؛ أعد إرسال الطلب نفسه.',
  },
  fraudHoldUnavailable: { // Core V2 S6e-H
    en: 'Fraud holds are not available; nothing was changed.',
    fr: "Les blocages pour fraude ne sont pas disponibles ; rien n'a été modifié.",
    ar: 'الحجز بسبب الاحتيال غير متاح؛ لم يتغيّر شيء.',
  },
  invalidRecoveryRequest: { // Core V2 S6f
    en: 'The recovery request is invalid.',
    fr: "La demande de recouvrement n'est pas valide.",
    ar: 'طلب الاسترداد غير صالح.',
  },
  recoveryObligationClosed: { // Core V2 S6f
    en: 'This recovery obligation is already recovered.',
    fr: 'Cette obligation de recouvrement est déjà recouvrée.',
    ar: 'تمّ استرداد التزام الاسترداد هذا بالفعل.',
  },
  surplusNotOwed: { // Core V2 S6f
    en: 'This surplus is already resolved or being refunded.',
    fr: 'Cet excédent est déjà résolu ou en cours de remboursement.',
    ar: 'تمت تسوية هذا الفائض بالفعل أو يجري استرداده.',
  },
  surplusNotEvidenced: { // Core V2 S6f
    en: 'The Owner has not recorded an external repayment of this surplus.',
    fr: "Le propriétaire n'a enregistré aucun remboursement externe de cet excédent.",
    ar: 'لم يسجّل المالك أي سداد خارجي لهذا الفائض.',
  },
  surplusEvidenceInvalid: { // Core V2 S6f
    en: 'The evidence is not a surplus_evidence grant to Billing for exactly this surplus.',
    fr: "La preuve n'est pas une autorisation surplus_evidence accordée à la facturation pour exactement cet excédent.",
    ar: 'الدليل ليس منحًا من نوع surplus_evidence للفوترة يخص هذا الفائض تحديدًا.',
  },
  surplusEvidenceUnavailable: { // Core V2 S6f
    en: 'The surplus evidence could not be verified; nothing was changed.',
    fr: "La preuve de l'excédent n'a pas pu être vérifiée ; rien n'a été modifié.",
    ar: 'تعذّر التحقق من دليل الفائض؛ لم يتغيّر شيء.',
  },
  recoveryAuthorizationRefused: { // Core V2 S6f
    en: 'The authorization of this external repayment record was refused or has expired.',
    fr: "L'autorisation de cet enregistrement de remboursement externe a été refusée ou a expiré.",
    ar: 'رُفض تفويض تسجيل هذا السداد الخارجي أو انتهت صلاحيته.',
  },
  recoveryAuthorizationUnresolved: { // Core V2 S6f
    en: 'The authorization could not be confirmed; repeat the same request.',
    fr: "L'autorisation n'a pas pu être confirmée ; répétez la même requête.",
    ar: 'تعذّر تأكيد التفويض؛ أعد إرسال الطلب نفسه.',
  },
  recoveryAuthorizationUnavailable: { // Core V2 S6f
    en: 'The external repayment record is not available; nothing was changed.',
    fr: "L'enregistrement du remboursement externe n'est pas disponible ; rien n'a été modifié.",
    ar: 'تسجيل السداد الخارجي غير متاح؛ لم يتغيّر شيء.',
  },
  refundCaseNotOpen: {
    en: 'The refund case is not open.',
    fr: "Le dossier de remboursement n'est pas ouvert.",
    ar: 'ملف الاسترداد غير مفتوح.',
  },
  // Core V2 S6b: refund authorization relay (register BIL-24). `{reason}` is Payment's closed refusal code, never translated (D10).
  refundCaseCompleted: {
    en: 'The refund case is completed: it accepts no new refund attempt.',
    fr: "Le dossier de remboursement est clôturé : il n'accepte aucune nouvelle tentative de remboursement.",
    ar: 'اكتمل ملف الاسترداد: لا يقبل أي محاولة استرداد جديدة.',
  },
  refundAuthorizationInProgress: {
    en: 'A refund authorization for this case is still unresolved or in effect.',
    fr: 'Une autorisation de remboursement pour ce dossier est encore non résolue ou en vigueur.',
    ar: 'يوجد تفويض استرداد لهذا الملف لم يُحسم بعد أو ما زال ساريًا.',
  },
  refundAuthorizationInvalid: {
    en: 'The refund authorization receipt is not valid for this refund case.',
    fr: "Le reçu d'autorisation de remboursement n'est pas valide pour ce dossier.",
    ar: 'إيصال تفويض الاسترداد غير صالح لملف الاسترداد هذا.',
  },
  refundAuthorizationExpired: {
    en: 'The refund authorization receipt expired before it was used: authorize the refund again.',
    fr: "Le reçu d'autorisation de remboursement a expiré avant d'être utilisé : autorisez à nouveau le remboursement.",
    ar: 'انتهت صلاحية إيصال تفويض الاسترداد قبل استخدامه: فوّض الاسترداد من جديد.',
  },
  refundAuthorizationUnresolved: {
    en: 'The refund authorization is not confirmed yet; retry with the same Idempotency-Key and receipt.',
    fr: "L'autorisation de remboursement n'est pas encore confirmée ; réessayez avec la même Idempotency-Key et le même reçu.",
    ar: 'لم يُؤكَّد تفويض الاسترداد بعد؛ أعد المحاولة بقيمة Idempotency-Key نفسها والإيصال نفسه.',
  },
  refundAuthorizationConflict: {
    en: 'This refund authorization is already bound to another receipt.',
    fr: "Cette autorisation de remboursement est déjà liée à un autre reçu.",
    ar: 'تفويض الاسترداد هذا مرتبط بالفعل بإيصال آخر.',
  },
  refundRejectedByPayment: {
    en: 'The payment service refused this refund attempt ({reason}).',
    fr: 'Le service de paiement a refusé cette tentative de remboursement ({reason}).',
    ar: 'رفضت خدمة الدفع محاولة الاسترداد هذه ({reason}).',
  },
  refundPaymentUnavailable: {
    en: 'The payment service did not confirm the refund attempt; its outcome will be confirmed from Payment, or retry with the same Idempotency-Key and receipt.',
    fr: "Le service de paiement n'a pas confirmé la tentative de remboursement ; son issue sera confirmée par Payment, ou réessayez avec la même Idempotency-Key et le même reçu.",
    ar: 'لم تؤكد خدمة الدفع محاولة الاسترداد؛ ستُؤكَّد نتيجتها من خدمة الدفع، أو أعد المحاولة بقيمة Idempotency-Key نفسها والإيصال نفسه.',
  },
  refundProcessingStarted: {
    en: 'Refund processing has begun for this case: it can no longer be cancelled.',
    fr: "Le traitement du remboursement a commencé pour ce dossier : il ne peut plus être annulé.",
    ar: 'بدأت معالجة الاسترداد لهذا الملف: لم يعد من الممكن إلغاؤه.',
  },
});
