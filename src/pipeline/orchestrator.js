/**
 * The pipeline: a WhatsApp message in, a CRM lead out.
 *
 *   message in a monitored group
 *        │
 *        ├─ is it a reply to a lead we know?  ──> update that lead
 *        └─ otherwise                          ──> is it a new lead?
 *
 * Two principles run through all of it:
 *
 *   Record before acting. Every message is written to our database BEFORE the CRM
 *   is called. WhatsApp redelivers after a reconnect and a network failure leaves
 *   us unable to tell whether the CRM committed — recording first makes both
 *   recoverable instead of producing duplicate leads.
 *
 *   Never lose information. A message we cannot use is stored with a reason, not
 *   dropped. Held leads wait for a human; unrecognised text becomes a remark.
 */
const detect = require('./detect');
const noise = require('./noise');
const labelParser = require('./labels');
const { replies } = require('./replies');
const { LOCKED_LISTS } = require('../crm/fields');
const { DuplicateLeadError, CrmClient } = require('../crm/client');
const repo = require('../db/repositories');
const logger = require('../logger');

/** Give up after this many CRM attempts and mark the lead failed. */
const MAX_ATTEMPTS = 8;

class Orchestrator {
  /**
   * @param {{ crm: import('../crm/client').CrmClient, whatsapp: object }} deps
   */
  constructor({ crm, whatsapp }) {
    this.crm = crm;
    this.whatsapp = whatsapp;
  }

  /**
   * Entry point for every incoming group message.
   * @param {object} message - normalised by whatsapp/messages.js
   * @param {object} [rawMessage] - the original, needed to quote it in a reply
   */
  async handle(message, rawMessage) {
    try {
      const group = repo.groups.upsert(message.groupId, message.groupName || message.groupId);

      if (!group.is_active) return;

      if (group.purpose === 'bank') {
        // Way 2 is not designed yet. Recorded rather than ignored, so when it is
        // built there is real data to build against.
        repo.skipped.record({
          waMessageId: message.id, groupId: group.id,
          body: message.text || '', reason: 'bank_group_not_implemented',
          senderPhone: message.senderPhone
        });
        return;
      }

      if (message.quotedId) {
        const parent = repo.leads.byWaMessageId(message.quotedId);
        if (parent) return await this.handleReply(message, parent, group, rawMessage);
        // A reply to something that is not a lead is ordinary conversation.
      }

      return await this.handleNewLead(message, group, rawMessage);
    } catch (error) {
      // A failure here must never take the connection down — staying connected
      // matters more than any single message.
      logger.error(`Pipeline error on ${message?.id}: ${error.stack || error.message}`);
    }
  }

  /**
   * A message that is not a reply: decide whether it is a new lead.
   * @private
   */
  async handleNewLead(message, group, rawMessage) {
    const result = detect.classify(message);

    if (!result.isLead) {
      repo.skipped.record({
        waMessageId: message.id, groupId: group.id,
        body: message.text || '', reason: result.reason,
        senderPhone: message.senderPhone
      });
      return;
    }

    // Resolve the mention to an employee before recording, so the row is complete.
    const mentionedPhone = result.mentions[0] || null;
    const employee = mentionedPhone ? repo.employees.byPhone(mentionedPhone) : null;

    const heldReason = result.reason
      || (mentionedPhone && !employee ? 'unknown_employee' : null);

    const lead = repo.leads.create({
      waMessageId: message.id,
      groupId: group.id,
      name: result.name,
      phone: result.phone,
      senderPhone: message.senderPhone,
      rawMessage: message.text || '',
      mentionedPhone,
      employeeId: employee?.id || null,
      status: heldReason ? 'held' : 'pending',
      heldReason
    });

    // Already seen — WhatsApp redelivered it. Doing nothing is the correct action.
    if (!lead) return;

    if (heldReason) {
      logger.info(`Lead held (${heldReason}): ${result.name || 'unnamed'} ${result.phone}`);
      await this.replyHeld(lead, result, group, rawMessage);
      return;
    }

    await this.pushLead(lead, result, group, rawMessage);
  }

