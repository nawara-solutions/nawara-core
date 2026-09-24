/**
 * SMS size (SDD §6.6): GSM 03.38 7-bit when every character is in the default alphabet (an extension character costs two septets),
 * UCS-2 otherwise (Arabic, most non-Latin scripts, and some typography such as a narrow no-break space). A single message holds 160
 * septets or 70 UCS-2 units; a concatenated one 153 or 67 per segment (the rest is the concatenation header).
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENSION = '^{}\\[~]|€\f';
const BASIC = new Set(GSM_BASIC);
const EXTENSION = new Set(GSM_EXTENSION);

export interface SmsSize {
  encoding: 'GSM-7' | 'UCS-2';
  /** Septets (GSM-7) or UTF-16 code units (UCS-2). */
  units: number;
  segments: number;
}

export function smsSize(text: string): SmsSize {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (BASIC.has(ch)) septets += 1;
    else if (EXTENSION.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'GSM-7', units: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = text.length; // UTF-16 code units, as UCS-2 counts them (a surrogate pair takes two)
  return { encoding: 'UCS-2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}
