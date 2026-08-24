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

/**
 * The stages this report is about.
 *
 * Deliberately only two. Contacted and DNP measure activity; a bank login and a
 * paid processing fee are the two points where a file has actually moved
 * forward, and those are what the owner wants seen every evening.
 */
const REPORTED_STAGES = [
  ['logged_in', 'login'],
  ['pf_paid', 'PF']
];

/**
 * The end-of-day login and PF report.
 *
 * Uses the CRM's own per-user daily report, which counts stage transitions on a
 * given day — so this is what each person actually moved today, not the standing
 * total.
 *
 * People with nothing are still listed. A name against a dash is the point of a
 * team report; hiding it would make the report only ever good news.
 *
 * @param {import('../crm/client').CrmClient} crm
 * @param {{id: string, name: string}[]} agents
 * @param {{ day?: string }} [options]
 * @returns {Promise<{text: string, totals: Object}|null>}
 */
async function buildStageReport(crm, agents, options = {}) {
  const day = options.day || dateKey(0);
  const rows = [];
  const totals = Object.fromEntries(REPORTED_STAGES.map(([key]) => [key, 0]));

  for (const agent of agents) {
    const report = await crm
      .request('GET', `/reports/daily?user_id=${agent.id}&date=${day}`)
      .catch(() => null);

    const moves = report?.metrics?.transitions_by_stage || {};
    const counts = {};
    for (const [key] of REPORTED_STAGES) {
      counts[key] = moves[key] || 0;
      totals[key] += counts[key];
    }
    rows.push({ name: agent.name, counts, reachable: Boolean(report) });
  }

  if (!rows.length) return null;

  const lines = [`📈 ${formatDay(day)} — Login & PF`, ''];

  for (const row of rows) {
    const parts = REPORTED_STAGES
      .filter(([key]) => row.counts[key] > 0)
      .map(([key, label]) => `${row.counts[key]} ${label}`);

    lines.push(`${row.name.padEnd(12)} ${parts.length ? parts.join(' · ')
      : (row.reachable ? '—' : '(no data)')}`);
  }

  const summary = REPORTED_STAGES
    .map(([key, label]) => `${totals[key]} ${label}`)
    .join(' · ');
  lines.push('', `Today: ${summary}`);

  return { text: lines.join('\n'), totals };
}

/**
 * The stages the loan MIS counts, and how they are labelled.
 *
 * Sanction sits between login and PF, so a row reads as a funnel left to right.
 */
const MIS_STAGES = [
  ['logged_in', 'Login'],
  ['sanctioned', 'Sanction'],
  ['pf_paid', 'PF']
];

/**
 * A percentage, or a dash when the denominator makes it meaningless.
 *
 * Nobody is served by "0% conversion" against zero logins — it reads as failure
 * when the honest answer is that there is nothing to convert yet.
 *
 * @param {number} part
 * @param {number} whole
 * @returns {string}
 */
