const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-digest.db');
process.env.DB_PATH = TEST_DB;

const db = require('../src/db');
const repo = require('../src/db/repositories');
const { buildDailySummary } = require('../src/pipeline/digest');
const { DailyScheduler } = require('../src/pipeline/scheduler');

/** A CRM double returning a fixed set of leads. */
function fakeCrm(leads) {
  return {
    users: new Map([
      ['a1', { id: 'a1', full_name: 'Ankit Dubey' }],
      ['a2', { id: 'a2', full_name: 'Zaid Ansari' }]
    ]),
    async listLeads() { return leads; }
  };
}

const lead = (over = {}) => ({
  phone: '+919876543210', full_name: 'Someone', current_stage: 'contacted',
  assigned_agent_id: 'a1', created_at: '2026-08-05T06:00:00Z', ...over
});

beforeEach(() => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  db.close();
  db.init();
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('daily summary', () => {
  test('counts leads per person', async () => {
    const s = await buildDailySummary(fakeCrm([
      lead(), lead(), lead({ assigned_agent_id: 'a2' })
    ]), { day: '2026-08-05' });

    assert.match(s.text, /3 leads/);
    assert.match(s.text, /Ankit Dubey 2/);
    assert.match(s.text, /Zaid Ansari 1/);
  });

  test('names the leads nobody has picked up', async () => {
    // The valuable half: a lead still at `created` a day later is one nobody
    // called, and nothing else watches for that.
    const s = await buildDailySummary(fakeCrm([
      lead({ current_stage: 'created', full_name: 'Raghav' }),
      lead({ current_stage: 'contacted' })
    ]), { day: '2026-08-05' });

    assert.match(s.text, /1 still untouched/);
    assert.match(s.text, /Raghav/);
    assert.equal(s.untouched, 1);
  });

  test('says so when everything was picked up', async () => {
    const s = await buildDailySummary(fakeCrm([lead()]), { day: '2026-08-05' });
    assert.match(s.text, /Every lead has been picked up/);
  });

  test('says nothing at all on a day with no leads', async () => {
    // A summary reading "0 leads" every morning trains people to ignore the bot.
    assert.equal(await buildDailySummary(fakeCrm([]), { day: '2026-08-05' }), null);
  });

  test('ignores leads from other days', async () => {
    // date_from is inclusive with no matching date_to, so the day is filtered here.
    const s = await buildDailySummary(fakeCrm([
      lead({ created_at: '2026-08-05T06:00:00Z' }),
      lead({ created_at: '2026-08-06T06:00:00Z' })
    ]), { day: '2026-08-05' });

    assert.match(s.text, /1 lead\b/);
  });

  test('unassigned leads are shown as such, not hidden', async () => {
    const s = await buildDailySummary(fakeCrm([
      lead({ assigned_agent_id: null })
    ]), { day: '2026-08-05' });
    assert.match(s.text, /Unassigned 1/);
  });
});

describe('daily scheduler', () => {
  test('does not fire before the appointed time', async () => {
    let ran = 0;
    const s = new DailyScheduler({ name: 'test', at: '23:59', run: async () => { ran++; } });
    await s.tick();
    assert.equal(ran, 0);
  });

  test('fires once, then not again the same day', async () => {
    // A redeploy happens on every push; without this the summary would post again
    // each time.
    let ran = 0;
    const s = new DailyScheduler({ name: 'test', at: '00:00', run: async () => { ran++; } });
    await s.tick();
    await s.tick();
    await s.tick();
    assert.equal(ran, 1);
  });

  test('a job that throws does not retry all day', async () => {
    let ran = 0;
    const s = new DailyScheduler({
      name: 'test', at: '00:00',
      run: async () => { ran++; throw new Error('boom'); }
    });
    await s.tick();
    await s.tick();
    assert.equal(ran, 1, 'the run is recorded before it executes');
  });
});

describe('follow-up reminders', () => {
  const { findFollowUps, renderFollowUps, buildMorningMessage } = require('../src/pipeline/digest');

  /**
   * Both ends of the window are pinned. Fixing only `today` leaves the overdue
   * cutoff coming from the real clock, so these tests passed when written and
   * then expired on their own a few days later.
   */
  const WINDOW = { today: '2026-08-06', overdueFrom: '2026-07-30' };

  const dated = (due, over = {}) => lead({ due_date: due, ...over });

  test('separates due today from overdue', async () => {
    const crm = fakeCrm([
      dated('2026-08-06T00:00:00Z', { full_name: 'Today One' }),
      dated('2026-08-01T00:00:00Z', { full_name: 'Late One' }),
      lead({ full_name: 'No date' })
    ]);
    const r = await findFollowUps(crm, WINDOW);

    assert.equal(r.due.length, 1);
    assert.equal(r.overdue.length, 1);
    assert.equal(r.due[0].full_name, 'Today One');
  });

  test('a finished lead is not owed a follow-up', async () => {
    const crm = fakeCrm([
      dated('2026-08-01T00:00:00Z', { current_stage: 'disbursed' }),
      dated('2026-08-01T00:00:00Z', { current_stage: 'lost' }),
      dated('2026-08-01T00:00:00Z', { current_stage: 'processing' })
    ]);
    const r = await findFollowUps(crm, WINDOW);
    assert.equal(r.overdue.length, 1);
  });

  test('a long list is summarised per person, not listed', async () => {
    // Eight arbitrary rows out of a hundred and forty helps nobody. A count per
    // person tells each of them how much is theirs.
    const many = Array.from({ length: 20 }, (_, i) =>
      dated('2026-08-06T00:00:00Z', {
        full_name: `Lead ${i}`,
        assigned_agent_id: i % 2 ? 'a1' : 'a2'
      }));
    const crm = fakeCrm(many);
    const r = await findFollowUps(crm, { today: '2026-08-06' });
    const text = renderFollowUps(r, crm);

    assert.match(text, /Due today \(20\)/);
    assert.match(text, /Ankit Dubey 10/);
    assert.match(text, /Zaid Ansari 10/);
    assert.doesNotMatch(text, /Lead 3/, 'individual leads must not be listed');
  });

  test('a long-overdue backlog is counted, never listed', async () => {
    // The live CRM carries hundreds. Listing them every morning is noise, and
    // noise is how a bot gets ignored.
    const crm = fakeCrm([
      dated('2026-01-01T00:00:00Z', { full_name: 'Ancient' }),
      dated('2026-08-05T00:00:00Z', { full_name: 'Recent' })
    ]);
    const r = await findFollowUps(crm, { today: '2026-08-06', overdueFrom: '2026-08-01' });

    assert.equal(r.overdue.length, 1, 'this week is actionable');
    assert.equal(r.olderCount, 1, 'older is a backlog, only counted');

    const text = renderFollowUps(r, crm);
    assert.match(text, /1 older follow-ups still open/);
    assert.doesNotMatch(text, /Ancient/);
  });

  test('nothing due produces no section at all', async () => {
    const crm = fakeCrm([lead()]);
    const r = await findFollowUps(crm, { today: '2026-08-06' });
    assert.equal(renderFollowUps(r, crm), null);
  });

  test('names the owner so it reaches the right person', async () => {
    const crm = fakeCrm([dated('2026-08-06T00:00:00Z', { full_name: 'Kiran' })]);
    const r = await findFollowUps(crm, { today: '2026-08-06' });
    assert.match(renderFollowUps(r, crm), /Kiran · Ankit Dubey/);
  });
});

describe('the morning message', () => {
  const { buildMorningMessage } = require('../src/pipeline/digest');

  test('joins the summary and the follow-ups into one post', async () => {
    // Two messages every morning is how a bot becomes something people scroll past.
    const crm = fakeCrm([
      lead({ created_at: '2026-08-05T06:00:00Z' }),
      lead({ created_at: '2026-08-05T06:00:00Z', due_date: '2026-08-06T00:00:00Z' })
    ]);
    const m = await buildMorningMessage(crm, { day: '2026-08-05', today: '2026-08-06' });

    assert.match(m.text, /2 leads/);
    assert.match(m.text, /Due today/);
    assert.equal(m.due, 1);
  });

  test('says nothing at all when there is nothing to say', async () => {
    const m = await buildMorningMessage(fakeCrm([]), { day: '2026-08-05', today: '2026-08-06' });
    assert.equal(m, null);
  });

  test('posts follow-ups even on a day with no new leads', async () => {
    const crm = fakeCrm([
      lead({ created_at: '2026-08-01T06:00:00Z', due_date: '2026-08-06T00:00:00Z' })
    ]);
    const m = await buildMorningMessage(crm, { day: '2026-08-05', today: '2026-08-06' });

    assert.ok(m, 'a quiet day for new leads still has follow-ups worth posting');
    assert.match(m.text, /Due today/);
  });
});

describe('end-of-day login and PF report', () => {
  const { buildStageReport } = require('../src/pipeline/digest');

  /** A CRM double whose daily report returns scripted transitions. */
  function reportingCrm(byAgent) {
    return {
      users: new Map(),
      async request(method, path) {
        const id = new URL('http://x' + path).searchParams.get('user_id');
        if (!(id in byAgent)) return null;
        return { metrics: { transitions_by_stage: byAgent[id] } };
      }
    };
  }

  const AGENTS = [
    { id: 'a1', name: 'Ankit' }, { id: 'a2', name: 'Himanshu' },
    { id: 'a3', name: 'Zaid' }, { id: 'a4', name: 'Rudra' }
  ];

  test('counts only login and PF, ignoring other activity', async () => {
    // Contacted and DNP measure effort; a login and a paid fee are where a file
    // has actually moved forward.
    const crm = reportingCrm({
      a1: { contacted: 12, dnp: 5 },
      a2: { logged_in: 2, contacted: 3 },
      a3: { logged_in: 1, pf_paid: 1 },
      a4: {}
    });
    const r = await buildStageReport(crm, AGENTS, { day: '2026-08-05' });

    assert.match(r.text, /Himanshu\s+2 login/);
    assert.match(r.text, /Zaid\s+1 login · 1 PF/);
    assert.doesNotMatch(r.text, /contacted/, 'other stages are not the report');
    assert.deepEqual(r.totals, { logged_in: 3, pf_paid: 1 });
  });

  test('someone with nothing is still listed', async () => {
    // A name against a dash is the point of a team report. Hiding it would make
    // the report only ever good news.
    const crm = reportingCrm({ a1: {}, a2: {}, a3: {}, a4: {} });
    const r = await buildStageReport(crm, AGENTS, { day: '2026-08-05' });

    assert.match(r.text, /Ankit\s+—/);
    assert.match(r.text, /Today: 0 login · 0 PF/);
  });

  test('an unreachable person is shown as such, not as zero', async () => {
    // Reporting a failed lookup as "did nothing" would be a lie about someone's
    // work.
    const crm = reportingCrm({ a1: { logged_in: 1 } });
    const r = await buildStageReport(crm, AGENTS, { day: '2026-08-05' });

    assert.match(r.text, /Himanshu\s+\(no data\)/);
  });
});

describe('loan MIS (month to date)', () => {
  const { buildLoanMis } = require('../src/pipeline/digest');

  /**
   * A CRM double whose range report returns scripted per-day rows.
   * @param {Object<string, object[]>} byAgent - profile id -> daily rows
   */
  function rangeCrm(byAgent) {
    return {
      users: new Map(),
      calls: [],
      async userDailyRange(userId, days) {
        this.calls.push({ userId, days });
        if (!(userId in byAgent)) throw new Error('no such user');
        return byAgent[userId];
      }
    };
  }

  const day = (date, leads, moves = {}) =>
    ({ date, leads_created: leads, transitions_by_stage: moves });

  const AGENTS = [{ id: 'a1', name: 'Ankit' }, { id: 'a2', name: 'Zaid' }];

  test('sums the month, not just the day', async () => {
    const crm = rangeCrm({
      a1: [
        day('2026-08-01', 3, { logged_in: 2, sanctioned: 1 }),
        day('2026-08-02', 4, { logged_in: 1, pf_paid: 2 })
      ],
      a2: [day('2026-08-01', 1, { logged_in: 1 })]
    });
    const r = await buildLoanMis(crm, AGENTS, { today: '2026-08-02', pfTarget: 10 });

    assert.match(r.text, /Leads: 7 \| Login: 3 \| Sanction: 1 \| PF: 2/);
    assert.deepEqual(r.totals,
      { leads: 8, logged_in: 4, sanctioned: 1, pf_paid: 2, teamTarget: 20 });
  });

  test('asks for exactly the days elapsed this month', async () => {
    // Requesting more would reach into last month and inflate every figure.
    const crm = rangeCrm({ a1: [], a2: [] });
    await buildLoanMis(crm, AGENTS, { today: '2026-08-17', pfTarget: 10 });

    assert.deepEqual(crm.calls.map((c) => c.days), [17, 17]);
  });

  test('a row from last month is excluded even if the API returns it', async () => {
    // The endpoint's day window is undocumented, so the boundary is enforced on
    // our side rather than trusted.
    const crm = rangeCrm({
      a1: [day('2026-07-31', 99, { pf_paid: 99 }), day('2026-08-01', 2, { pf_paid: 1 })],
      a2: []
    });
    const r = await buildLoanMis(crm, AGENTS, { today: '2026-08-01', pfTarget: 10 });

    assert.equal(r.totals.leads, 2);
    assert.equal(r.totals.pf_paid, 1);
  });

  test('achievement and required PF are measured against the target', async () => {
    const crm = rangeCrm({ a1: [day('2026-08-01', 0, { pf_paid: 3 })], a2: [] });
    const r = await buildLoanMis(crm, AGENTS, { today: '2026-08-01', pfTarget: 10 });

    assert.match(r.text, /PF Target: 10 \| Achievement: 30%/);
    assert.match(r.text, /Required: 7 PF/);
  });

  test('beating the target never asks for a negative number of PF', async () => {
    const crm = rangeCrm({ a1: [day('2026-08-01', 0, { pf_paid: 14 })], a2: [] });
    const r = await buildLoanMis(crm, AGENTS, { today: '2026-08-01', pfTarget: 10 });

    assert.match(r.text, /Achievement: 140%/);
    assert.match(r.text, /Required: 0 PF/);
  });

  test('a conversion rate with no logins reads as a dash, not 0%', async () => {
    // "0%" against zero logins reads as failure when the honest answer is that
    // there is nothing to convert yet.
    const crm = rangeCrm({ a1: [day('2026-08-01', 5, {})], a2: [] });
    const r = await buildLoanMis(crm, AGENTS, { today: '2026-08-01', pfTarget: 10 });

    assert.match(r.text, /Login→PF: —/);
  });

  test('an unreachable counsellor is shown as such, not as zero', async () => {
    // Reporting a failed call as "did nothing" is a lie about someone's month.
    const crm = rangeCrm({ a1: [day('2026-08-01', 2, { pf_paid: 1 })] });
    const r = await buildLoanMis(crm, AGENTS, { today: '2026-08-01', pfTarget: 10 });

    assert.match(r.text, /Zaid\n\(no data/);
    // ...and they do not drag the team target up for a month that was never theirs.
    assert.equal(r.totals.teamTarget, 10);
  });

  test('underscores in a CRM name are removed', async () => {
    // WhatsApp reads a matched pair of underscores as italics, so two such names
    // in one message would silently italicise everything between them.
    const crm = rangeCrm({ u1: [day('2026-08-01', 1, {})], u2: [day('2026-08-01', 1, {})] });
    const r = await buildLoanMis(crm, [
      { id: 'u1', name: 'Ankit_Dubey' }, { id: 'u2', name: 'Ravi_Kumar' }
    ], { today: '2026-08-01', pfTarget: 10 });

    assert.match(r.text, /👤 Ankit Dubey/);
    assert.doesNotMatch(r.text, /_/);
  });

  test('the team block reports PF against the summed target', async () => {
    const crm = rangeCrm({
      a1: [day('2026-08-01', 5, { logged_in: 4, pf_paid: 2 })],
      a2: [day('2026-08-01', 3, { logged_in: 6, pf_paid: 1 })]
    });
    const r = await buildLoanMis(crm, AGENTS, { today: '2026-08-01', pfTarget: 10 });

    assert.match(r.text, /PF: 3\/20/);
    assert.match(r.text, /🎯 Achievement: 15%/);
    assert.match(r.text, /📈 Login→PF: 30%/);
  });

  test('the date is shown in full, since the report is filed and compared', async () => {
    const crm = rangeCrm({ a1: [], a2: [] });
    const r = await buildLoanMis(crm, AGENTS, { today: '2026-08-24', pfTarget: 10 });

    assert.match(r.text, /📅 24 Aug 2026/);
    assert.match(r.text, /\*Daily Loan MIS\*/);
  });
});
