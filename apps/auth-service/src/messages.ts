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
});
