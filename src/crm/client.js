/**
 * CRM HTTP client.
 *
 * Every constraint from docs/CRM-INTEGRATION.md is enforced here rather than at the
 * call sites, so a caller cannot accidentally bypass one:
 *
 *   C10  unknown keys are silently ignored on create — a 201 is not proof the data
 *        landed, so payloads are validated against the accepted-field list first
 *   C11  loan_amount and bank_name are update-only — create then patch
 *   C12  over-length input returns 500, not 422 — truncate before sending
 *   C13  assigned_agent_id is unvalidated — a bad UUID 500s at the FK
 *   B2   duplicates return existing_lead_id, so "already exists" becomes
 *        "update that one" in a single hop
 *
 * The client never issues DELETE. The CRM blocks it at the middleware anyway, but
 * we do not rely on their guard to enforce our own rule.
 */
const { config } = require('../config');
const logger = require('../logger');
const {
  CREATE_FIELDS, UPDATE_FIELDS, NEVER_SEND, UPDATE_FORBIDDEN, MAX_LENGTH,
  UPDATE_ONLY_FIELDS
} = require('./fields');

/** Retry only on transport failures and 5xx. A 4xx means the request was wrong. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

/**
 * The CRM's database is in Korea and routinely takes 2–20s per request. A short
 * timeout would turn ordinary slowness into a retry storm, and for a non-idempotent
 * POST that means duplicates.
 */
const REQUEST_TIMEOUT_MS = 45_000;

/** Stages where a lead is finished. A remark here lands on a record nobody watches. */
const TERMINAL_STAGES = new Set(['disbursed', 'lost', 'enrolled']);

class CrmError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

/**
 * A create that collided with an existing lead. Carries the existing lead's id so
 * the caller can switch to updating it without a search (B2).
 */
class DuplicateLeadError extends CrmError {
  constructor(body) {
    super(body?.detail || 'Duplicate lead', { status: 400, body });
    this.name = 'DuplicateLeadError';
    this.existingLeadId = body?.existing_lead_id || null;
    this.existingLeadName = body?.existing_lead_name || null;
    this.duplicateField = body?.duplicate_field || null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CrmClient {
  /**
   * @param {{ baseUrl?: string, apiKey?: string, fetchImpl?: Function }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || config.crm.baseUrl || '').replace(/\/$/, '');
    this.apiKey = options.apiKey || config.crm.apiKey;
    this.fetch = options.fetchImpl || globalThis.fetch;
    /** @type {Map<string, object>|null} profile id → user, populated by loadUsers() */
    this.users = null;
  }

  get configured() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  /**
   * Issue a request, retrying transport failures and 5xx with exponential backoff.
   * @private
   */
  async request(method, path, body) {
    if (method === 'DELETE') {
      // Our own rule, enforced before the CRM's middleware ever sees it.
      throw new CrmError('The integration never issues DELETE');
    }
    if (!this.configured) {
      throw new CrmError('CRM is not configured — set CRM_BASE_URL and CRM_API_KEY');
    }

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch (error) {
        // Network-level failure. We cannot tell whether the server processed it,
        // so the caller must have recorded the attempt before calling us.
        lastError = new CrmError(`Network error: ${error.message}`, { retryable: true });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }

      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { detail: text.slice(0, 500) };
        }
      }

      if (response.ok) return payload;

      if (payload?.error_code === 'duplicate_lead') {
        throw new DuplicateLeadError(payload);
      }

      const retryable = RETRY_STATUS.has(response.status);
      lastError = new CrmError(
        `${method} ${path} → ${response.status}: ${payload?.detail || 'no detail'}`,
        { status: response.status, body: payload, retryable }
      );

      if (retryable && attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(`CRM ${response.status} on ${path}, retrying in ${delay}ms (attempt ${attempt})`);
        await sleep(delay);
        continue;
      }