  /**
   * Tell the group why a lead is waiting (messages 3, 3b, 3c, 4).
   * @private
   */
  async replyHeld(lead, result, group, rawMessage) {
    let reply;

    switch (lead.held_reason) {
      case 'no_mention': {
        // A number posted with no tag is usually a question — "who has this one?"
        // Answering it is more useful than asking them to tag someone, and the
        // lookup is read-only.
        const existing = await this.crm.findByPhone(result.phone).catch(() => null);

        if (existing) {
          repo.leads.markExisting(lead.id, existing.id);
          await this.crm.addRemark(
            existing.id,
            `Shared again in WhatsApp by ${lead.sender_phone || 'a team member'}`
              + `\n\n${lead.raw_message}`,
            lead.wa_message_id
          ).catch(() => {});

          reply = replies.leadExists({
            name: result.name,
            phone: result.phone,
            lead: existing,
            resolveUser: (id) => (id ? this.crm.users?.get(id)?.full_name : null)
          });
          break;
        }

        reply = replies.needsMention({ name: result.name, phone: result.phone });
        break;
      }
      case 'multiple_mentions': {
        const names = result.mentions.map(
          (p) => repo.employees.byPhone(p)?.name || p
        );
        reply = replies.tooManyMentions({ employeeNames: names });
        break;
      }
      case 'unknown_employee':
        reply = replies.unknownEmployee({
          name: result.name, phone: result.phone, mentionedPhone: lead.mentioned_phone
        });
        break;
      default:
        return;
    }

    await this.send(group, reply, rawMessage, () => repo.leads.markReplied(lead.id));
  }

  /**
   * Create the lead in the CRM.
   *
   * Called both on arrival and by the retry worker, so it must be safe to run
   * more than once for the same lead.
   *
   * @param {object} lead - the database row
   * @param {object} [parsed] - detection result, re-derived if absent
   */
  async pushLead(lead, parsed, group, rawMessage) {
    const result = parsed || detect.classify({
      text: lead.raw_message,
      mentions: lead.mentioned_phone ? [lead.mentioned_phone] : []
    });

    const employee = lead.employee_id
      ? repo.employees.all().find((e) => e.id === lead.employee_id)
      : null;

    if (!employee) {
      repo.leads.markHeld(lead.id, 'unknown_employee');
      return;
    }

    repo.leads.recordAttempt(lead.id);

    try {
      // The CRM requires a name, but the phone number is what identifies a lead.
      // Showing the number is honest and searchable; a reply carrying "Name: X"
      // replaces it later.
      const displayName = lead.name || lead.phone;

      const { lead: created, deferred } = await this.crm.createLead({
        full_name: displayName,
        phone: lead.phone,
        assigned_agent_id: employee.crm_profile_id,
        ...result.fields
      });

      repo.leads.markCreated(lead.id, created.id);

      // loan_amount and bank_name cannot be set on create (C11) — patch them now
      // rather than losing them.
      if (Object.keys(deferred).length) {
        await this.crm.updateLead(created.id, deferred).catch((e) =>
          logger.warn(`Deferred field patch failed for ${created.id}: ${e.message}`));
      }

      if (result.remarkText) {
        await this.crm.addRemark(created.id, result.remarkText, lead.wa_message_id)
          .catch((e) => logger.warn(`Remark failed for ${created.id}: ${e.message}`));
      }

      logger.info(`Lead created: ${lead.name} (${lead.phone}) → ${employee.name}`);

      if (group) {
        await this.send(group, replies.leadCreated({
          name: lead.name, phone: lead.phone, employeePhone: employee.wa_phone
        }), rawMessage, () => repo.leads.markReplied(lead.id));
      }
    } catch (error) {
      if (error instanceof DuplicateLeadError) {
        // Q5 — the existing lead keeps its current owner. The message is preserved
        // as a remark so nothing is lost and a human can reassign if needed.

        // But if that lead is finished — disbursed, lost, enrolled — a remark lands
        // on a record nobody is watching. On a large lead base "lost" is common, so
        // a genuinely revived enquiry would be buried on a dead record. Hold it.
        // Fetched so the group can be told where this lead actually stands,
        // and so a finished lead is not silently appended to.
        let existing = null;
        if (error.existingLeadId) {
          existing = await this.crm.getLead(error.existingLeadId).catch(() => null);
        }

        if (existing && CrmClient.isTerminal(existing)) {
          repo.leads.markHeld(lead.id, `revived_${existing.current_stage}`);
          logger.warn(`Lead ${lead.phone} matches a ${existing.current_stage} lead `
            + `(${error.existingLeadId}) — held for review`);

          if (group) {
            await this.send(group, replies.revivedLead({
              phone: lead.phone,
              existingName: existing.full_name,
              stage: existing.current_stage
            }), rawMessage, () => repo.leads.markReplied(lead.id));
          }
          return;
        }

        repo.leads.markExisting(lead.id, error.existingLeadId);

        if (error.existingLeadId) {
          await this.crm.addRemark(
            error.existingLeadId,
            `Re-shared in WhatsApp by ${lead.sender_phone || 'a team member'}`
              + `, tagged ${employee.name}\n\n${lead.raw_message}`,
            lead.wa_message_id
          ).catch((e) => logger.warn(`Remark on duplicate failed: ${e.message}`));
        }

        logger.info(`Lead already exists: ${lead.phone} → ${error.existingLeadId}`);

        if (group) {
          await this.send(group, replies.leadExists({
            name: lead.name,
            phone: lead.phone,
            existingName: error.existingLeadName,
            lead: existing,
            // The single-lead response does not always populate agent names, so
            // resolve them from the cached user list instead.
            resolveUser: (id) => (id ? this.crm.users?.get(id)?.full_name : null)
          }), rawMessage, () => repo.leads.markReplied(lead.id));
        }
        return;
      }

      const attempts = lead.attempts + 1;
      repo.leads.recordError(lead.id, error.message);

      if (attempts >= MAX_ATTEMPTS) {
        repo.leads.markFailed(lead.id, error.message);
        logger.error(`Lead ${lead.id} failed after ${attempts} attempts: ${error.message}`);
      } else {
        logger.warn(`Lead ${lead.id} attempt ${attempts} failed: ${error.message}`);
      }

      // S6 — announce trouble once, never once per retry.
      if (group && !lead.replied) {
        await this.send(group, replies.crmUnavailable({
          name: lead.name, phone: lead.phone
        }), rawMessage, () => repo.leads.markReplied(lead.id));
      }
    }
  }

