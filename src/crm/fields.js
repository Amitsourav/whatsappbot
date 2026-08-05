/**
 * CRM field definitions and the WhatsApp label → field mapping.
 *
 * This file is the executable form of docs/FIELD-MAPPING.md. When the CRM changes,
 * update both. Everything here is data, deliberately: the parser reads this map, so
 * adding a label never means touching parser code.
 *
 * Source of truth: the CRM team's docs/LEAD_FIELD_REFERENCE.md, 2026-08-05.
 */

/**
 * Fields accepted by POST /leads. Anything not in this set is silently dropped by
 * the CRM with a 201 response (C10), so we validate against it before sending.
 */
const CREATE_FIELDS = new Set([
  'full_name', 'email', 'phone', 'alternate_phone', 'date_of_birth', 'gender',
  'city', 'state', 'country', 'pincode', 'highest_qualification', 'stream',
  'passing_year', 'college_name', 'university', 'percentage', 'target_degree',
  'target_intake', 'preferred_countries', 'preferred_universities',
  'lead_source_id', 'assigned_agent_id', 'custom_fields', 'tags', 'notes'
]);

/**
 * Fields accepted by PUT /leads/{id}. Everything in CREATE_FIELDS except
 * lead_source_id, plus the update-only set below.
 */
const UPDATE_ONLY_FIELDS = new Set([
  'current_stage', 'pre_counsellor_id', 'due_date', 'is_important',
  'loan_amount', 'bank_name', 'bank_status', 'docs_required', 'docs_submitted',
  'submitted_docs', 'dnp_count', 'budget', 'conversation_notes', 'agent_agenda',
  'lost_reason'
]);

const UPDATE_FIELDS = new Set([
  ...[...CREATE_FIELDS].filter((f) => f !== 'lead_source_id'),
  ...UPDATE_ONLY_FIELDS
]);

/**
 * Fields the bot must never write, whatever a message says.
 *
 * - notes            C1 — destructive, and the AI call pipeline appends there
 * - custom_fields    C2 — replace-not-merge, holds the voice pipeline's data
 * - tags             C2 — replace-not-merge
 * - phone            C3 — the lead's identity, set once at create
 * - current_stage    R5 — creation lands at `created`; we never advance a lead
 */
const NEVER_WRITE = new Set([
  'notes', 'custom_fields', 'tags', 'phone', 'current_stage',
  'lost_reason', 'dnp_count', 'due_date', 'assigned_agent_id'
]);

/**
 * Maximum lengths. The CRM's DB enforces these but Pydantic does not mirror them,
 * so over-length input returns 500 rather than 422 (C12). We truncate first.
 */
const MAX_LENGTH = {
  loan_amount: 50,
  budget: 50,
  bank_name: 100,
  primary_university: 200
};

/**
 * Locked value lists. A value that is not an exact match must never be written —
 * it is either rejected with a 400 or silently dropped (M6). Non-matching values
 * go to remarks instead.
 */
const LOCKED_LISTS = {
  bank_name: [
    'Axis', 'PNB', 'SBI', 'Yes Bank', 'ICICI', 'IDFC', 'BOI', 'Kuhoo', 'Avanse',
    'Credila', 'Propelld', 'Tata Capital', 'Zolve', 'Nomad', 'UniCred', 'Auxilo',
    'Incred', 'Edgro'
  ],
  bank_status: [
    'applied', 'docs_reviewed', 'under_review', 'loan_login', 'sanctioned',
    'pf_paid', 'disbursed'
  ]
};

/**
 * WhatsApp label → CRM field.
 *
 * Keys are matched case-insensitively with surrounding whitespace stripped.
 * Decisions D1–D3 are baked in here:
 *   D1  every college/university label resolves to `university`; `college_name`
 *       is never written
 *   D2  Course → target_degree (the CRM has no `course` field)
 *   D3  Country → preferred_countries (where they want to study), never `country`
 */
const LABEL_MAP = {
  // Identity
  'name': 'full_name',
  'full name': 'full_name',
  'student name': 'full_name',
  'email': 'email',
  'email id': 'email',
  'mail': 'email',
  'alt phone': 'alternate_phone',
  'alternate phone': 'alternate_phone',
  'alt no': 'alternate_phone',
  'alternate number': 'alternate_phone',

  // Personal
  'dob': 'date_of_birth',
  'date of birth': 'date_of_birth',
  'birth date': 'date_of_birth',
  'gender': 'gender',
  'city': 'city',
  'state': 'state',
  'pincode': 'pincode',
  'pin': 'pincode',
  'pin code': 'pincode',

  // Education — D1: all of these land on `university`
  'college': 'university',
  'clg': 'university',
  'college name': 'university',
  'university': 'university',
  'univ': 'university',
  'uni': 'university',

  // D2: no `course` field exists
  'course': 'target_degree',
  'degree': 'target_degree',
  'target degree': 'target_degree',

  'qualification': 'highest_qualification',
  'highest qualification': 'highest_qualification',
  'stream': 'stream',
  'branch': 'stream',
  'percentage': 'percentage',
  'percent': 'percentage',
  '%': 'percentage',
  'marks': 'percentage',
  'passing year': 'passing_year',
  'year of passing': 'passing_year',
  'batch': 'passing_year',
  'intake': 'target_intake',
  'target intake': 'target_intake',

  // D3: study destination, not residence
  'country': 'preferred_countries',
  'countries': 'preferred_countries',
  'preferred country': 'preferred_countries',

  // Loan — update-only (C11)
  'loan': 'loan_amount',
  'loan amount': 'loan_amount',
  'amount': 'loan_amount',
  'budget': 'loan_amount',
  'bank': 'bank_name'
};

/** Fields whose value is an array, so a comma-separated reply splits into items. */
const ARRAY_FIELDS = new Set(['preferred_countries', 'preferred_universities', 'tags']);

/** Fields that must be a number. */
const NUMERIC_FIELDS = new Set(['percentage', 'passing_year', 'docs_required']);

/**
 * Resolve a WhatsApp label to a CRM field name.
 * @param {string} label
 * @returns {string|null} the CRM field, or null if the label is unrecognised
 */
function resolveLabel(label) {
  if (!label) return null;
  const key = label.trim().toLowerCase().replace(/\s+/g, ' ');
  return LABEL_MAP[key] || null;
}

/**
 * Whether a field can be sent on create, or only on update (C11).
 * @param {string} field
 * @returns {boolean}
 */
function isUpdateOnly(field) {
  return UPDATE_ONLY_FIELDS.has(field);
}

module.exports = {
  CREATE_FIELDS,
  UPDATE_FIELDS,
  UPDATE_ONLY_FIELDS,
  NEVER_WRITE,
  MAX_LENGTH,
  LOCKED_LISTS,
  LABEL_MAP,
  ARRAY_FIELDS,
  NUMERIC_FIELDS,
  resolveLabel,
  isUpdateOnly
};