      throw lastError;
    }

    throw lastError;
  }

  /**
   * Strip anything the CRM would reject, ignore, or 500 on.
   *
   * @param {Object} input
   * @param {'create'|'update'} mode
   * @returns {{ payload: Object, dropped: {field: string, reason: string}[] }}
   */
  sanitise(input, mode) {
    const allowed = mode === 'create' ? CREATE_FIELDS : UPDATE_FIELDS;
    const payload = {};
    const dropped = [];

    for (const [field, value] of Object.entries(input || {})) {
      if (value === undefined || value === null) continue;

      if (NEVER_SEND.has(field)) {
        dropped.push({ field, reason: 'never_send' });
        continue;
      }

      // phone is required on create (it is what deduplicates) but must never be
      // patched afterwards — C3.
      if (mode === 'update' && UPDATE_FORBIDDEN.has(field)) {
        dropped.push({ field, reason: 'update_forbidden' });
        continue;
      }

      if (!allowed.has(field)) {
        // C10 — the CRM would accept this with a 201 and silently discard it.
        dropped.push({
          field,
          reason: mode === 'create' && UPDATE_ONLY_FIELDS.has(field)
            ? 'update_only'
            : 'not_accepted'
        });
        continue;
      }

      const max = MAX_LENGTH[field];
      payload[field] = (max && typeof value === 'string') ? value.slice(0, max) : value;
    }

    return { payload, dropped };
  }

  /**
   * Confirm the key resolves to the tenant we expect, before any write.
   *
   * The same email can exist in both tenants with different profile ids, so an id
   * carried between environments points at a different person. This is the cheap
   * check that catches a mis-set key before it writes to the wrong company.
   *
   * @returns {Promise<object>} the service account
   * @throws if the tenant does not match config.crm.expectedCompanyId
   */
  async verifyTenant() {
    const me = await this.whoami();
    const expected = config.crm.expectedCompanyId;

    if (expected && me.company_id !== expected) {
      throw new CrmError(
        `Wrong CRM tenant. The key belongs to "${me.company_name}" (${me.company_id}) `
        + `but CRM_EXPECTED_COMPANY_ID is ${expected}. Refusing to write.`
      );
    }

    this.identity = me;
    return me;
  }

  /**
   * Read a lead.
   * @param {string} leadId
   * @returns {Promise<object>}
   */
  async getLead(leadId) {
    return this.request('GET', `/leads/${leadId}`);
  }

  /**
   * Whether a lead is finished, so a remark would land where nobody is looking.
   * @param {object} lead
   * @returns {boolean}
   */
  static isTerminal(lead) {
    return TERMINAL_STAGES.has(lead?.current_stage);
  }

  /**
   * Load the CRM user list and cache it.
   * Needed to validate assigned_agent_id before sending (C13).
   * @returns {Promise<object[]>}
   */
  async loadUsers() {
    const list = await this.request('GET', '/users');
    this.users = new Map(list.map((u) => [u.id, u]));
    logger.info(`Loaded ${this.users.size} CRM users`);
    return list;
  }

  /**
   * @param {string} profileId
   * @returns {boolean}
   */
  isKnownUser(profileId) {
    if (!this.users) throw new CrmError('User list not loaded — call loadUsers() first');
    return this.users.has(profileId);
  }

  /**
   * Create a lead.
   *
   * Fields that are update-only are returned in `deferred` rather than dropped, so
   * the caller can patch them immediately afterwards (C11).
   *
   * @param {Object} fields
   * @returns {Promise<{ lead: Object, deferred: Object, dropped: Array }>}
   * @throws {DuplicateLeadError} carrying existingLeadId
   */
  async createLead(fields) {
    if (!fields.full_name) throw new CrmError('full_name is required');

    if (fields.assigned_agent_id && this.users && !this.isKnownUser(fields.assigned_agent_id)) {
      // C13 — an unknown UUID 500s at the foreign key, which is indistinguishable
      // from a real outage to a retry loop.
      throw new CrmError(`Unknown assigned_agent_id: ${fields.assigned_agent_id}`);
    }

    const { payload, dropped } = this.sanitise(fields, 'create');

    // Keep update-only values for the follow-up patch instead of losing them.
    const deferred = {};
    for (const { field, reason } of dropped) {
      if (reason === 'update_only') deferred[field] = fields[field];
    }

    const lead = await this.request('POST', '/leads', payload);

    if (!lead?.id) {
      // Without an id we cannot link the WhatsApp thread to the record, which
      // breaks every follow-up update.
      throw new CrmError('Create succeeded but returned no id', { body: lead });
    }

    return { lead, deferred, dropped: dropped.filter((d) => d.reason !== 'update_only') };
  }

  /**
   * Partially update a lead. PUT is a genuine patch (exclude_unset=True).
   * @param {string} leadId
   * @param {Object} fields
   * @returns {Promise<{ lead: Object, dropped: Array }>}
   */
  async updateLead(leadId, fields) {
    const { payload, dropped } = this.sanitise(fields, 'update');
    if (Object.keys(payload).length === 0) {
      return { lead: null, dropped };
    }
    const lead = await this.request('PUT', `/leads/${leadId}`, payload);
    return { lead, dropped };
  }

  /**
   * Append a remark. This is the ONLY way we write notes — `lead.notes` is
   * destructive and shared with the AI call pipeline (C1).
   * @param {string} leadId
   * @param {string} text
   * @returns {Promise<Object>}
   */
  async addRemark(leadId, text, sourceId) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new CrmError('Remark text is empty');

    // The remarks endpoint is not idempotent: a retry after a timeout appends a
    // second copy. Stamping the WhatsApp message id makes a duplicate obvious
    // rather than mysterious, and lets a human trace it back to the message.
    const stamped = sourceId ? `${trimmed}\n\n[wa:${sourceId}]` : trimmed;

    // Their validation is 1–5000 with a clean 422; truncate rather than fail.
    return this.request('POST', `/leads/${leadId}/remarks`, { body: stamped.slice(0, 5000) });
  }

  /** @returns {Promise<Object>} the authenticated service account */
  async whoami() {
    return this.request('GET', '/users/me');
  }
}

module.exports = { CrmClient, CrmError, DuplicateLeadError };