  /**
   * A reply to a known lead: field updates, remarks, or nothing at all.
   * @private
   */
  async handleReply(message, parent, group, rawMessage) {
    const text = message.text || '';

    // R11.1 — acknowledgements never reach the CRM, but are kept here so the
    // noise list can be corrected against how people actually talk.
    const noiseCheck = noise.classify(text);
    if (noiseCheck.isNoise) {
      repo.skipped.record({
        waMessageId: message.id, groupId: group.id, body: text,
        reason: `noise_${noiseCheck.reason}`, senderPhone: message.senderPhone
      });
      return;
    }

    const parsed = labelParser.parse(text);
    const hasFields = Object.keys(parsed.fields).length > 0;

    // Anything not understood is preserved verbatim (R11.5).
    const remarkParts = [
      ...parsed.plain,
      ...parsed.rejected.map((r) => `${r.label}: ${r.value}`)
    ];

    const record = repo.leadUpdates.create({
      waMessageId: message.id,
      leadId: parent.id,
      kind: hasFields ? 'fields' : 'remark',
      payload: JSON.stringify(parsed.fields),
      body: text,
      senderPhone: message.senderPhone
    });

    if (!record) return; // redelivered

    await this.applyUpdate(record, parent, parsed, remarkParts, group, rawMessage);
  }

  /**
   * Send a reply's contents to the CRM.
   * Safe to call again — used by the retry worker too.
   */
  async applyUpdate(record, parent, parsed, remarkParts, group, rawMessage) {
    if (!parent.crm_lead_id) {
      // The parent has not reached the CRM yet. Leave it pending; the retry worker
      // will pick it up once the lead exists.
      return;
    }

    repo.leadUpdates.recordAttempt(record.id);

    try {
      if (Object.keys(parsed.fields).length) {
        await this.crm.updateLead(parent.crm_lead_id, parsed.fields);
      }

      if (remarkParts.length) {
        await this.crm.addRemark(parent.crm_lead_id, remarkParts.join('\n'),
          record.wa_message_id);
      }

      repo.leadUpdates.markApplied(record.id);

      if (group && !record.replied) {
        // Confirm what landed, and explain what did not — this is how the team
        // learns the labelled format (R9).
        if (Object.keys(parsed.fields).length) {
          await this.send(group, replies.fieldsUpdated(parsed.fields), rawMessage,
            () => repo.leadUpdates.markReplied(record.id));
        }

        for (const rejected of parsed.rejected) {
          await this.send(group, replies.labelRejected({
            ...rejected,
            allowed: rejected.reason === 'not_in_locked_list'
              ? LOCKED_LISTS[require('../crm/fields').resolveLabel(rejected.label)]
              : null
          }), rawMessage, () => repo.leadUpdates.markReplied(record.id));
        }
      }
    } catch (error) {
      const attempts = record.attempts + 1;
      repo.leadUpdates.recordError(record.id, error.message);
      if (attempts >= MAX_ATTEMPTS) {
        repo.leadUpdates.markFailed(record.id, error.message);
      }
      logger.warn(`Update ${record.id} failed: ${error.message}`);
    }
  }

  /**
   * Send a reply, respecting the per-group switch and the kill switch.
   * @private
   */
  async send(group, reply, rawMessage, onSent) {
    if (!group.send_enabled) return;
    if (repo.settings.get('sending_paused') === 'true') return;

    const ok = await this.whatsapp.reply({
      groupId: group.wa_group_id,
      text: reply.text,
      mentions: reply.mentions,
      quoteMessage: rawMessage
    });

    if (ok && onSent) onSent();
  }
}

module.exports = { Orchestrator, MAX_ATTEMPTS };
