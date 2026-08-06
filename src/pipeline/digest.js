/**
 * The daily summary posted into the group each morning.
 *
 * Read-only. The valuable half is the untouched list: a lead still sitting at
 * `created` a day later is one nobody has called, and today nothing watches for
 * that.
 *
 * Covers every lead in the CRM for the day, not only the ones the bot captured —
 * the team wants to know what the day looked like, not what the bot did.
 */
const { config } = require('../config');
const logger = require('../logger');
const { prettyPhone, STAGE_LABELS } = require('./replies');

/** A lead still here a day later has not been picked up. */
const UNTOUCHED_STAGES = new Set(['created']);

/** How many untouched leads to name before summarising the rest. */
const MAX_LISTED = 8;

/**
 * How far back an overdue follow-up is still worth chasing.
 *
 * The live CRM carries 570 overdue leads, most of them long past. Listing eight
 * arbitrary ones from that pile every morning is noise, and noise is how a bot
 * gets ignored. Recently overdue is a thing someone can act on today; six months
 * overdue is a data-hygiene problem, not a reminder.
 */
const OVERDUE_WINDOW_DAYS = 7;

/**
 * The date N days ago in the display timezone, as YYYY-MM-DD.
 * @param {number} daysAgo
 * @returns {string}
 */
function dateKey(daysAgo = 0) {
  const now = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

/** The calendar date of a lead, in the display timezone. */
function leadDate(lead) {
  if (!lead?.created_at) return null;
  const d = new Date(lead.created_at);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

/**
 * Build yesterday's summary.
 *
 * @param {import('../crm/client').CrmClient} crm
 * @param {{ day?: string }} [options] - override the day, for testing
 * @returns {Promise<{text: string, leads: number, untouched: number}|null>}
 *   null when there is nothing worth saying — a summary reading "0 leads" every
 *   morning trains people to ignore the bot.
 */
async function buildDailySummary(crm, options = {}) {
  const day = options.day || dateKey(1);

  // date_from is inclusive and has no matching date_to, so the day is filtered here.
  const all = await crm.listLeads({ date_from: day });
  const leads = all.filter((l) => leadDate(l) === day);

  if (leads.length === 0) return null;

  const byAgent = new Map();
  for (const lead of leads) {
    const id = lead.assigned_agent_id || 'unassigned';
    byAgent.set(id, (byAgent.get(id) || 0) + 1);
  }

  const named = [...byAgent.entries()]
    .map(([id, count]) => ({
      name: id === 'unassigned' ? 'Unassigned' : (crm.users?.get(id)?.full_name || 'Unknown'),
      count
    }))
    .sort((a, b) => b.count - a.count);

  const untouched = leads.filter((l) => UNTOUCHED_STAGES.has(l.current_stage));

  const lines = [
    `📊 ${formatDay(day)} — ${leads.length} lead${leads.length === 1 ? '' : 's'}`,
    '',
    named.map((a) => `${a.name} ${a.count}`).join(' · ')
  ];

  if (untouched.length) {
    lines.push('');
    lines.push(`⚠️ ${untouched.length} still untouched`);
    for (const lead of untouched.slice(0, MAX_LISTED)) {
      const owner = crm.users?.get(lead.assigned_agent_id)?.full_name;
      lines.push(`${prettyPhone(lead.phone)} · ${lead.full_name || '—'}`
        + (owner ? ` · ${owner}` : ''));
    }
    if (untouched.length > MAX_LISTED) {
      lines.push(`…and ${untouched.length - MAX_LISTED} more`);
    }
  } else {
    lines.push('');
    lines.push('✅ Every lead has been picked up');
  }

  return { text: lines.join('\n'), leads: leads.length, untouched: untouched.length };
}

/**
 * Follow-ups due today or already overdue.
 *
 * `due_date` is not a filter the API supports, so a window of recently created
 * leads is fetched and filtered here. Ninety days covers the realistic set — a
 * lead created a year ago with a follow-up due today is rare enough not to be
 * worth fetching ten thousand records for.
 *
 * @param {import('../crm/client').CrmClient} crm
 * @param {{ today?: string, windowDays?: number }} [options]
 * @returns {Promise<{due: object[], overdue: object[]}>}
 */
async function findFollowUps(crm, options = {}) {
  const today = options.today || dateKey(0);
  const windowDays = options.windowDays ?? 90;

  const rows = await crm.listLeads({ date_from: dateKey(windowDays) }, 30);

  const cutoff = options.overdueFrom
    || dateKey(options.overdueWindowDays ?? OVERDUE_WINDOW_DAYS);

  const due = [];
  const overdue = [];
  let olderCount = 0;

  for (const lead of rows) {
    if (!lead.due_date) continue;
    // A finished lead is not owed a follow-up.
    if (['disbursed', 'lost', 'enrolled'].includes(lead.current_stage)) continue;

    const day = String(lead.due_date).slice(0, 10);
    if (day === today) due.push(lead);
    else if (day < today && day >= cutoff) overdue.push(lead);
    else if (day < cutoff) olderCount += 1;
  }

  return { due, overdue, olderCount };
}

/**
 * Render the follow-up section of the morning message.
 * @returns {string|null} null when nothing is due
 */
function renderFollowUps({ due, overdue, olderCount = 0 }, crm) {
  if (!due.length && !overdue.length && !olderCount) return null;

  const line = (lead) => {
    const owner = crm.users?.get(lead.assigned_agent_id)?.full_name;
    return `${prettyPhone(lead.phone)} · ${lead.full_name || '—'}`
      + (owner ? ` · ${owner}` : '');
  };

  /**
   * A short list is worth naming; a long one is not. Eight arbitrary rows out of
   * a hundred and forty helps nobody — a count per person tells each of them
   * exactly how much is theirs, and they can open their own list.
   */
  const section = (heading, rows) => {
    if (!rows.length) return [];
    if (rows.length <= MAX_LISTED) return [heading, ...rows.map(line)];

    const byAgent = new Map();
    for (const lead of rows) {
      const name = crm.users?.get(lead.assigned_agent_id)?.full_name || 'Unassigned';
      byAgent.set(name, (byAgent.get(name) || 0) + 1);
    }
    const counts = [...byAgent.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} ${count}`)
      .join(' · ');

    return [heading, counts];
  };

  const out = [];
  out.push(...section(`🔔 Due today (${due.length})`, due));

  if (overdue.length) {
    if (out.length) out.push('');
    out.push(...section(`⏰ Overdue this week (${overdue.length})`, overdue));
  }

  if (olderCount) {
    // Counted, never listed. It is a backlog to clean up, not today's work.
    if (out.length) out.push('');
    out.push(`📁 ${olderCount} older follow-ups still open`);
  }

  return out.join('\n');
}

/**
 * The whole morning message: yesterday's summary and today's follow-ups.
 *
 * One message, not two — two posts every morning is how a bot becomes something
 * people scroll past. Returns null when there is nothing to say at all.
 *
 * @param {import('../crm/client').CrmClient} crm
 * @param {{ day?: string, today?: string }} [options]
 * @returns {Promise<{text: string, leads: number, untouched: number, due: number}|null>}
 */
async function buildMorningMessage(crm, options = {}) {
  const summary = await buildDailySummary(crm, options);
  const followUps = await findFollowUps(crm, options).catch(() => ({ due: [], overdue: [] }));
  const followUpText = renderFollowUps(followUps, crm);

  if (!summary && !followUpText) return null;

  const parts = [];
  if (summary) parts.push(summary.text);
  if (followUpText) parts.push(followUpText);

  return {
    text: parts.join('\n\n———\n\n'),
    leads: summary?.leads ?? 0,
    untouched: summary?.untouched ?? 0,
    due: followUps.due.length + followUps.overdue.length,
    older: followUps.olderCount || 0
  };
}

/** "5 Aug" — short, since the message is read the next morning. */
function formatDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Leads assigned to one person that are still in play.
 *
 * @param {import('../crm/client').CrmClient} crm
 * @param {string} profileId
 * @returns {Promise<{text: string, count: number}>}
 */
async function buildMyLeads(crm, profileId) {
  // assigned_agent_id is not a working filter on this API, so the filtering is
  // done here. current_stage narrows it enough to stay cheap.
  const open = [];
  for (const stage of ['created', 'contacted', 'qualified', 'processing',
                       'logged_in', 'sanctioned', 'pf_paid', 'opportunity']) {
    const rows = await crm.listLeads({ current_stage: stage }, 6);
    open.push(...rows.filter((l) => l.assigned_agent_id === profileId));
  }

  if (!open.length) return { text: 'You have no open leads.', count: 0 };

  const byStage = new Map();
  for (const lead of open) {
    if (!byStage.has(lead.current_stage)) byStage.set(lead.current_stage, []);
    byStage.get(lead.current_stage).push(lead);
  }

  const name = crm.users?.get(profileId)?.full_name || 'You';
  const lines = [`${name} — ${open.length} open lead${open.length === 1 ? '' : 's'}`];

  for (const [stage, rows] of byStage) {
    lines.push('');
    lines.push(`${STAGE_LABELS[stage] || stage} (${rows.length})`);
    for (const lead of rows.slice(0, 10)) {
      lines.push(`  ${prettyPhone(lead.phone)} · ${lead.full_name || '—'}`);
    }
    if (rows.length > 10) lines.push(`  …and ${rows.length - 10} more`);
  }

  return { text: lines.join('\n'), count: open.length };
}

module.exports = {
  buildDailySummary, buildMyLeads, buildMorningMessage,
  findFollowUps, renderFollowUps, dateKey, leadDate
};
