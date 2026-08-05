/**
 * WhatsApp connection via Baileys.
 *
 * Baileys speaks WhatsApp's multi-device protocol directly rather than driving a
 * headless Chrome, which is why it needs ~100 MB instead of ~500 MB. Linking is
 * identical from the user's side: the same "Linked Devices" flow, either by QR or
 * by an 8-digit pairing code typed into the phone.
 *
 * The session lives in `.wwebjs_auth/` equivalent — see config.whatsapp.sessionPath.
 * Losing that folder means physically scanning again from the phone that owns the
 * number, so nothing here ever deletes it.
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const { config } = require('../config');
const logger = require('../logger');
const { normalise, toMentionJids } = require('./messages');

/** Reconnect backoff, capped so a long outage doesn't become an hour-long wait. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

/** Sending guard (S3): a hard ceiling so a bug can never flood a group. */
const SEND_WINDOW_MS = 60_000;
const SEND_MAX_PER_WINDOW = 12;

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.state = 'disconnected';
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.selfPhone = null;
    this.reconnectAttempts = 0;
    this.stopping = false;
    this.sendTimestamps = [];
    /** Message IDs we sent ourselves, so we can ignore them (S1). */
    this.ownMessageIds = new Set();
  }

  get connected() {
    return this.state === 'connected';
  }

  status() {
    return {
      state: this.state,
      connected: this.connected,
      selfPhone: this.selfPhone,
      qr: this.state === 'awaiting_scan' ? this.qrDataUrl : null,
      pairingCode: this.state === 'awaiting_scan' ? this.pairingCode : null
    };
  }

  /**
   * Connect, restoring the saved session if there is one.
   * @param {{ pairingPhone?: string }} [options] - request an 8-digit pairing code
   *   for this number instead of showing a QR. Digits only, with country code.
   */
  async connect(options = {}) {
    this.stopping = false;
    fs.mkdirSync(config.whatsapp.sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.sessionPath);
    const hasSession = Boolean(state.creds?.registered);

    this.sock = makeWASocket({
      auth: state,
      // Baileys is chatty at info level; our own logger reports what matters.
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,      // never appear "online" as a side effect
      syncFullHistory: false,          // we only care about messages from now on
      generateHighQualityLinkPreview: false
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (u) => this.onConnectionUpdate(u, options));
    this.sock.ev.on('messages.upsert', (u) => this.onMessages(u));

    // Pairing code must be requested after the socket exists but before scanning.
    if (!hasSession && options.pairingPhone) {
      // Baileys needs a moment before the request will succeed.
      setTimeout(() => this.requestPairingCode(options.pairingPhone), 3000);
    }

    this.state = hasSession ? 'connecting' : 'awaiting_scan';
    logger.info(hasSession
      ? 'Restoring saved WhatsApp session'
      : 'No saved session — link the number to continue');
  }

  /**
   * Ask WhatsApp for an 8-digit code to type into the phone. Easier than a QR
   * when the phone and the server are not in the same room.
   * @param {string} phoneNumber - digits with country code, e.g. 919876543210
   */
  async requestPairingCode(phoneNumber) {
    try {
      const digits = String(phoneNumber).replace(/\D/g, '');
      const code = await this.sock.requestPairingCode(digits);
      this.pairingCode = code;
      logger.info(`Pairing code: ${code.match(/.{1,4}/g).join('-')}`);
      logger.info('On the phone: WhatsApp > Linked Devices > Link a Device > Link with phone number');
      this.emit('status', this.status());
    } catch (error) {
      logger.error(`Could not get a pairing code: ${error.message}`);
    }
  }

  /** @private */
  async onConnectionUpdate(update, options) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.state = 'awaiting_scan';
      this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 }).catch(() => null);
      if (!this.pairingCode) qrcodeTerminal.generate(qr, { small: true });
      this.emit('status', this.status());
    }

    if (connection === 'open') {
      this.state = 'connected';
      this.qrDataUrl = null;
      this.pairingCode = null;
      this.reconnectAttempts = 0;
      this.selfPhone = this.sock.user?.id?.split(':')[0] || null;
      logger.info(`WhatsApp connected as ${this.selfPhone}`);
      this.emit('status', this.status());
      this.emit('ready');
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      this.state = loggedOut ? 'logged_out' : 'disconnected';
      this.emit('status', this.status());

      if (loggedOut) {
        // The session is dead. We deliberately do NOT delete the folder — that is
        // the user's decision, and deleting it is what forces a physical rescan.
        logger.error('WhatsApp logged out. The number must be linked again.');
        logger.error(`Session folder left intact at ${config.whatsapp.sessionPath}`);
        return;
      }

      if (this.stopping) return;

      this.reconnectAttempts += 1;
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
        RECONNECT_MAX_MS
      );
      logger.warn(`Disconnected (${statusCode ?? 'unknown'}) — reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => this.connect(options).catch((e) => logger.error(e.message)), delay);
    }
  }

  /** @private */
  onMessages({ messages, type }) {
    // 'notify' is a live message. 'append' is history sync, which we ignore —
    // reprocessing old messages would create leads for conversations long since
    // handled.
    if (type !== 'notify') return;

    for (const raw of messages) {
      const message = normalise(raw);
      if (!message || !message.isGroup) continue;

      // S1 — never react to our own output. Its replies contain no mention and no
      // phone number, and without this guard the bot can talk to itself.
      if (message.fromMe || this.ownMessageIds.has(message.id)) {
        this.ownMessageIds.delete(message.id);
        continue;
      }

      this.emit('message', message);
    }
  }

  /**
   * Whether another send is allowed inside the rate-limit window (S3).
   * @private
   */
  withinRateLimit() {
    const now = Date.now();
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < SEND_WINDOW_MS);
    return this.sendTimestamps.length < SEND_MAX_PER_WINDOW;
  }

  /**
   * Send a quoted reply into a group.
   *
   * Every bot message is a reply to the message that triggered it, so it is always
   * clear which lead is being discussed. Failure to send is logged and swallowed:
   * a send problem must never cost a lead.
   *
   * @param {{ groupId: string, text: string, quoteId?: string,
   *           quoteMessage?: object, mentions?: string[] }} params
   * @returns {Promise<boolean>} whether it was sent
   */
  async reply({ groupId, text, quoteMessage, mentions }) {
    if (!this.connected) {
      logger.warn('Not connected — reply skipped');
      return false;
    }

    if (!this.withinRateLimit()) {
      // Loud, because silently dropping replies would look like the bot ignoring
      // people. Capture is unaffected.
      logger.error(`Send rate limit hit (${SEND_MAX_PER_WINDOW}/min) — reply suppressed`);
      return false;
    }

    try {
      this.sendTimestamps.push(Date.now());
      const sent = await this.sock.sendMessage(
        groupId,
        { text, mentions: toMentionJids(mentions) },
        quoteMessage ? { quoted: quoteMessage } : undefined
      );
      if (sent?.key?.id) this.ownMessageIds.add(sent.key.id);
      return true;
    } catch (error) {
      logger.error(`Failed to send reply: ${error.message}`);
      return false;
    }
  }

  /**
   * Every group this number belongs to.
   * @returns {Promise<{id: string, name: string, participants: number}[]>}
   */
  async listGroups() {
    if (!this.connected) return [];
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0
    }));
  }

  async disconnect() {
    this.stopping = true;
    if (this.sock) {
      try {
        this.sock.end();
      } catch {
        // Already gone.
      }
    }
    this.state = 'disconnected';
    logger.info('WhatsApp client stopped');
  }
}

module.exports = { WhatsAppClient };
