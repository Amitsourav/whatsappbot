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
const { LOCKED_LISTS } = require('../crm/fields');
const amount = require('./amount');

/** Words that are never a person's name, even on a line of their own. */
const NOT_A_NAME = new Set([
  'new lead', 'lead', 'new', 'urgent', 'please', 'pls', 'sir', 'madam', 'mam',
  'hi', 'hello', 'hey', 'fyi', 'note', 'update', 'important', 'priority',
  'today', 'tomorrow', 'follow up', 'followup', 'call', 'contact', 'student',
  'candidate', 'client', 'customer', 'enquiry', 'inquiry', 'query',
  // Things people write ABOUT a lead. Seen live: "Existing lead." was read as a
  // person's name and would have reached the CRM as one.
  'existing', 'existing lead', 'old lead', 'old', 'repeat', 'repeat lead',
  'duplicate', 'already shared', 'shared', 'reshared', 'again', 'same lead',
  'whoever', 'anyone', 'someone', 'counsellor', 'counselor',
  // Lines that describe the lead's situation. A line opening with any of these
  // is a statement, not a person: "Listed in PNB Bank", "Applied last week".
  'listed', 'applied', 'going', 'wants', 'want', 'needs', 'need', 'looking',
  'interested', 'studying', 'studied', 'completed', 'pursuing', 'planning',
  'got', 'has', 'have', 'taken', 'took', 'sent', 'submitted', 'done',
  'from', 'at', 'in', 'for', 'with', 'via', 'through', 'ref', 'reference'
]);

/**
 * A line naming a bank describes the lead's situation — where it went, who
 * rejected it — not who the person is. Built from the CRM's own bank list so the
 * two never drift apart, plus the generic word itself.
 */
