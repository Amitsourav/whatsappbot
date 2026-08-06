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

module.exports = { buildDailySummary, buildMyLeads, dateKey, leadDate };
