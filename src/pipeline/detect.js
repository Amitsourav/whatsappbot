/**
 * Lead detection (R8).
 *
 * A message is a new lead when it carries BOTH a phone number and an employee
 * `@mention`. Both, always — one without the other is ordinary group chat.
 *
 * Name extraction is best-effort but never invents: `full_name` is required by the
 * CRM, so if no name can be found the lead is held for a human rather than filed
 * under a guess. A lead named "Sir" or "Please" in the CRM is worse than one
 * waiting in the panel.
 */
const phoneUtil = require('./phone');
const labelParser = require('./labels');

/** Words that are never a person's name, even on a line of their own. */
const NOT_A_NAME = new Set([
  'new lead', 'lead', 'new', 'urgent', 'please', 'pls', 'sir', 'madam', 'mam',
  'hi', 'hello', 'hey', 'fyi', 'note', 'update', 'important', 'priority',
  'today', 'tomorrow', 'follow up', 'followup', 'call', 'contact', 'student',
  'candidate', 'client', 'customer', 'enquiry', 'inquiry', 'query'
]);

/** A plausible human name: letters and common name punctuation, 2–60 chars. */
const NAME_SHAPE = /^[\p{L}][\p{L}\s.'-]{1,59}$/u;

/**
 * Decide whether a line could be a person's name.
 * @param {string} line
 * @returns {boolean}
 */
function looksLikeName(line) {
  const trimmed = line.trim().replace(/[.,;:]+$/, '');
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  const lower = trimmed.toLowerCase();
  if (NOT_A_NAME.has(lower)) return false;
  // "please call", "new lead Priya" — a line opening with filler is an instruction,
  // not a name.
  if (NOT_A_NAME.has(lower.split(/\s+/)[0])) return false;
  if (/\d/.test(trimmed)) return false;
  if (!NAME_SHAPE.test(trimmed)) return false;

  // "call him tomorrow" is a sentence, not a name. Names are rarely 5+ words.
  if (trimmed.split(/\s+/).length > 4) return false;

  return true;
}

/**
 * Remove @mention placeholders and phone numbers so what remains is candidate
 * name text.
 * @param {string} text
 * @returns {string}
 */
function stripMentionsAndPhones(text) {
  return String(text || '')
    // WhatsApp renders mentions in the body as "@919876543210".
    .replace(/@\d[\d \t-]{6,}/g, ' ')
    .replace(/\+?\d[\d \t\-().]{8,}\d/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Find the lead's name.
 *
 * Order of preference:
 *   1. An explicit `Name:` label — unambiguous, so it wins
 *   2. The first remaining line that looks like a person's name
 *
 * @param {string} text
 * @returns {string|null} null when nothing convincing was found
 */
function extractName(text) {
  const parsed = labelParser.parse(text);
  if (parsed.fields.full_name) return parsed.fields.full_name;

  for (const line of stripMentionsAndPhones(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip lines that are labelled fields — "City: Delhi" is not a name.
    if (/^[A-Za-z%][A-Za-z\s%]{0,29}?\s*[:=\-–—]\s*\S/.test(trimmed)) continue;
    if (looksLikeName(trimmed)) return trimmed.replace(/[.,;:]+$/, '');
  }

  return null;
}

/**
 * Classify an incoming group message.
 *
 * @param {{ text: string|null, mentions: string[] }} message
 * @returns {{
 *   isLead: boolean,
 *   phone: string|null,
 *   name: string|null,
 *   mentions: string[],
 *   fields: Object,
 *   remarkText: string|null,
 *   reason: string|null
 * }}
 *   `reason` explains a negative result, and is recorded on skipped messages so a
 *   detection gap is visible rather than silent.
 */
function classify(message) {
  const text = message?.text || '';
  const mentions = message?.mentions || [];

  const empty = {
    isLead: false, phone: null, name: null, mentions,
    fields: {}, remarkText: null, reason: null
  };

  if (!text.trim()) return { ...empty, reason: 'no_text' };

  // The message body renders a mention as "@919812345678", so a naive extraction
  // picks up the EMPLOYEE's number as the lead's phone. Excluding the mentioned
  // numbers is what stops a lead being filed under the person it was assigned to.
  const mentionSet = new Set(mentions);
  const phones = phoneUtil.extract(text).filter((p) => !mentionSet.has(p));

  // R8 — both are required. Neither alone makes a lead.
  if (phones.length === 0 && mentions.length === 0) {
    return { ...empty, reason: 'not_a_lead' };
  }
  if (phones.length === 0) {
    return { ...empty, reason: 'no_phone' };
  }

  const parsed = labelParser.parse(text);
  const name = extractName(text);

  // Everything that is not a recognised field becomes remark text, so the
  // original wording survives alongside the structured data.
  const remarkParts = [
    ...parsed.plain,
    ...parsed.rejected.map((r) => `${r.label}: ${r.value}`)
  ];

  return {
    isLead: true,
    phone: phones[0],
    extraPhones: phones.slice(1),
    name,
    mentions,
    fields: parsed.fields,
    rejected: parsed.rejected,
    remarkText: remarkParts.length ? remarkParts.join('\n') : null,
    reason: mentions.length === 0 ? 'no_mention'
      : mentions.length > 1 ? 'multiple_mentions'
        : name ? null : 'no_name'
  };
}

module.exports = { classify, extractName, looksLikeName, stripMentionsAndPhones };