const BANK_MENTION = new RegExp(
  `\\b(banks?|${LOCKED_LISTS.bank_name.map((b) => b.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'i'
);

/**
 * Words that mark a line as an institution rather than a person.
 *
 * Seen live: "SRM University" was filed as the lead's NAME and the university
 * field was left empty. The keyword makes this unambiguous — no person is called
 * "… University" — so it is safe to both reject it as a name and use it as the
 * institution, without the guessing that plain text would require.
 */
const INSTITUTION_WORDS = /\b(universit(y|ies)|colleges?|institutes?|institution|vidyalaya|academy|polytechnic|schools?|iit|nit|iiit|aiims|nift|vit|srm|amity|manipal)\b/i;

/**
 * Course and degree names.
 *
 * A closed vocabulary, like the bank list — "BDS", "MBBS", "btech" are not things
 * people are called, so recognising them is not the guess that free text would be.
 *
 * Deliberately excludes the short ambiguous ones (BE, BA, MA, MS): they appear
 * inside ordinary words and names often enough that the cost of a wrong match
 * outweighs the field being filled.
 */
const COURSE_WORDS = /\b(b\.?tech|m\.?tech|mba|bba|mbbs|bds|mds|b\.?sc|m\.?sc|bca|mca|llb|llm|ph\.?d|b\.?com|m\.?com|bachelors?|masters?|diploma|nursing|pharmacy|b\.?pharm|m\.?pharm|bpt|mpt|bhms|bams|bams|ug|pg)\b/i;

/**
 * Vocabulary that marks a line as describing the lead rather than naming them.
 *
 * Built from what the team actually writes: loan status, documents, family,
 * places, timing, and where the lead came from. Every one of these was seen
 * being read as a person's name.
 *
 * Closed vocabularies only — the same rule used for banks and courses. Nothing
 * here is a plausible Indian given name, which is what keeps real names safe.
 */
const NOT_PERSON = new RegExp('\\b(' + [
  // Loan and application status
  'sanction(ed|ing)?', 'disburs(ed|ement)', 'log(ged)?[\\s-]?in', 'login',
  'process(ing|ed)?', 'qualified', 'dnp', 'lost', 'won', 'approved', 'rejected',
  'pending', 'collected', 'submitted', 'applied', 'apply', 'eligible',
  'interested', 'reachable', 'available', 'switch(ed)?[\\s-]?off', 'busy',
  'followup', 'follow[\\s-]?up', 'callback', 'call[\\s-]?back', 'closed',
  'wrong', 'invalid', 'numbers?', 'mobiles?', 'first[\\s-]?time',
  'second[\\s-]?time', 'third[\\s-]?time', 'times?',
  // Documents and finance
  'docs?', 'documents?', 'offer[\\s-]?letter', 'visa', 'cas', 'deposit',
  'fees?', 'salary', 'income', 'itr', 'pan', 'aadhaar', 'aadhar', 'cibil',
  'collateral', 'cosigner', 'co[\\s-]?signer', 'co[\\s-]?applicant', 'guarantor',
  'property', 'security', 'margin',
  // Family
  'father', 'mother', 'parents?', 'guardian', 'brother', 'sister', 'uncle',
  'aunt', 'husband', 'wife', 'spouse', 'son', 'daughter', 'farmer', 'housewife',
  'businessman', 'employee', 'retired',
  // Timing
  'intake', 'batch', 'session', 'semester', 'fall', 'spring', 'summer',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'sept', 'jan', 'feb',
  // Where it came from
  'website', 'referred', 'reference', 'walk[\\s-]?in', 'enquiry', 'inquiry',
  'portal', 'facebook', 'instagram', 'google', 'justdial',
  // Indian states and common cities
  'delhi', 'ncr', 'mumbai', 'bangalore', 'bengaluru', 'chennai', 'kolkata',
  'hyderabad', 'pune', 'ahmedabad', 'jaipur', 'lucknow', 'patna', 'agra',
  'noida', 'gurgaon', 'gurugram', 'indore', 'bhopal', 'nagpur', 'surat',
  'kanpur', 'ranchi', 'raipur', 'guwahati', 'chandigarh', 'mohali',
  'bihar', 'punjab', 'haryana', 'gujarat', 'rajasthan', 'kerala', 'karnataka',
  'maharashtra', 'odisha', 'assam', 'jharkhand', 'chhattisgarh', 'telangana',
  'uttarakhand', 'himachal', 'goa', 'manipur', 'tripura', 'meghalaya',
  // Study destinations
  'australia', 'canada', 'germany', 'ireland', 'newzealand', 'zealand',
  'auckland', 'london', 'usa', 'america', 'europe', 'dubai', 'singapore',
  'malaysia', 'poland', 'france', 'italy', 'russia', 'georgia', 'kazakhstan'
].join('|') + ')\\b', 'i');

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
  if (INSTITUTION_WORDS.test(trimmed)) return false;
  if (BANK_MENTION.test(trimmed)) return false;
  if (COURSE_WORDS.test(trimmed)) return false;
  if (NOT_PERSON.test(trimmed)) return false;
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
 * Find a line that names an institution.
 *
 * Only a short line that is essentially just the institution counts — "SRM
 * University" yes, "he studied at SRM University last year and wants to apply
 * abroad" no, because that sentence belongs in remarks where a human reads it
 * whole.
 *
 * @param {string} text
 * @returns {string|null}
 */
function findInstitution(text) {
  for (const line of stripMentionsAndPhones(text).split('\n')) {
    const trimmed = line.trim().replace(/[.,;]+$/, '');
    if (!trimmed || trimmed.length > 60) continue;
    if (/^[A-Za-z%][A-Za-z\s%]{0,29}?\s*[:=\-–—]\s*\S/.test(trimmed)) continue;
    if (!INSTITUTION_WORDS.test(trimmed)) continue;
    // A sentence mentioning a college is not a college name.
    if (trimmed.split(/\s+/).length > 6) continue;
    return trimmed;
  }
  return null;
}

/**
 * Find a line naming a course.
 *
 * Skips the line already taken as the institution, so "Gla mathura BDS" does not
 * end up in both fields.
 *
 * @param {string} text
 * @param {string} [institution] - a line already claimed
 * @returns {string|null}
 */
function findCourse(text, institution) {
  for (const line of stripMentionsAndPhones(text).split('\n')) {
    const trimmed = line.trim().replace(/[.,;]+$/, '');
    if (!trimmed || trimmed.length > 60 || trimmed === institution) continue;
    if (/^[A-Za-z%][A-Za-z\s%]{0,29}?\s*[:=\-–—]\s*\S/.test(trimmed)) continue;
    if (!COURSE_WORDS.test(trimmed)) continue;
    if (trimmed.split(/\s+/).length > 6) continue;
    return trimmed;
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

  // Money is the one thing inferred without a label — see amount.js.
  if (!parsed.fields.loan_amount) {
    const found = amount.findInLines(text);
    if (found) parsed.fields.loan_amount = found;
  }

  // An institution names itself: a line containing "University", "College" and
  // the like cannot be a person, and needs no guessing to place.
  if (!parsed.fields.university) {
    const institution = findInstitution(text);
    if (institution) parsed.fields.university = institution;
  }

  // Same reasoning for courses — a closed vocabulary, not free text.
  if (!parsed.fields.target_degree) {
    const course = findCourse(text, parsed.fields.university);
    if (course) parsed.fields.target_degree = course;
  }

  // Everything that is not a recognised field becomes remark text, so the
  // original wording survives alongside the structured data.
  const remarkParts = [
    ...parsed.plain.filter((line) =>
      !amount.detect(line).isAmount
      && line !== parsed.fields.university
      && line !== parsed.fields.target_degree),
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
    // A missing name never blocks a lead: the phone number is the identity, and
    // a lead is complete without a name. Only an unclear ASSIGNEE holds it up.
    reason: mentions.length === 0 ? 'no_mention'
      : mentions.length > 1 ? 'multiple_mentions'
        : null
  };
}

module.exports = {
  classify, extractName, looksLikeName, stripMentionsAndPhones,
  findInstitution, findCourse
};
