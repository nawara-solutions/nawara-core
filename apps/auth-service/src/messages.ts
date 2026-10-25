import { defineMessages } from '@nawara/service-kit';

/**
 * Auth's own human-readable error messages (ADR-0054 D13, Core V1 refactor R5), in English, French and Arabic. The keys are INTERNAL
 * message identities: never a public `code` (the code is passed separately to `authError` and never changes with the language).
 * Every `en` text is Auth's existing English, byte for byte (D6). Parameters are values Auth computed itself (configured bounds, a
 * server timestamp), never client input (D10). Deliberately generic messages stay exactly as generic in every language.
 */
export const AUTH_MESSAGES = defineMessages({
  provideEmailOrPhone: {
    en: 'Provide an email or a phone number.',
    fr: 'Indiquez une adresse e-mail ou un numéro de téléphone.',
    ar: 'أدخل عنوان بريد إلكتروني أو رقم هاتف.',
  },
  exactlyOneEmailOrPhone: {
    en: 'Provide exactly one of email or phone.',
    fr: 'Indiquez soit une adresse e-mail, soit un numéro de téléphone, mais pas les deux.',
    ar: 'أدخل إما البريد الإلكتروني أو رقم الهاتف، وليس كليهما.',
  },
  invalidPhone: { en: 'Invalid phone number.', fr: 'Numéro de téléphone invalide.', ar: 'رقم الهاتف غير صالح.' },
  passwordLength: {
    en: 'Password must be {min}-{max} bytes long.',
    fr: 'Le mot de passe doit contenir entre {min} et {max} octets.',
    ar: 'يجب أن يتراوح طول كلمة المرور بين {min} و{max} بايت.',
  },
  expiresInMinutesRange: {
    en: 'expiresInMinutes must be between {min} and {max}.',
    fr: 'expiresInMinutes doit être compris entre {min} et {max}.',
    ar: 'يجب أن تكون قيمة expiresInMinutes بين {min} و{max}.',
  },
  registrationRefused: {
    en: 'Registration is not available with this code. Please contact your organization.',
    fr: "L'inscription n'est pas possible avec ce code. Veuillez contacter votre organisation.",
    ar: 'التسجيل غير متاح بهذا الرمز. يرجى التواصل مع مؤسستك.',
  },
  membershipExists: {
    en: 'You already have a membership in this organization.',
    fr: 'Vous êtes déjà membre de cette organisation.',
    ar: 'لديك عضوية بالفعل في هذه المؤسسة.',
  },
  invalidCredentials: { en: 'Invalid credentials.', fr: 'Identifiants invalides.', ar: 'بيانات الاعتماد غير صالحة.' },
  invalidRefreshToken: { en: 'Invalid refresh token.', fr: 'Jeton de rafraîchissement invalide.', ar: 'رمز التحديث غير صالح.' },
  invalidToken: { en: 'Invalid or expired token.', fr: 'Jeton invalide ou expiré.', ar: 'الرمز غير صالح أو منتهي الصلاحية.' },
  sessionEnded: { en: 'Session has ended.', fr: 'La session est terminée.', ar: 'انتهت الجلسة.' },
  sessionCeiling: {
    en: 'Your session has ended. Please request a new login code to continue.',
    fr: 'Votre session est terminée. Veuillez demander un nouveau code de connexion pour continuer.',
    ar: 'انتهت جلستك. يرجى طلب رمز تسجيل دخول جديد للمتابعة.',
  },
  hierarchyUnavailable: {
    en: 'The organization hierarchy could not be verified; nothing was changed. Retry later.',
    fr: "La hiérarchie de l'organisation n'a pas pu être vérifiée ; rien n'a été modifié. Réessayez plus tard.",
    ar: 'تعذّر التحقق من الهيكل التنظيمي؛ لم يتم تغيير أي شيء. أعد المحاولة لاحقًا.',
  },
  requestAlreadyDecided: {
    en: 'This request has already been decided.',
    fr: 'Une décision a déjà été prise pour cette demande.',
    ar: 'تم البت في هذا الطلب بالفعل.',
  },
  contactNotVerified: {
    en: 'The applicant has not verified their contact yet.',
    fr: "Le demandeur n'a pas encore vérifié ses coordonnées.",
    ar: 'لم يتحقق مقدم الطلب من بيانات الاتصال الخاصة به بعد.',
  },
  onlyActiveRevocable: {
    en: 'Only an active membership can be revoked.',
    fr: 'Seule une adhésion active peut être révoquée.',
    ar: 'لا يمكن إلغاء سوى العضوية النشطة.',
  },
  invalidOrExpiredCode: { en: 'Invalid or expired code.', fr: 'Code invalide ou expiré.', ar: 'الرمز غير صالح أو منتهي الصلاحية.' },
  invalidInvitation: { en: 'Invalid or expired invitation.', fr: 'Invitation invalide ou expirée.', ar: 'الدعوة غير صالحة أو منتهية الصلاحية.' },
  invitationNotAcceptable: {
    en: 'This invitation cannot be accepted.',
    fr: 'Cette invitation ne peut pas être acceptée.',
    ar: 'لا يمكن قبول هذه الدعوة.',
  },
  tryAgain: { en: 'Please try again.', fr: 'Veuillez réessayer.', ar: 'يرجى المحاولة مرة أخرى.' },
  verificationFailed: { en: 'Verification failed.', fr: 'La vérification a échoué.', ar: 'فشل التحقق.' },
  credentialAlreadyRegistered: {
    en: 'Credential already registered.',
    fr: 'Cet identifiant est déjà enregistré.',
    ar: 'بيانات الاعتماد هذه مسجلة بالفعل.',
  },
  noPasskey: { en: 'No passkey registered.', fr: "Aucune clé d'accès enregistrée.", ar: 'لا يوجد مفتاح مرور مسجّل.' },
  onlyFactor: {
    en: 'You cannot remove your only authentication factor.',
    fr: "Vous ne pouvez pas supprimer votre seul facteur d'authentification.",
    ar: 'لا يمكنك إزالة عامل المصادقة الوحيد لديك.',
  },
  recoveryFailed: { en: 'Recovery failed.', fr: 'La récupération a échoué.', ar: 'فشلت عملية الاسترداد.' },
  recoveryNotAvailableUntil: {
    en: 'Recovery is not available until {availableAt}.',
    fr: "La récupération n'est pas disponible avant {availableAt}.",
    ar: 'الاسترداد غير متاح قبل {availableAt}.',
  },
  unsupportedStepUp: {
    en: 'Unsupported step-up.',
    fr: 'Vérification renforcée non prise en charge.',
    ar: 'التحقق الإضافي غير مدعوم.',
  },
  stepUpRequired: {
    en: 'A valid step-up verification is required for this action.',
    fr: 'Une vérification renforcée valide est requise pour cette action.',
    ar: 'يلزم إجراء تحقق إضافي صالح لتنفيذ هذا الإجراء.',
  },
  assignmentConflict: {
    en: 'An active assignment already exists.',
    fr: 'Une affectation active existe déjà.',
    ar: 'يوجد تعيين نشط بالفعل.',
  },
  tooManyAttempts: {
    en: 'Too many attempts. Please try again later.',
    fr: 'Trop de tentatives. Veuillez réessayer plus tard.',
    ar: 'محاولات كثيرة جدًا. يرجى المحاولة لاحقًا.',
  },
  accountExists: {
    en: 'An account with these details already exists.',
    fr: 'Un compte avec ces informations existe déjà.',
    ar: 'يوجد حساب بهذه البيانات بالفعل.',
  },
  // Core V2 S2-Auth.2: authorization receipts (ADR-0067; D-A2 receipt contract §15). Never a secret, a binding value or a digest.
  receiptUnavailable: {
    en: 'Authorization receipts are not available right now; nothing was changed. Retry later.',
    fr: 'Les reçus d\'autorisation ne sont pas disponibles pour le moment ; rien n\'a été modifié. Réessayez plus tard.',
    ar: 'إيصالات التفويض غير متاحة حاليًا؛ لم يتم تغيير أي شيء. أعد المحاولة لاحقًا.',
  },
  receiptOutcomeUnknown: {
    en: 'The outcome of this request is unknown. Retry it with the same idempotency key or consumption reference.',
    fr: 'Le résultat de cette requête est inconnu. Réessayez avec la même clé d\'idempotence ou la même référence de consommation.',
    ar: 'نتيجة هذا الطلب غير معروفة. أعد المحاولة باستخدام مفتاح عدم التكرار نفسه أو مرجع الاستهلاك نفسه.',
  },
  receiptBindingInvalid: {
    en: 'The authorization details are not valid.',
    fr: 'Les détails de l\'autorisation ne sont pas valides.',
    ar: 'تفاصيل التفويض غير صالحة.',
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
  receiptIssuedResponseLost: {
    en: 'This receipt was voided because its response may have been lost. Verify again and request a new receipt.',
    fr: 'Ce reçu a été annulé car sa réponse a pu être perdue. Vérifiez à nouveau et demandez un nouveau reçu.',
    ar: 'أُلغي هذا الإيصال لأن استجابته ربما فُقدت. تحقّق مجددًا واطلب إيصالًا جديدًا.',
  },
  receiptAlreadyConsumed: {
    en: 'This receipt has already been used.',
    fr: 'Ce reçu a déjà été utilisé.',
    ar: 'تم استخدام هذا الإيصال بالفعل.',
  },
  receiptInvalid: {
    en: 'The authorization receipt is not valid.',
    fr: 'Le reçu d\'autorisation n\'est pas valide.',
    ar: 'إيصال التفويض غير صالح.',
  },
  receiptExpired: {
    en: 'The authorization receipt has expired.',
    fr: 'Le reçu d\'autorisation a expiré.',
    ar: 'انتهت صلاحية إيصال التفويض.',
  },
  authorityRevoked: {
    en: 'The approving owner no longer holds this authority.',
    fr: 'Le propriétaire ayant approuvé ne détient plus cette autorité.',
    ar: 'لم يعد المالك الذي وافق يملك هذه الصلاحية.',
  },
  consumeRefConflict: {
    en: 'This receipt or consumption reference was already used for another consumption.',
    fr: 'Ce reçu ou cette référence de consommation a déjà été utilisé pour une autre consommation.',
    ar: 'استُخدم هذا الإيصال أو مرجع الاستهلاك هذا بالفعل في استهلاك آخر.',
  },
});
