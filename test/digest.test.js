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
