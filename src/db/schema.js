/**
 * Database schema, applied as ordered migrations.
 *
 * Migrations run inside a transaction and are recorded in schema_migrations, so
 * every migration runs exactly once and a failure rolls back cleanly.
 *
 * NOTE ON 001: it was rewritten once, before any deployment, when the destination
 * changed from a Google Sheet to the CRM. That is the only time this is acceptable —
 * no database in the field had applied it, and carrying dead sheet columns forever
 * would have been worse. From here the append-only rule holds absolutely.
 */

/**
 * Ordered list of migrations. Append only.
 * @type {{ name: string, sql: string }[]}
 */
const MIGRATIONS = [
  {
    name: '001_initial',
    sql: `
      -- WhatsApp groups we monitor.
      --
      -- Keyed on wa_group_id ("120363…@g.us"), which WhatsApp assigns permanently.
      -- v1 matched on group NAME, so renaming a group silently stopped capture with
      -- no error. The name here is a cached label for display only.
      CREATE TABLE groups (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_group_id  TEXT    NOT NULL UNIQUE,
        name         TEXT    NOT NULL,

        -- 'inhouse' routes to the CRM (Way 1). 'bank' is Way 2, not yet designed.
        purpose      TEXT    NOT NULL DEFAULT 'inhouse'
                     CHECK (purpose IN ('inhouse', 'bank')),

        is_active    INTEGER NOT NULL DEFAULT 0,

        -- Sending is off by default and enabled per group (S5). Bank groups must
        -- never have this on.
        send_enabled INTEGER NOT NULL DEFAULT 0,

        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_groups_active ON groups(is_active);

      -- WhatsApp number -> CRM user.
      --
      -- Hand-maintained: the CRM's own users.phone is optional and null in practice
      -- (C9), so this cannot be synced. Name and email are seeded from GET /users.
      CREATE TABLE employees (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_phone        TEXT    NOT NULL UNIQUE,
        crm_profile_id  TEXT    NOT NULL,
        name            TEXT    NOT NULL,
        email           TEXT,
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_employees_profile ON employees(crm_profile_id);

      -- One row per lead message seen in a monitored group.
      --
      -- wa_message_id is UNIQUE and written BEFORE the CRM is called. WhatsApp
      -- redelivers messages after a reconnect, and a network failure mid-create
      -- leaves us unable to tell whether the CRM committed — recording first makes
      -- both cases recoverable instead of producing duplicates.
      CREATE TABLE leads (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id   TEXT    NOT NULL UNIQUE,
        group_id        INTEGER REFERENCES groups(id) ON DELETE SET NULL,

        name            TEXT,
        phone           TEXT,
        sender_phone    TEXT,
        raw_message     TEXT    NOT NULL,

        -- Who was @mentioned, and who that resolved to in the CRM.
        mentioned_phone TEXT,
        employee_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,

        crm_lead_id     TEXT,

        -- pending  accepted, not yet sent
        -- created  in the CRM
        -- existing the phone was already a lead there (Q5)
        -- held     needs a human: no mention, unknown mention, several mentions
        -- failed   gave up after retries
        status          TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','created','existing','held','failed')),
        held_reason     TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,

        -- Whether the group has been told about this lead (S2: one reply per message)
        replied         INTEGER NOT NULL DEFAULT 0,

        created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_leads_status  ON leads(status, attempts);
      CREATE INDEX idx_leads_phone   ON leads(phone);
      CREATE INDEX idx_leads_crm     ON leads(crm_lead_id);
      CREATE INDEX idx_leads_created ON leads(created_at DESC);

      -- Replies that update an existing lead.
      --
      -- Matched to the parent via the quoted message's WhatsApp ID, which is exact
      -- by construction. v1 compared quoted message TEXT and missed on any
      -- whitespace difference.
      CREATE TABLE lead_updates (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id   TEXT    NOT NULL UNIQUE,
        lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

        -- 'fields' writes CRM columns; 'remark' appends to the remarks endpoint.
        -- Never lead.notes — that is destructive and shared with the AI call
        -- pipeline (C1).
        kind            TEXT    NOT NULL CHECK (kind IN ('fields','remark')),
        payload         TEXT    NOT NULL,
        body            TEXT    NOT NULL,
        sender_phone    TEXT,

        status          TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','applied','failed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        replied         INTEGER NOT NULL DEFAULT 0,

        created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_updates_lead   ON lead_updates(lead_id);
      CREATE INDEX idx_updates_status ON lead_updates(status, attempts);

      -- Everything seen in a monitored group that produced neither a lead nor an
      -- update, with the reason.
      --
      -- This includes messages filtered as noise, which never reach the CRM but are
      -- kept here deliberately: the noise list is a guess about how people talk and
      -- will be wrong somewhere. Keeping the raw record means it can be corrected
      -- against real usage (R11.1).
      CREATE TABLE skipped_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id TEXT    NOT NULL UNIQUE,
        group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        body          TEXT    NOT NULL,
        reason        TEXT    NOT NULL,
        sender_phone  TEXT,
        reviewed      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_skipped_created ON skipped_messages(created_at DESC);
      CREATE INDEX idx_skipped_reason  ON skipped_messages(reason);

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
