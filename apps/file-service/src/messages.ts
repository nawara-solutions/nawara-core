import { defineMessages } from '@nawara/service-kit';

/**
 * File's own human-readable API error messages (ADR-0054 D13, Core V1 refactor R6.4), in English, French and Arabic. The keys are
 * INTERNAL message identities, never a public `code`. Every `en` text is File's existing English, byte for byte (D6). No message has a
 * parameter: nothing a client sent (a file name, a media type, a header value, a ticket) is ever placed in one. Header and parameter
 * names (`Content-Length`, `X-File-Name`, `maxBytes`, `sha-256`, `true`/`false`…) are protocol identifiers and stay verbatim.
 */
export const FILE_MESSAGES = defineMessages({
  // request headers (upload)
  contentLengthRequired: { en: 'Content-Length is required.', fr: 'Content-Length est requis.', ar: 'الترويسة Content-Length مطلوبة.' },
  contentLengthInvalid: { en: 'Content-Length is invalid.', fr: 'Content-Length est invalide.', ar: 'الترويسة Content-Length غير صالحة.' },
  organizationIdMustBeUuid: {
    en: 'X-Organization-Id must be a UUID.',
    fr: 'X-Organization-Id doit être un UUID.',
    ar: 'يجب أن تكون الترويسة X-Organization-Id معرّف UUID.',
  },
  idempotencyKeyRequired: {
    en: 'Idempotency-Key is required (1-255 printable characters).',
    fr: 'Idempotency-Key est requis (1 à 255 caractères imprimables).',
    ar: 'الترويسة Idempotency-Key مطلوبة (من 1 إلى 255 حرفًا قابلًا للطباعة).',
  },
  contentDigestInvalid: { en: 'Content-Digest is invalid.', fr: 'Content-Digest est invalide.', ar: 'الترويسة Content-Digest غير صالحة.' },
  contentDigestSha256Invalid: {
    en: 'Content-Digest sha-256 is invalid.',
    fr: 'La valeur sha-256 de Content-Digest est invalide.',
    ar: 'قيمة sha-256 في الترويسة Content-Digest غير صالحة.',
  },
  attachMustBeBoolean: {
    en: 'X-Attach must be true or false.',
    fr: 'X-Attach doit valoir true ou false.',
    ar: 'يجب أن تكون قيمة الترويسة X-Attach إما true أو false.',
  },
  fileNameEncoding: {
    en: 'X-File-Name must be percent-encoded UTF-8.',
    fr: 'X-File-Name doit être encodé en UTF-8 avec encodage pourcent.',
    ar: 'يجب أن تكون الترويسة X-File-Name بترميز UTF-8 مع الترميز المئوي.',
  },
  contentTypeInvalid: { en: 'Content-Type is invalid.', fr: 'Content-Type est invalide.', ar: 'الترويسة Content-Type غير صالحة.' },
  // upload content and transfer (ingest refusals)
  fileTooLarge: {
    en: 'The file exceeds the size allowed for this upload.',
    fr: 'Le fichier dépasse la taille autorisée pour ce téléversement.',
    ar: 'يتجاوز الملف الحجم المسموح به لهذا الرفع.',
  },
  typeNotAccepted: { en: 'The file type is not accepted.', fr: "Le type de fichier n'est pas accepté.", ar: 'نوع الملف غير مقبول.' },
  typeOrNameMismatch: {
    en: 'The declared type or file name does not match the content.',
    fr: 'Le type ou le nom de fichier déclaré ne correspond pas au contenu.',
    ar: 'النوع أو اسم الملف المصرّح به لا يطابق المحتوى.',
  },
  digestMismatch: {
    en: 'The content does not match the declared digest.',
    fr: "Le contenu ne correspond pas à l'empreinte déclarée.",
    ar: 'المحتوى لا يطابق البصمة المصرّح بها.',
  },
  uploadInterrupted: { en: 'The upload was interrupted.', fr: 'Le téléversement a été interrompu.', ar: 'انقطع الرفع.' },
  uploadStalled: { en: 'The upload stalled.', fr: "Le téléversement s'est bloqué.", ar: 'توقف الرفع عن التقدّم.' },
  uploadEndedEarly: {
    en: 'The upload ended before its declared length.',
    fr: "Le téléversement s'est terminé avant sa longueur déclarée.",
    ar: 'انتهى الرفع قبل بلوغ طوله المصرّح به.',
  },
  storageUnavailable: {
    en: 'File storage is temporarily unavailable.',
    fr: 'Le stockage des fichiers est temporairement indisponible.',
    ar: 'تخزين الملفات غير متاح مؤقتًا.',
  },
  couldNotStore: { en: 'The file could not be stored.', fr: "Le fichier n'a pas pu être stocké.", ar: 'تعذّر تخزين الملف.' },
  // upload lifecycle and caller limits
  maxBytesExceedsLimit: {
    en: "maxBytes exceeds this caller's limit.",
    fr: 'maxBytes dépasse la limite de cet appelant.',
    ar: 'تتجاوز قيمة maxBytes الحد المسموح لهذا المستدعي.',
  },
  mediaTypeNotAllowed: {
    en: 'A media type is not allowed for this caller.',
    fr: "Un type de média n'est pas autorisé pour cet appelant.",
    ar: 'أحد أنواع الوسائط غير مسموح به لهذا المستدعي.',
  },
  uploadInProgress: {
    en: 'This upload is already in progress.',
    fr: 'Ce téléversement est déjà en cours.',
    ar: 'هذا الرفع قيد التنفيذ بالفعل.',
  },
  uploadBeingRetried: {
    en: 'This upload is being retried; try again.',
    fr: 'Ce téléversement est en cours de nouvelle tentative ; réessayez.',
    ar: 'تجري إعادة محاولة هذا الرفع؛ حاول مرة أخرى.',
  },
  idempotencyKeyReused: {
    en: 'This Idempotency-Key was used for a different upload.',
    fr: 'Cette Idempotency-Key a été utilisée pour un autre téléversement.',
    ar: 'استُخدمت قيمة Idempotency-Key هذه لرفع مختلف.',
  },
  cannotAttach: {
    en: 'The file can no longer be attached.',
    fr: 'Le fichier ne peut plus être rattaché.',
    ar: 'لم يعد بالإمكان إرفاق الملف.',
  },
  uploadNotCompleted: {
    en: 'The upload could not be completed.',
    fr: "Le téléversement n'a pas pu être terminé.",
    ar: 'تعذّر إكمال الرفع.',
  },
  tooManyUploads: {
    en: 'Too many uploads in progress; retry shortly.',
    fr: 'Trop de téléversements en cours ; réessayez sous peu.',
    ar: 'عدد كبير جدًا من عمليات الرفع قيد التنفيذ؛ أعد المحاولة بعد قليل.',
  },
  // caller policy
  operationNotAllowed: {
    en: 'Operation not allowed for this caller.',
    fr: 'Opération non autorisée pour cet appelant.',
    ar: 'العملية غير مسموح بها لهذا المستدعي.',
  },
  organizationNotAllowed: {
    en: 'This caller cannot act for an organization.',
    fr: 'Cet appelant ne peut pas agir pour une organisation.',
    ar: 'لا يمكن لهذا المستدعي التصرف نيابةً عن منظمة.',
  },
  // files, download and tickets
  noSuchFile: { en: 'No such file.', fr: 'Fichier inexistant.', ar: 'الملف غير موجود.' },
  tooManyDownloads: {
    en: 'Too many downloads in progress; retry shortly.',
    fr: 'Trop de téléchargements en cours ; réessayez sous peu.',
    ar: 'عدد كبير جدًا من عمليات التنزيل قيد التنفيذ؛ أعد المحاولة بعد قليل.',
  },
  onlyImagesInline: {
    en: 'Only images may be served inline.',
    fr: 'Seules les images peuvent être servies en ligne.',
    ar: 'لا يمكن عرض سوى الصور مباشرةً.',
  },
  fileNotAvailable: { en: 'The file is not available.', fr: "Le fichier n'est pas disponible.", ar: 'الملف غير متاح.' },
  noSuchTicket: { en: 'No such ticket.', fr: 'Ticket inexistant.', ar: 'التذكرة غير موجودة.' },
  contentNotAvailable: {
    en: 'The file content is not available.',
    fr: "Le contenu du fichier n'est pas disponible.",
    ar: 'محتوى الملف غير متاح.',
  },
  couldNotRead: { en: 'The file could not be read.', fr: "Le fichier n'a pas pu être lu.", ar: 'تعذّرت قراءة الملف.' },
  fileDeleted: { en: 'The file has been deleted.', fr: 'Le fichier a été supprimé.', ar: 'تم حذف الملف.' },
  linkNotValid: { en: 'The link is not valid.', fr: "Le lien n'est pas valide.", ar: 'الرابط غير صالح.' },
  tooManyRequests: { en: 'Too many requests.', fr: 'Trop de requêtes.', ar: 'عدد كبير جدًا من الطلبات.' },
  // deletion
  uploadStillInProgress: {
    en: 'The upload is still in progress.',
    fr: 'Le téléversement est toujours en cours.',
    ar: 'لا يزال الرفع قيد التنفيذ.',
  },
  noContentToDelete: {
    en: 'The file has no content to delete.',
    fr: "Le fichier n'a aucun contenu à supprimer.",
    ar: 'لا يحتوي الملف على أي محتوى لحذفه.',
  },
});
