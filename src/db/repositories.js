/**
 * Data access. All SQL lives here — nothing else in the codebase writes queries.
 */
const { get } = require('./index');

/** Groups we monitor. */
const groups = {
  /** Insert or refresh a group's cached name. Does not change its active flag. */
  upsert(waGroupId, name) {
    get().prepare(`
      INSERT INTO groups (wa_group_id, name) VALUES (?, ?)
      ON CONFLICT(wa_group_id) DO UPDATE SET
        name = excluded.name,
        updated_at = datetime('now')
    `).run(waGroupId, name);
    return this.byWaId(waGroupId);
  },

  byWaId(waGroupId) {
    return get().prepare('SELECT * FROM groups WHERE wa_group_id = ?').get(waGroupId) || null;
  },

  all() {
    return get().prepare('SELECT * FROM groups ORDER BY is_active DESC, name').all();
  },

  active() {
    return get().prepare('SELECT * FROM groups WHERE is_active = 1').all();
  },

  setActive(id, isActive) {
    get().prepare("UPDATE groups SET is_active = ?, updated_at = datetime('now') WHERE id = ?")
      .run(isActive ? 1 : 0, id);
  },

  /**
   * Enable or disable sending for a group (S5).
   * Bank groups can never send, whatever is requested — they are not ours.
   */
  setSendEnabled(id, enabled) {
    get().prepare(`
      UPDATE groups
      SET send_enabled = CASE WHEN purpose = 'bank' THEN 0 ELSE ? END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(enabled ? 1 : 0, id);
  },

  /**
   * Remember the newest message seen in a group — the point to replay from after
   * a gap.
   */
  setWatermark(waGroupId, { id, timestamp, fromMe }) {
    get().prepare(`
      UPDATE groups
      SET last_message_id = ?, last_message_ts = ?, last_message_from_me = ?,
          last_seen_at = datetime('now')
      WHERE wa_group_id = ?
        AND (last_message_ts IS NULL OR last_message_ts <= ?)
    `).run(id, timestamp, fromMe ? 1 : 0, waGroupId, timestamp);
  },

  setPurpose(id, purpose) {
    get().prepare(`
      UPDATE groups
      SET purpose = ?,
          send_enabled = CASE WHEN ? = 'bank' THEN 0 ELSE send_enabled END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(purpose, purpose, id);
  }
};

/** WhatsApp number → CRM user (C9 — hand-maintained). */
const employees = {
  upsert({ waPhone, crmProfileId, name, email }) {
    get().prepare(`
      INSERT INTO employees (wa_phone, crm_profile_id, name, email) VALUES (?, ?, ?, ?)
      ON CONFLICT(wa_phone) DO UPDATE SET
        crm_profile_id = excluded.crm_profile_id,
        name = excluded.name,
        email = excluded.email,
        updated_at = datetime('now')
    `).run(waPhone, crmProfileId, name, email || null);
    return this.byPhone(waPhone);
  },

  byPhone(waPhone) {
    return get().prepare('SELECT * FROM employees WHERE wa_phone = ? AND is_active = 1')
      .get(waPhone) || null;
  },

  all() {
    return get().prepare('SELECT * FROM employees ORDER BY name').all();
  },

  remove(id) {
    get().prepare('DELETE FROM employees WHERE id = ?').run(id);
  }
};

/** Leads captured from WhatsApp. */
const leads = {
  /**
   * Record a lead BEFORE the CRM is called.
   *
   * Returns null if this message was already recorded — WhatsApp redelivers after
   * a reconnect, and this is what makes reprocessing a no-op rather than a
   * duplicate lead.
   */
  create(row) {
    const result = get().prepare(`
      INSERT OR IGNORE INTO leads
        (wa_message_id, group_id, name, phone, sender_phone, raw_message,
         mentioned_phone, employee_id, status, held_reason)
      VALUES (@waMessageId, @groupId, @name, @phone, @senderPhone, @rawMessage,
              @mentionedPhone, @employeeId, @status, @heldReason)
    `).run({
      heldReason: null, employeeId: null, mentionedPhone: null,
      name: null, phone: null, senderPhone: null, groupId: null,
      status: 'pending', ...row
    });

    return result.changes === 0 ? null : this.byId(result.lastInsertRowid);
  },

  byId(id) {
    return get().prepare('SELECT * FROM leads WHERE id = ?').get(id) || null;
  },

  byWaMessageId(waMessageId) {
    return get().prepare('SELECT * FROM leads WHERE wa_message_id = ?').get(waMessageId) || null;
  },

  markCreated(id, crmLeadId) {
    get().prepare(`
      UPDATE leads SET status = 'created', crm_lead_id = ?, last_error = NULL,
                       updated_at = datetime('now')
      WHERE id = ?
    `).run(crmLeadId, id);
  },

  /** The phone already existed in the CRM (Q5). Assignment is deliberately untouched. */
  markExisting(id, crmLeadId) {
    get().prepare(`
      UPDATE leads SET status = 'existing', crm_lead_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(crmLeadId, id);
  },

  /** Waiting on a human — no mention, unknown mention, or several (Q6/Q9). */
  markHeld(id, reason) {
    get().prepare(`
      UPDATE leads SET status = 'held', held_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, id);
  },

  markFailed(id, error) {
    get().prepare(`
      UPDATE leads SET status = 'failed', last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(error).slice(0, 1000), id);
  },

  /** Count an attempt. Called once before each CRM call, so a crash mid-flight
   *  still counts and cannot retry forever. */
  recordAttempt(id) {
    get().prepare(`
      UPDATE leads SET attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?
    `).run(id);
  },

  /** Record why an attempt failed, without counting it twice. */
  recordError(id, error) {
    get().prepare(`
      UPDATE leads SET last_error = ?, updated_at = datetime('now') WHERE id = ?
    `).run(String(error).slice(0, 1000), id);
  },

  markReplied(id) {
    get().prepare('UPDATE leads SET replied = 1 WHERE id = ?').run(id);
  },

  /** Leads still owed a CRM write. Ordered oldest first so nothing starves. */
  pending(limit = 20) {
    return get().prepare(`
      SELECT * FROM leads
      WHERE status = 'pending' AND attempts < 8
      ORDER BY created_at ASC LIMIT ?
    `).all(limit);
  },

  held() {
    return get().prepare(`
      SELECT l.*, g.name AS group_name
      FROM leads l LEFT JOIN groups g ON g.id = l.group_id
      WHERE l.status = 'held' ORDER BY l.created_at DESC
    `).all();
  },

  recent(limit = 50) {
    return get().prepare(`
      SELECT l.*, g.name AS group_name, e.name AS employee_name
      FROM leads l
      LEFT JOIN groups g ON g.id = l.group_id
      LEFT JOIN employees e ON e.id = l.employee_id
      ORDER BY l.created_at DESC LIMIT ?
    `).all(limit);
  },

  assign(id, employeeId, mentionedPhone) {
    get().prepare(`
      UPDATE leads SET employee_id = ?, mentioned_phone = ?, status = 'pending',
                       held_reason = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(employeeId, mentionedPhone, id);
  }
};

/** Field updates and remarks arriving as replies. */
const leadUpdates = {
  create(row) {
    const result = get().prepare(`
      INSERT OR IGNORE INTO lead_updates
        (wa_message_id, lead_id, kind, payload, body, sender_phone)
      VALUES (@waMessageId, @leadId, @kind, @payload, @body, @senderPhone)
    `).run({ senderPhone: null, ...row });

    return result.changes === 0 ? null : this.byId(result.lastInsertRowid);
  },

  byId(id) {
    return get().prepare('SELECT * FROM lead_updates WHERE id = ?').get(id) || null;
  },

  markApplied(id) {
    get().prepare("UPDATE lead_updates SET status = 'applied' WHERE id = ?").run(id);
  },

  markFailed(id, error) {
    get().prepare(`
      UPDATE lead_updates SET status = 'failed', last_error = ? WHERE id = ?
    `).run(String(error).slice(0, 1000), id);
  },

  recordAttempt(id) {
    get().prepare('UPDATE lead_updates SET attempts = attempts + 1 WHERE id = ?').run(id);
  },

  recordError(id, error) {
    get().prepare('UPDATE lead_updates SET last_error = ? WHERE id = ?')
      .run(String(error).slice(0, 1000), id);
  },

  markReplied(id) {
    get().prepare('UPDATE lead_updates SET replied = 1 WHERE id = ?').run(id);
  },

  pending(limit = 20) {
    return get().prepare(`
      SELECT u.*, l.crm_lead_id
      FROM lead_updates u JOIN leads l ON l.id = u.lead_id
      WHERE u.status = 'pending' AND u.attempts < 8 AND l.crm_lead_id IS NOT NULL
      ORDER BY u.created_at ASC LIMIT ?
    `).all(limit);
  }
};

/** Messages that produced nothing, kept with a reason. */
const skipped = {
  record({ waMessageId, groupId, body, reason, senderPhone }) {
    get().prepare(`
      INSERT OR IGNORE INTO skipped_messages
        (wa_message_id, group_id, body, reason, sender_phone)
      VALUES (?, ?, ?, ?, ?)
    `).run(waMessageId, groupId || null, body || '', reason, senderPhone || null);
  },

  recent(limit = 100) {
    return get().prepare(`
      SELECT s.*, g.name AS group_name
      FROM skipped_messages s LEFT JOIN groups g ON g.id = s.group_id
      ORDER BY s.created_at DESC LIMIT ?
    `).all(limit);
  },

  /** Counts by reason — the fastest way to spot a parser gap. */
  reasonCounts() {
    return get().prepare(`
      SELECT reason, COUNT(*) AS count FROM skipped_messages
      GROUP BY reason ORDER BY count DESC
    `).all();
  }
};

const settings = {
  get(key, fallback = null) {
    const row = get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },

  set(key, value) {
    get().prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, String(value));
  },

  all() {
    return Object.fromEntries(
      get().prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])
    );
  }
};

const logs = {
  record(level, message, retain) {
    const db = get();
    db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').run(level, message);
    if (retain && Math.random() < 0.02) {
      db.prepare(`
        DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)
      `).run(retain);
    }
  },

  recent(limit = 200) {
    return get().prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit).reverse();
  }
};

module.exports = { groups, employees, leads, leadUpdates, skipped, settings, logs };