function percent(part, whole) {
  if (!whole) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * CRM display names, made safe to put in a WhatsApp message.
 *
 * Live names include "Ankit_Dubey". WhatsApp reads a matched pair of underscores
 * as italics, so two such names in one message silently italicise everything
 * between them — the report would render wrong and nobody would know why.
 *
 * @param {string} name
 * @returns {string}
 */
function safeName(name) {
  return String(name || '').replace(/_/g, ' ').trim();
}

/**
 * The daily loan MIS: month-to-date performance per counsellor, against target.
 *
 * Month-to-date rather than same-day, because a PF target is monthly and a single
 * day's figure says nothing about whether it will be met. The point of the report
 * is the gap: how many PF are still required, and at what conversion rate.
 *
 * Figures come from the CRM's own per-day metrics, summed here. `leads_created`
 * is a count of leads; the rest are stage TRANSITIONS during the month — so a
 * lead that moved login → sanction → PF in one month is counted in all three.
 * That is the intended reading of a funnel MIS, not double counting.
 *
 * @param {import('../crm/client').CrmClient} crm
 * @param {{id: string, name: string}[]} agents
 * @param {{ today?: string, pfTarget?: number }} [options]
 * @returns {Promise<{text: string, totals: Object, rows: Object[]}|null>}
 */
async function buildLoanMis(crm, agents, options = {}) {
  const today = options.today || dateKey(0);
  const pfTarget = options.pfTarget ?? config.misReport.pfTarget;

  // "Month to date" is the 1st of the current month up to today, inclusive.
  const monthStart = `${today.slice(0, 7)}-01`;
  const daysElapsed = Number(today.slice(8, 10));

  const rows = [];

  for (const agent of agents) {
    const days = await crm.userDailyRange(agent.id, daysElapsed).catch((error) => {
      logger.warn(`MIS range failed for ${agent.name}: ${error.message}`);
      return null;
    });

    if (!days) {
      // Unreachable is not the same as zero. A broken call reported as a zero day
      // is a lie that looks exactly like a bad month.
      rows.push({ name: safeName(agent.name), reachable: false, leads: 0, counts: {} });
      continue;
    }

    // The endpoint's day window is undocumented, so the month boundary is
    // enforced here rather than trusted — a range that quietly reached back into
    // last month would inflate every figure in the report.
    const mtd = days.filter((d) => d.date >= monthStart && d.date <= today);

    const counts = Object.fromEntries(MIS_STAGES.map(([key]) => [key, 0]));
    let leads = 0;

    for (const day of mtd) {
      leads += day.leads_created || 0;
      const moves = day.transitions_by_stage || {};
      for (const [key] of MIS_STAGES) counts[key] += moves[key] || 0;
    }

    rows.push({ name: safeName(agent.name), reachable: true, leads, counts });
  }

  if (!rows.length) return null;

  const totals = {
    leads: rows.reduce((sum, r) => sum + r.leads, 0),
    ...Object.fromEntries(MIS_STAGES.map(([key]) =>
      [key, rows.reduce((sum, r) => sum + (r.counts[key] || 0), 0)]))
  };

  // Only people we could actually read count towards the team target, so an
  // unreachable counsellor does not make the team look short of a target that
  // was never theirs to miss.
  const teamTarget = pfTarget * rows.filter((r) => r.reachable).length;

  const lines = ['*Daily Loan MIS*', '', `📅 ${formatFullDay(today)}`, ''];

  for (const row of rows) {
    lines.push(`👤 ${row.name}`);

    if (!row.reachable) {
      lines.push('(no data — could not read the CRM)');
      lines.push('');
      continue;
    }

    const pf = row.counts.pf_paid;
    const login = row.counts.logged_in;

    lines.push(`Leads: ${row.leads} | Login: ${login} | `
      + `Sanction: ${row.counts.sanctioned} | PF: ${pf}`);
    lines.push(`🎯 PF Target: ${pfTarget} | Achievement: ${percent(pf, pfTarget)}`);
    lines.push(`📈 Login→PF: ${percent(pf, login)} | `
      + `Required: ${Math.max(0, pfTarget - pf)} PF`);
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('👥 TEAM MTD');
  lines.push('');
  lines.push(`Leads: ${totals.leads}`);
  lines.push(`Login: ${totals.logged_in}`);
  lines.push(`Sanction: ${totals.sanctioned}`);
  lines.push(`PF: ${totals.pf_paid}/${teamTarget}`);
  lines.push(`🎯 Achievement: ${percent(totals.pf_paid, teamTarget)}`);
  lines.push(`📈 Login→PF: ${percent(totals.pf_paid, totals.logged_in)}`);

  return { text: lines.join('\n'), totals: { ...totals, teamTarget }, rows };
}

/** "24 Aug 2026" — the MIS carries the full date, since it is filed and compared. */
function formatFullDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
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
  buildDailySummary, buildMyLeads, buildMorningMessage, buildStageReport,
  buildLoanMis, findFollowUps, renderFollowUps, dateKey, leadDate,
  REPORTED_STAGES, MIS_STAGES, percent, safeName
};
