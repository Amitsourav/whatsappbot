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
  ,{
    name: '002_message_watermark',
    sql: `
      -- The last message we processed in each group.
      --
      -- After a gap, this is the point we ask the phone to replay from. A linked
      -- device can request history from the primary phone, and because
      -- leads.wa_message_id is UNIQUE, replaying a message we already handled is
      -- a no-op. That makes aggressive re-fetching safe.
      ALTER TABLE groups ADD COLUMN last_message_id TEXT;
      ALTER TABLE groups ADD COLUMN last_message_ts INTEGER;
      ALTER TABLE groups ADD COLUMN last_message_from_me INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE groups ADD COLUMN last_seen_at TEXT;
    `
  }
  ,{
    name: '003_bank_groups',
    sql: `
      -- Which bank a group represents. Must match the CRM's canonical list
      -- exactly, or every share from that group is rejected.
      ALTER TABLE groups ADD COLUMN bank_name TEXT;

      -- A lead we saw shared into a bank's group.
      --
      -- Recorded before the CRM is called, like leads, so a redelivery or a
      -- mid-flight failure is recoverable rather than duplicate-producing.
      CREATE TABLE bank_shares (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id  TEXT    NOT NULL UNIQUE,
        group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        bank_name      TEXT    NOT NULL,

        phone          TEXT    NOT NULL,
        crm_lead_id    TEXT,
        sender_phone   TEXT,
        employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        raw_message    TEXT    NOT NULL,

        -- pending   accepted, not yet sent
        -- recorded  the share is in the CRM
        -- unknown   the phone is not a lead in the CRM (the team was told)
        -- failed    gave up after retries
        status         TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','recorded','unknown','failed')),
        attempts       INTEGER NOT NULL DEFAULT 0,
        last_error     TEXT,
        notified       INTEGER NOT NULL DEFAULT 0,

        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_bank_shares_status ON bank_shares(status, attempts);
      CREATE INDEX idx_bank_shares_phone  ON bank_shares(phone);
      CREATE INDEX idx_bank_shares_lead   ON bank_shares(crm_lead_id, bank_name);

      -- Conversation about a lead inside a bank's group, ours and the bank's.
      --
      -- Kept against the lead-and-bank pair rather than the lead, so the ICICI
      -- discussion stays under ICICI.
      CREATE TABLE bank_messages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id  TEXT    NOT NULL UNIQUE,
        group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        bank_name      TEXT    NOT NULL,
        crm_lead_id    TEXT    NOT NULL,

        body           TEXT    NOT NULL,
        sender_phone   TEXT,
        is_our_team    INTEGER NOT NULL DEFAULT 0,

        status         TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','applied','failed')),
        attempts       INTEGER NOT NULL DEFAULT 0,
        last_error     TEXT,

        created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_bank_messages_status ON bank_messages(status, attempts);
      CREATE INDEX idx_bank_messages_lead   ON bank_messages(crm_lead_id, bank_name);
    `
  }
  ,{
    name: '004_tracker_outbox',
    sql: `
      -- Groups whose messages are forwarded to Tracker (Amit's task app).
      --
      -- Deliberately separate from is_active: a group can feed Tracker without
      -- being a lead group, and a lead group need not feed Tracker. Default 0,
      -- so applying this migration changes nothing until somebody opts a group in.
      ALTER TABLE groups ADD COLUMN tracker_enabled INTEGER NOT NULL DEFAULT 0;

      -- Queue of messages owed to Tracker. Written before any network call, so a
      -- restart or an outage is a delay rather than a loss — the same rule the
      -- lead pipeline follows.
      CREATE TABLE tracker_outbox (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id TEXT    NOT NULL UNIQUE,
        group_id      INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        wa_group_id   TEXT    NOT NULL,
        group_name    TEXT,
        payload       TEXT    NOT NULL,   -- the message object, JSON
        status        TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','failed')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        sent_at       TEXT
      );

      -- wa_message_id is UNIQUE, so a WhatsApp redelivery is a no-op here exactly
      -- as it is for leads.
      CREATE INDEX idx_tracker_outbox_pending
        ON tracker_outbox(status, wa_group_id) WHERE status = 'pending';
    `
  }
];

module.exports = { MIGRATIONS };
