/**
 * Tracker — a second destination alongside the CRM.
 *
 * Tracker is Amit's personal task app. Messages from groups he opts in are
 * forwarded there, where an AI decides whether someone is asking him to do
 * something and puts anything it finds in a Review inbox he approves by hand.
 *
 * Two rules govern everything here, and both exist to protect lead capture:
 *
 *   Nothing in this file may break the lead pipeline. Every entry point is
 *   wrapped, and a Tracker outage must be invisible to the rest of the bot.
 *
 *   Nothing in this file may block the message handler. `maybeQueue` is a
 *   synchronous SQLite insert; the network happens later, on a timer.
 *
 * The bot never posts in a group because of Tracker. Capture here is silent.
 */
const repo = require('../db/repositories');
const noise = require('../pipeline/noise');
const commands = require('../pipeline/commands');
const { config } = require('../config');
const logger = require('../logger');

/** Tracker ignores anything past 40 in one request, so never send more. */
const MAX_PER_POST = 40;

/** Give up on a row after this many attempts — the ceiling used elsewhere. */
const MAX_ATTEMPTS = 8;

/** A slow Tracker must not stall the flush loop. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Words that make a message look like a request rather than conversation.
 *
 * Deliberately loose. Tracker's AI is the real filter and it is strict — it
 * discards anything under 0.35 confidence and ignores messages aimed at other
 * people. This test exists only to keep pure banter out of the AI and off the
 * bill, so a false positive costs a fraction of a paisa and a false negative
 * costs a task.
 */
const TASKISH = /\b(bhej|bhejna|bhej dena|kar dena|karna hai|kar do|dekh lena|dekh lo|check kar|send|share|update|pending|follow ?up|kya hua|reminder|complete|submit|draft|prepare|arrange|confirm|kal tak|aaj tak|parso|eod|asap|urgent)\b/i;

/**
 * Compare two phone numbers, ignoring "+", spaces and a missing country code.
 *
 * Matches on the last ten digits when both are long enough — the same identity
 * rule the lead pipeline uses, so "+917004428198" and "7004428198" are one person.
 *
 * @param {string|null} a
 * @param {string|null} b
 * @returns {boolean}
 */
function same(a, b) {
  if (!a || !b) return false;
  const x = String(a).replace(/\D/g, '');
  const y = String(b).replace(/\D/g, '');
  if (!x || !y) return false;
  if (x.length >= 10 && y.length >= 10) return x.slice(-10) === y.slice(-10);
  return x === y;
}

class TrackerClient {
  /**
   * @param {{ fetchImpl?: Function, settings?: object }} [options]
   */
  constructor(options = {}) {
    this.fetch = options.fetchImpl || ((...args) => globalThis.fetch(...args));
    this.settings = options.settings || config.tracker;
    this.timer = null;
    this.running = false;
    /** Set when the token is rejected. A bad token will not fix itself. */
    this.stopped = false;
  }

  get configured() {
    return Boolean(this.settings.url && this.settings.token);
  }

  /**
   * Decide whether a message is worth forwarding, and queue it if so.
   *
   * Synchronous on purpose: this is called from the message handler, and an
   * await here would put a network round trip in front of every lead.
   *
   * @param {object} message - normalised by whatsapp/messages.js
   * @param {object} group - the groups row
   * @returns {boolean} whether it was queued
   */
  maybeQueue(message, group) {
    if (!this.configured) return false;
    if (!group?.tracker_enabled) return false;
    if (!message?.isGroup || message.fromMe) return false;

    const text = String(message.text || '').trim();
    if (!text) return false;

    // Amit's own messages are promises he made, not tasks he was given.
    if (same(message.senderPhone, this.settings.ownerPhone)) return false;

    // "my leads", "help" — instructions to the bot, never tasks.
    if (commands.parse(text)) return false;

    // "ok", "done", "thik hai", emoji. Whole-message match only, so "documents
    // done" still counts as information.
    if (noise.classify(text).isNoise) return false;

    const mentionedMe = (message.mentions || [])
      .some((p) => same(p, this.settings.ownerPhone));
    const isReplyToMe = same(message.quotedAuthorPhone, this.settings.ownerPhone);

    if (!mentionedMe && !isReplyToMe && !TASKISH.test(text)) return false;

    const row = repo.trackerOutbox.enqueue({
      waMessageId: message.id,
      groupId: group.id,
      waGroupId: message.groupId,
      groupName: message.groupName || group.name,
      payload: {
        id: message.id,
        text,
        senderPhone: message.senderPhone || null,
        senderName: message.senderName || null,
        // Seconds, not milliseconds — Tracker reads it as a UNIX timestamp.
        timestamp: message.timestamp,
        mentionedMe,
        isReplyToMe,
        quotedText: message.quotedText || null
      }
    });

    return Boolean(row);
  }

