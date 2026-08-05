/**
 * Phone number extraction and normalisation.
 *
 * Deliberately mirrors the CRM's own `normalize_phone` (C14) so we can predict
 * whether a number will deduplicate before we send it. Their rules:
 *
 *   0091XXXXXXXXXX -> +91XXXXXXXXXX
 *   91XXXXXXXXXX   -> +91XXXXXXXXXX
 *   0XXXXXXXXXX    -> +91XXXXXXXXXX
 *   10 digits      -> +91XXXXXXXXXX
 *   anything else  -> stored verbatim
 *
 * That last case is why extraction matters as much as normalisation: anything we
 * pass through that isn't a clean Indian number gets stored raw and will never
 * dedupe against its normalised twin. So we only ever emit clean digits.
 */

/** Indian mobile numbers are 10 digits and begin 6–9. */
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Strip everything that isn't a digit or a leading plus.
 * @param {string} raw
 * @returns {string}
 */
function stripFormatting(raw) {
  return String(raw).trim().replace(/[\s\-().]/g, '');
}

/**
 * Normalise a phone number the same way the CRM will.
 *
 * @param {string} raw
 * @returns {{ e164: string|null, national: string|null, normalised: boolean }}
 *   `normalised` is false when the CRM would store the value verbatim — meaning
 *   it will not deduplicate. Callers should treat that as a reason to skip, not
 *   as a valid number.
 */
function normalise(raw) {
  if (!raw) return { e164: null, national: null, normalised: false };

  let s = stripFormatting(raw);
  s = s.replace(/^\+/, '');

  let national = null;

  if (/^0091\d{10}$/.test(s)) {
    national = s.slice(4);
  } else if (/^91\d{10}$/.test(s)) {
    national = s.slice(2);
  } else if (/^0\d{10}$/.test(s)) {
    national = s.slice(1);
  } else if (/^\d{10}$/.test(s)) {
    national = s;
  }

  if (!national || !INDIAN_MOBILE.test(national)) {
    return { e164: null, national: null, normalised: false };
  }

  return { e164: `+91${national}`, national, normalised: true };
}

/**
 * Find phone numbers in a block of text.
 *
 * Conservative on purpose. A WhatsApp lead message contains pincodes, loan amounts,
 * percentages and years, and treating any of those as a phone number would create a
 * junk lead — worse than missing one, because it lands in the CRM looking real.
 *
 * @param {string} text
 * @returns {string[]} unique E.164 numbers, in order of appearance
 */
function extract(text) {
  if (!text) return [];

  const found = [];
  const seen = new Set();

  // Match runs that could be a number with optional country code and separators.
  // Requires at least 10 digits so 6-digit pincodes and 4-digit years never match.
  //
  // Spaces and tabs are allowed inside a run but NOT newlines: with \s, two
  // numbers on consecutive lines merge into one over-long run, which is then
  // rejected as too long — losing both.
  const candidates = text.match(/\+?\d[\d \t\-().]{8,}\d/g) || [];

  for (const candidate of candidates) {
    const digits = stripFormatting(candidate).replace(/^\+/, '');

    // A run longer than a country code plus a mobile number is not a phone number —
    // it's an account number, an ID, or two numbers that ran together.
    if (digits.length > 13) continue;

    const { e164, normalised } = normalise(candidate);
    if (normalised && !seen.has(e164)) {
      seen.add(e164);
      found.push(e164);
    }
  }

  return found;
}

/**
 * Convert a WhatsApp JID to a normalised number.
 * Mentions arrive as "919876543210@s.whatsapp.net".
 *
 * @param {string} jid
 * @returns {string|null} E.164, or null if it isn't a normalisable Indian number
 */
function fromJid(jid) {
  if (!jid) return null;
  const digits = String(jid).split('@')[0].split(':')[0];
  return normalise(digits).e164;
}

module.exports = { normalise, extract, fromJid, stripFormatting };
