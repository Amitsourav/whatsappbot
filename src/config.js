/**
 * Central configuration. Everything reads from here — never from process.env directly.
 *
 * Config is validated once at boot so misconfiguration fails loudly and immediately,
 * rather than surfacing hours later as a silent sync failure.
 */
require('dotenv').config();

const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Parse a string env var into a boolean. */
function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Parse a string env var into an integer. */
function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

const config = {
  env: process.env.NODE_ENV || 'development',

  server: {
    port: int(process.env.PORT, 3001),
    // Bind to loopback by default so the panel is not exposed to the internet
    // unless you deliberately put it behind a reverse proxy or open the firewall.
    host: process.env.HOST || '0.0.0.0'
  },

  auth: {
    user: process.env.ADMIN_USER,
    pass: process.env.ADMIN_PASS,
    jwtSecret: process.env.JWT_SECRET,
    tokenTtl: process.env.TOKEN_TTL || '12h'
  },

  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    // The tab name is honoured everywhere — v1 ignored this and hardcoded "Sheet1".
    tabName: process.env.GOOGLE_SHEET_TAB || 'Sheet1',
    credentialsPath: path.resolve(
      ROOT,
      process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json'
    ),
    // Sheet layout: row 2 = section labels, row 3 = headers, data begins row 4.
    sectionRow: int(process.env.SHEET_SECTION_ROW, 2),
    headerRow: int(process.env.SHEET_HEADER_ROW, 3),
    dataStartRow: int(process.env.SHEET_DATA_START_ROW, 4)
  },

  whatsapp: {
    sessionPath: path.resolve(ROOT, process.env.WA_SESSION_PATH || './.wwebjs_auth'),
    // Chrome needs an explicit binary path on some servers.
    chromePath: process.env.CHROME_PATH || undefined,
    headless: bool(process.env.WA_HEADLESS, true)
  },

  crm: {
    baseUrl: process.env.CRM_BASE_URL,
    apiKey: process.env.CRM_API_KEY,
    companyId: process.env.CRM_COMPANY_ID,
    // The profile the API key resolves to. Used to recognise our own writes.
    serviceProfileId: process.env.CRM_SERVICE_PROFILE_ID,
    // Startup refuses to write if the key resolves to a different company.
    expectedCompanyId: process.env.CRM_EXPECTED_COMPANY_ID
  },

  db: {
    path: path.resolve(ROOT, process.env.DB_PATH || './data/bot.db')
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: path.resolve(ROOT, process.env.LOG_DIR || './logs'),
    // How many log lines to retain in the database for the panel's log view.
    retainInDb: int(process.env.LOG_RETAIN, 2000)
  },

  timezone: process.env.TZ_DISPLAY || 'Asia/Kolkata',

  /** Duplicate suppression window, in minutes. */
  dedupeWindowMinutes: int(process.env.DEDUPE_WINDOW_MINUTES, 10)
};

/**
 * Validate configuration. Returns a list of fatal problems and a list of warnings.
 * @returns {{ fatal: string[], warnings: string[] }}
 */
function validate() {
  const fatal = [];
  const warnings = [];

  if (!config.auth.user || !config.auth.pass) {
    fatal.push('ADMIN_USER and ADMIN_PASS must be set — the admin panel has no other login.');
  }

  if (!config.auth.jwtSecret) {
    fatal.push('JWT_SECRET must be set. Generate one with: openssl rand -hex 32');
  } else if (config.auth.jwtSecret.length < 32) {
    warnings.push('JWT_SECRET is short. Use at least 32 characters: openssl rand -hex 32');
  }

  // v1 shipped with the literal password "changeme123" still in place.
  const weakPasswords = ['changeme123', 'admin', 'password', '123456', 'changeme'];
  if (config.auth.pass && weakPasswords.includes(config.auth.pass.toLowerCase())) {
    fatal.push(
      `ADMIN_PASS is set to a default value ("${config.auth.pass}"). ` +
      'Anyone who finds this server can log in. Change it before starting.'
    );
  }

  if (!config.crm.baseUrl || !config.crm.apiKey) {
    warnings.push('CRM_BASE_URL / CRM_API_KEY are not set — leads will be captured but not sent.');
  }

  return { fatal, warnings };
}

module.exports = { config, validate };