  start() {
    if (this.timer || !this.configured) return;
    this.stopped = false;
    this.timer = setInterval(() => this.flush(), this.settings.flushMs);
    // Never hold the process open for task capture.
    this.timer.unref?.();
    logger.info(`Tracker capture started (flushing every `
      + `${Math.round(this.settings.flushMs / 1000)}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Send what is queued. Never throws — a failing pass must not stop future ones,
   * and must never surface anywhere near the lead pipeline.
   *
   * @returns {Promise<{ sent: number, failed: number }>}
   */
  async flush() {
    if (this.running || this.stopped || !this.configured) return { sent: 0, failed: 0 };
    this.running = true;

    let sent = 0;
    let failed = 0;

    try {
      const rows = repo.trackerOutbox.pending(
        Math.min(this.settings.batchSize, MAX_PER_POST)
      );
      if (!rows.length) return { sent: 0, failed: 0 };

      // One POST per conversation: Tracker extracts per conversation, and mixing
      // groups into one request would give it a thread that never happened.
      const byGroup = new Map();
      for (const row of rows) {
        if (!byGroup.has(row.wa_group_id)) byGroup.set(row.wa_group_id, []);
        byGroup.get(row.wa_group_id).push(row);
      }

      for (const [waGroupId, batch] of byGroup) {
        if (this.stopped) break;
        const result = await this.send(waGroupId, batch.slice(0, MAX_PER_POST));
        sent += result.sent;
        failed += result.failed;
      }

      if (sent || failed) {
        logger.info(`Tracker: ${sent} message(s) sent, ${failed} failed`);
      }
    } catch (error) {
      // Belt and braces. send() already swallows, but this must never throw.
      logger.warn(`Tracker flush failed: ${error.stack || error.message}`);
    } finally {
      this.running = false;
    }

    return { sent, failed };
  }

  /**
   * POST one group's batch.
   * @private
   */
  async send(waGroupId, batch) {
    const ids = batch.map((r) => r.id);
    const body = {
      group: { id: waGroupId, name: batch[0].group_name || null },
      messages: batch.map((r) => JSON.parse(r.payload))
    };

    let response;
    try {
      response = await this.fetch(this.settings.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      // Network or timeout. Tracker deduplicates on the message id, so retrying
      // is always safer than dropping.
      return this.retryLater(batch, `Network error: ${error.message}`);
    }

    if (response.status === 401) {
      // A bad token will not fix itself, and retrying forever just fills the log.
      this.stopped = true;
      this.stop();
      for (const id of ids) repo.trackerOutbox.markFailed(id, 'Unauthorised (401)');
      logger.error('Tracker rejected our token (401). Task capture is now OFF.');
      logger.error('Set a valid TRACKER_TOKEN and restart to resume.');
      return { sent: 0, failed: ids.length };
    }

    if (response.status === 400) {
      const detail = await response.text().catch(() => '');
      for (const id of ids) repo.trackerOutbox.markFailed(id, `Malformed (400): ${detail.slice(0, 200)}`);
      logger.error(`Tracker rejected a batch as malformed: ${detail.slice(0, 300)}`);
      logger.error(`Payload was: ${JSON.stringify(body).slice(0, 500)}`);
      return { sent: 0, failed: ids.length };
    }

    if (!response.ok) {
      return this.retryLater(batch, `Tracker ${response.status}`);
    }

    const result = await response.json().catch(() => ({}));
    repo.trackerOutbox.markSent(ids);

    // created_tasks: 0 is an ordinary outcome — usually nothing in the batch was
    // a task. Logged at debug so a quiet group does not fill the log.
    logger.debug(`Tracker accepted ${ids.length} from ${waGroupId}: `
      + `${result.created_tasks ?? '?'} task(s) created`);

    return { sent: ids.length, failed: 0 };
  }

  /**
   * Leave a batch pending for the next pass, or give up once it has had enough.
   * @private
   */
  retryLater(batch, error) {
    repo.trackerOutbox.recordAttempt(batch.map((r) => r.id), error);

    let failed = 0;
    for (const row of batch) {
      if (row.attempts + 1 >= MAX_ATTEMPTS) {
        repo.trackerOutbox.markFailed(row.id, error);
        failed += 1;
      }
    }

    logger.warn(`Tracker unreachable (${error}) — ${batch.length} message(s) still queued`
      + (failed ? `, ${failed} given up on` : ''));

    return { sent: 0, failed };
  }
}

module.exports = { TrackerClient, same, TASKISH };
