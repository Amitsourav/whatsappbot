/**
 * Database schema, applied as ordered migrations.
 *
 * Migrations run inside a transaction and are recorded in schema_migrations, so
 * every migration runs exactly once and a failure rolls back cleanly.
 */

/**
 * Ordered list of migrations. Append only — never edit or reorder an existing entry,
 * because databases in the field have already applied it.
 * @type {{ name: string, sql: string }[]}
 */
const MIGRATIONS = [
  {
    name: '001_initial',
    sql: `
      -- WhatsApp groups we monitor.
      --
      -- Keyed on wa_group_id (e.g. "120363012345678901@g.us") which WhatsApp
      -- assigns permanently. v1 matched on group NAME, so renaming a group
      -- silently stopped capture with no error. The name here is only a cached
      -- label for display and is refreshed whenever we see the group.
      CREATE TABLE groups (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_group_id   TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL,
        bank_column   TEXT,
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_groups_active ON groups(is_active);

      -- Every message we captured a lead from.
      --
      -- wa_message_id is UNIQUE: WhatsApp can redeliver a message after a
      -- reconnect, and this makes reprocessing a no-op instead of a duplicate row.
      CREATE TABLE leads (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id  TEXT    UNIQUE,

        name           TEXT    NOT NULL,
        -- phone is the canonical form (digits only, national number without
        -- country code where we can determine it). phone_raw preserves what
        -- was actually written, for auditing.
        phone          TEXT    NOT NULL,
        phone_raw      TEXT,
        status         TEXT,
        remark         TEXT,

        group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        bank_column    TEXT,

        raw_message    TEXT    NOT NULL,
        sender         TEXT,
        parser         TEXT,
        confidence     REAL,

        -- Sheet sync state. 'pending' rows are retried by the sync worker,
        -- so a Google API outage delays leads instead of losing them —
        -- v1 recorded the failure and never tried again.
        sheet_status   TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (sheet_status IN ('pending', 'synced', 'failed', 'skipped')),
        sheet_row      INTEGER,
        sheet_error    TEXT,
        sheet_attempts INTEGER NOT NULL DEFAULT 0,
        synced_at      TEXT,

        created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_leads_phone       ON leads(phone);
      CREATE INDEX idx_leads_created     ON leads(created_at DESC);
      CREATE INDEX idx_leads_group       ON leads(group_id);
      CREATE INDEX idx_leads_sheet_state ON leads(sheet_status, sheet_attempts);

      -- Remarks added later by replying to a lead message in WhatsApp.
      --
      -- v1 matched replies by comparing the quoted message's exact text against
      -- stored raw_message, which missed on any whitespace difference. We now
      -- match on the quoted message's ID, which is exact by construction.
      CREATE TABLE lead_remarks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        wa_message_id TEXT    UNIQUE,
        text          TEXT    NOT NULL,
        sender        TEXT,
        synced        INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_remarks_lead ON lead_remarks(lead_id);

      -- Messages seen in monitored groups that did NOT produce a lead.
      --
      -- This is the feedback loop v1 lacked: when a lead is missed, the message
      -- is here with the reason, so parser gaps are visible instead of invisible.
      CREATE TABLE skipped_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id TEXT    UNIQUE,
        group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        body          TEXT    NOT NULL,
        reason        TEXT    NOT NULL,
        sender        TEXT,
        reviewed      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_skipped_created  ON skipped_messages(created_at DESC);
      CREATE INDEX idx_skipped_reviewed ON skipped_messages(reviewed);

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE logs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        level     TEXT NOT NULL,
        message   TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_logs_id ON logs(id DESC);
    `
  }
];

module.exports = { MIGRATIONS };
