import { defineMessages, type MessageTexts } from '../i18n/catalog.js';

/**
 * ADR-0054 D13: the text of the kit's own GENERIC errors (no domain wording lives here). Every `en` text is the kit's existing English
 * message, byte for byte (D6); `kit-messages.spec.ts` pins that against the filter's status table.
 */
export const KIT_MESSAGES = defineMessages({
  internal_error: { en: 'Internal server error', fr: 'Erreur interne du serveur', ar: 'خطأ داخلي في الخادم' },
  rate_limited: { en: 'Too many requests.', fr: 'Trop de requêtes.', ar: 'عدد كبير جدًا من الطلبات.' },
  operation_not_permitted: {
    en: 'This operation is not permitted for the calling service.',
    fr: "Cette opération n'est pas autorisée pour le service appelant.",
    ar: 'هذه العملية غير مسموح بها للخدمة المستدعية.',
  },
  hierarchy_unavailable: {
    en: 'The organization hierarchy could not be verified; nothing was changed. Retry later.',
    fr: "La hiérarchie de l'organisation n'a pas pu être vérifiée ; rien n'a été modifié. Réessayez plus tard.",
    ar: 'تعذّر التحقق من الهيكل التنظيمي؛ لم يتم تغيير أي شيء. أعد المحاولة لاحقًا.',
  },
  // The generic text of an HTTP status, used where the message IS that text today: a Nest exception thrown with its default message
  // (`new UnauthorizedException()`) and a client error raised by Express middleware (body parser). `en` equals `STATUS_TEXT`.
  status_400: { en: 'Bad Request', fr: 'Requête invalide', ar: 'طلب غير صالح' },
  status_401: { en: 'Unauthorized', fr: 'Authentification requise', ar: 'المصادقة مطلوبة' },
  status_403: { en: 'Forbidden', fr: 'Accès refusé', ar: 'الوصول مرفوض' },
  status_404: { en: 'Not Found', fr: 'Introuvable', ar: 'غير موجود' },
  status_408: { en: 'Request Timeout', fr: 'Délai de la requête dépassé', ar: 'انتهت مهلة الطلب' },
  status_409: { en: 'Conflict', fr: 'Conflit', ar: 'تعارض' },
  status_411: { en: 'Length Required', fr: 'Longueur requise', ar: 'الطول مطلوب' },
  status_413: { en: 'Payload Too Large', fr: 'Contenu trop volumineux', ar: 'حجم المحتوى كبير جدًا' },
  status_415: { en: 'Unsupported Media Type', fr: 'Type de contenu non pris en charge', ar: 'نوع المحتوى غير مدعوم' },
  status_422: { en: 'Unprocessable Entity', fr: 'Requête impossible à traiter', ar: 'تعذّرت معالجة الطلب' },
  status_429: { en: 'Too Many Requests', fr: 'Trop de requêtes', ar: 'عدد كبير جدًا من الطلبات' },
  status_500: { en: 'Internal Server Error', fr: 'Erreur interne du serveur', ar: 'خطأ داخلي في الخادم' },
  status_502: { en: 'Bad Gateway', fr: 'Passerelle défaillante', ar: 'بوابة غير صالحة' },
  status_503: { en: 'Service Unavailable', fr: 'Service indisponible', ar: 'الخدمة غير متاحة' },
});

/** The generic status text for `status`, if the kit has one. */
export function statusMessage(status: number): MessageTexts | undefined {
  return (KIT_MESSAGES as Readonly<Record<string, MessageTexts>>)[`status_${status}`];
}
