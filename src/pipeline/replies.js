/**
 * The messages the bot posts into the in-house group.
 *
 * Executable form of docs/BOT-MESSAGES.md. Pure string building — sending, rate
 * limiting and the kill switch live elsewhere, so wording can be changed and
 * tested without touching any of that.
 */

/** Render +919876543210 as "+91 98765 43210". */
function prettyPhone(e164) {
  if (!e164) return '';
  const m = String(e164).match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/** "Priya Sharma · +91 98765 43210" */
function subject(name, phone) {
  return [name, prettyPhone(phone)].filter(Boolean).join(' · ');
}

/**
 * A mention only renders in WhatsApp if the text contains "@<digits>". The
 * matching JIDs must be passed alongside — see messages.toMentionJids.
 */
function tag(e164) {
  return e164 ? `@${String(e164).replace(/^\+/, '')}` : '';
}

const replies = {
  /** 1 — the lead reached the CRM. */
  leadCreated({ name, phone, employeePhone }) {
    return {
      text: `✅ Lead created\n${subject(name, phone)}\nAssigned to ${tag(employeePhone)}`,
      mentions: [employeePhone].filter(Boolean)
    };
  },

  /**
   * 2 — the phone was already a lead (Q5).
   * Assignment is deliberately unchanged: silently moving someone else's lead to
   * a different person causes arguments.
   */
  leadExists({ name, phone, existingName, existingOwner }) {
    const owner = existingOwner ? `\nAlready with ${existingOwner}` : '';
    return {
      text: `⚠️ Lead already exists\n${subject(existingName || name, phone)}${owner}`
        + '\nAdded your message as a note',
      mentions: []
    };
  },

  /** 3 — nobody was tagged (Q6). The lead is held, not discarded. */
  needsMention({ name, phone }) {
    return {
      text: `⚠️ Please tag the employee for this lead\n${subject(name, phone)}\n`
        + "Reply with @name and I'll create it",
      mentions: []
    };
  },

  /** 4 — more than one person tagged (Q9). */
  tooManyMentions({ employeeNames }) {
    const who = employeeNames.filter(Boolean).join(' and ');
    return {
      text: `⚠️ You tagged ${employeeNames.length} people${who ? ` — ${who}` : ''}\n`
        + 'Please tag only one employee per lead',
      mentions: []
    };
  },

  /**
   * 3b — the tagged number is not in the employee map.
   * Named separately from needsMention because the fix is different: someone must
   * add them to the map, not re-tag the message.
   */
  unknownEmployee({ name, phone, mentionedPhone }) {
    return {
      text: `⚠️ ${prettyPhone(mentionedPhone)} isn't set up as an employee yet\n`
        + `${subject(name, phone)}\nAdd them in the admin panel, or tag someone else`,
      mentions: []
    };
  },

  /**
   * 3c — no name could be found.
   * The CRM requires full_name and we never invent one, so this waits for a human.
   */
  needsName({ phone }) {
    return {
      text: `⚠️ I couldn't find the student's name\n${prettyPhone(phone)}\n`
        + 'Reply with  Name: <full name>',
      mentions: []
    };
  },

  /** 5 — a reply set one or more CRM fields. */
  fieldsUpdated(updates) {
    return {
      text: Object.entries(updates)
        .map(([field, value]) => `✅ ${LABELS[field] || field} → ${format(value)}`)
        .join('\n'),
      mentions: []
    };
  },

  /** 6 — a labelled reply the bot could not use. */
  labelRejected({ label, value, reason, allowed }) {
    const head = reason === 'not_in_locked_list'
      ? `⚠️ "${value}" isn't in the ${LABELS[label] || label} list — saved as a note instead`
      : `⚠️ "${label}" isn't a field I know — saved as a note instead`;
    return {
      text: allowed?.length ? `${head}\n${allowed.join(', ')}` : head,
      mentions: []
    };
  },

  /** 7 — the CRM could not be reached. Sent once per lead, never per retry (S6). */
  crmUnavailable({ name, phone }) {
    return {
      text: `⚠️ Couldn't save this to the CRM — retrying\n${subject(name, phone)}`,
      mentions: []
    };
  }
};

/** Field names as people would say them, for confirmations. */
const LABELS = {
  university: 'University',
  target_degree: 'Course',
  preferred_countries: 'Country',
  loan_amount: 'Loan',
  bank_name: 'Bank',
  full_name: 'Name',
  email: 'Email',
  city: 'City',
  state: 'State',
  date_of_birth: 'DOB',
  gender: 'Gender',
  pincode: 'Pincode',
  highest_qualification: 'Qualification',
  stream: 'Stream',
  percentage: 'Percentage',
  passing_year: 'Passing Year',
  target_intake: 'Intake',
  alternate_phone: 'Alt Phone'
};

function format(value) {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

module.exports = { replies, prettyPhone, subject, tag, LABELS };
