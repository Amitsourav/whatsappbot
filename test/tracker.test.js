const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-tracker.db');
process.env.DB_PATH = TEST_DB;

const db = require('../src/db');
const repo = require('../src/db/repositories');
const { TrackerClient, same, taskMarked } = require('../src/tracker/client');
const { Orchestrator } = require('../src/pipeline/orchestrator');

const OWNER = '+917004428198';
const GROUP_JID = '120363777@g.us';

const SETTINGS = {
  url: 'https://tracker.test/ingest', token: 'tok',
  ownerPhone: OWNER, flushMs: 60_000, batchSize: 20
};

/** A group with the Tracker switch on but lead capture off — the common case. */
function makeGroup({ tracker = 1, active = 0 } = {}) {
  const g = repo.groups.upsert(GROUP_JID, 'AdmitVerse Tech Team');
  repo.groups.setActive(g.id, active);
  repo.groups.setTrackerEnabled(g.id, tracker);
  return repo.groups.byWaId(GROUP_JID);
}

const msg = (over = {}) => ({
  id: 'T-' + Math.random().toString(36).slice(2, 11),
  groupId: GROUP_JID, groupName: 'AdmitVerse Tech Team', isGroup: true,
  fromMe: false, senderPhone: '+919000000002', senderName: 'Priya',
  text: 'random chat', mentions: [], quotedAuthorPhone: null, quotedText: null,
  timestamp: 1789077000, ...over
});

const tracker = (fetchImpl) => new TrackerClient({ fetchImpl, settings: { ...SETTINGS } });

beforeEach(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  db.init();
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('same() — phone identity', () => {
  test('ignores +, spaces and a missing country code', () => {
    assert.ok(same('+917004428198', '7004428198'));
    assert.ok(same('91 70044 28198', '+917004428198'));
    assert.ok(!same('+917004428198', '+919876543210'));
    assert.ok(!same(null, '+917004428198'));
  });
});

describe('maybeQueue — what gets forwarded', () => {
  test('a message tagging the owner is queued', () => {
    const g = makeGroup();
    assert.ok(tracker().maybeQueue(msg({ text: 'draft kal tak', mentions: [OWNER] }), g));
    assert.equal(repo.trackerOutbox.pending(10).length, 1);
  });

  test('a reply to the owner is queued', () => {
    const g = makeGroup();
    assert.ok(tracker().maybeQueue(
      msg({ text: 'and the invoice too', quotedAuthorPhone: OWNER }), g));
  });

  test('a message marked "Task" is queued even with no tag', () => {
    // The agreed format: the sender says outright that it is a task.
    //   Task
    //   invoice update kar dena
    const g = makeGroup();
    assert.ok(tracker().maybeQueue(msg({ text: 'Task\ninvoice update kar dena' }), g));
  });

  test('the marker is accepted on one line too', () => {
    const g = makeGroup();
    const t = tracker();
    for (const text of ['Task: invoice update kar dena', 'task - server restart kar do',
                        'TASK\nreport bhej dena']) {
      assert.ok(t.maybeQueue(msg({ text }), g), `should queue: ${text}`);
    }
  });

  test('work talk without the marker is NOT queued', () => {
    // This is the change of 11 Sep 2026. A keyword list forwarded anything with
    // "update", "pending" or "bhej dena" in it, which meant two colleagues
    // talking to each other were sent to Amit's task app. Only an explicit
    // marker counts now.
    const g = makeGroup();
    const t = tracker();
    for (const text of ['invoice update kar dena', 'report bhej dena by eod',
                        'ye kal tak pending hai', 'urgent: server down',
                        'ye task kal complete karna hai']) {
      assert.equal(t.maybeQueue(msg({ text }), g), false, `should skip: ${text}`);
    }
    assert.equal(repo.trackerOutbox.pending(10).length, 0);
  });

  test('"Tasks pending for everyone" is not a task', () => {
    // The separator or line break after the word is what keeps the marker honest.
    const g = makeGroup();
    assert.equal(tracker().maybeQueue(msg({ text: 'Tasks pending for everyone' }), g), false);
  });

  test('the marker alone, with nothing after it, is not a task', () => {
    const g = makeGroup();
    assert.equal(tracker().maybeQueue(msg({ text: 'Task' }), g), false);
  });

  test('ordinary chat is not queued', () => {
    const g = makeGroup();
    assert.equal(tracker().maybeQueue(msg({ text: 'haha that was funny' }), g), false);
    assert.equal(repo.trackerOutbox.pending(10).length, 0);
  });

  test('a message tagging someone else is not queued', () => {
    const g = makeGroup();
    assert.equal(
      tracker().maybeQueue(msg({ text: 'please look', mentions: ['+919876543210'] }), g),
      false);
  });

  test("the owner's own messages ARE queued, as promises", () => {
    // Inverted 11 Sep 2026 by the §12 addendum. What Amit writes is a promise he
    // made; Tracker's Phase 4 reads those, so they are no longer skipped.
    const g = makeGroup();
    assert.ok(tracker().maybeQueue(msg({
      senderPhone: OWNER, senderName: 'Amit',
      text: 'haan main kal tak revised pricing sheet bhej dunga'
    }), g));

    const payload = JSON.parse(repo.trackerOutbox.pending(1)[0].payload);
    assert.equal(payload.fromOwner, true);
    // Meaningless on his own message, so both are false whatever the mentions say.
    assert.equal(payload.mentionedMe, false);
    assert.equal(payload.isReplyToMe, false);
  });

  test("a promise needs no tag and no Task marker", () => {
    // A promise is never tagged and never marked — requiring either would catch
    // none of them.
    const g = makeGroup();
    assert.ok(tracker().maybeQueue(msg({
      senderPhone: OWNER, text: 'invoice bhej diya subah hi', mentions: []
    }), g));
  });

  test("fromOwner is false for everyone else", () => {
    const g = makeGroup();
    tracker().maybeQueue(msg({ text: 'Task\ncheck the logs' }), g);
    const payload = JSON.parse(repo.trackerOutbox.pending(1)[0].payload);
    assert.equal(payload.fromOwner, false);
  });

  test("the owner's acknowledgements are still skipped", () => {
    // An acknowledgement is not a promise, whoever wrote it.
    const g = makeGroup();
    const t = tracker();
    for (const text of ['ok', 'done', 'thik hai', 'noted', '👍']) {
      assert.equal(t.maybeQueue(msg({ senderPhone: OWNER, text }), g), false,
        `should skip: ${text}`);
    }
  });

  test("a short fragment from the owner is not a promise", () => {
    // "dekhta hoon" is not a commitment, and the noise list cannot enumerate
    // every stub. Length is the guard.
    const g = makeGroup();
    const t = tracker();
    for (const text of ['dekhta hoon', 'haan bhai', 'kal dekhenge']) {
      assert.equal(t.maybeQueue(msg({ senderPhone: OWNER, text }), g), false,
        `should skip: ${text}`);
    }
    assert.equal(repo.trackerOutbox.pending(10).length, 0);
  });

  test('noise, commands and empty text are not queued', () => {
    const g = makeGroup();
    const t = tracker();
    for (const text of ['ok', 'done', 'thik hai', '👍', 'my leads', 'help', '   ']) {
      assert.equal(t.maybeQueue(msg({ text, mentions: [OWNER] }), g), false,
        `should skip: ${text}`);
    }
  });

  test('nothing is queued when the group switch is off', () => {
    const g = makeGroup({ tracker: 0 });
    assert.equal(tracker().maybeQueue(msg({ text: 'Task\nsomething', mentions: [OWNER] }), g), false);
  });

  test('nothing is queued when Tracker is not configured', () => {
    const g = makeGroup();
    const t = new TrackerClient({ settings: { ...SETTINGS, url: '', token: '' } });
    assert.equal(t.maybeQueue(msg({ text: 'Task\nsomething', mentions: [OWNER] }), g), false);
  });

  test('our own outgoing messages are not queued', () => {
    const g = makeGroup();
    assert.equal(tracker().maybeQueue(
      msg({ fromMe: true, text: 'Task\nsomething', mentions: [OWNER] }), g), false);
  });

  test('the same message twice queues one row', () => {
    // WhatsApp redelivers after a reconnect; wa_message_id is UNIQUE.
    const g = makeGroup();
    const t = tracker();
    const m = msg({ text: 'Task\nsomething', mentions: [OWNER] });
    assert.ok(t.maybeQueue(m, g));
    assert.equal(t.maybeQueue(m, g), false);
    assert.equal(repo.trackerOutbox.pending(10).length, 1);
  });

  test('the payload carries the flags Tracker extracts from', () => {
    const g = makeGroup();
    tracker().maybeQueue(msg({
      text: 'Task\ndraft bhejna hai', mentions: [OWNER], senderName: 'Priya',
      quotedText: 'earlier message', timestamp: 1789077000
    }), g);

    const payload = JSON.parse(repo.trackerOutbox.pending(1)[0].payload);
    assert.equal(payload.mentionedMe, true);
    assert.equal(payload.isReplyToMe, false);
    assert.equal(payload.senderName, 'Priya');
    assert.equal(payload.quotedText, 'earlier message');
    // Seconds, not milliseconds — a millisecond value would date the task to 58,000 AD.
    assert.equal(payload.timestamp, 1789077000);
    assert.ok(String(payload.timestamp).length <= 10);
  });
});

describe('flush — sending', () => {
  const queue = (t, n = 1) => {
    const g = makeGroup();
    for (let i = 0; i < n; i += 1) {
      t.maybeQueue(msg({ text: `Task\nnumber ${i}`, mentions: [OWNER] }), g);
    }
  };

  test('a 200 marks everything sent', async () => {
    const calls = [];
    const t = tracker(async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, status: 200, async json() { return { created_tasks: 1 }; } };
    });
    queue(t, 3);

    const r = await t.flush();
    assert.equal(r.sent, 3);
    assert.equal(calls.length, 1, 'one POST for one group');
    assert.equal(calls[0].messages.length, 3);
    assert.equal(calls[0].group.id, GROUP_JID);
    assert.equal(repo.trackerOutbox.pending(10).length, 0);
  });

  test('created_tasks: 0 is still a success', async () => {
    // Usually nothing in the batch was a task. Not an error.
    const t = tracker(async () => ({ ok: true, status: 200, async json() { return { created_tasks: 0 }; } }));
    queue(t, 2);
    assert.equal((await t.flush()).sent, 2);
  });

  test('a 500 leaves the batch queued for the next pass', async () => {
    const t = tracker(async () => ({ ok: false, status: 500, async text() { return 'boom'; } }));
    queue(t, 2);

    const r = await t.flush();
    assert.equal(r.sent, 0);
    assert.equal(repo.trackerOutbox.pending(10).length, 2, 'still pending');
    assert.equal(repo.trackerOutbox.pending(10)[0].attempts, 1);
  });

  test('a 401 stops the timer rather than retrying forever', async () => {
    let hits = 0;
    const t = tracker(async () => { hits += 1; return { ok: false, status: 401, async text() { return 'nope'; } }; });
    queue(t, 2);
    t.start();

    await t.flush();
    assert.equal(t.stopped, true, 'capture should switch itself off');
    assert.equal(t.timer, null, 'the timer should be cleared');

    await t.flush();
    assert.equal(hits, 1, 'a bad token must not be retried in a loop');
  });

  test('a 400 fails the batch without retrying', async () => {
    const t = tracker(async () => ({ ok: false, status: 400, async text() { return 'bad shape'; } }));
    queue(t, 1);

    await t.flush();
    assert.equal(repo.trackerOutbox.pending(10).length, 0, 'not left pending');
    assert.equal(repo.trackerOutbox.counts().failed, 1);
  });

  test('a throwing fetch never propagates out of flush', async () => {
    // The whole point: a Tracker fault must not reach anything else.
    const t = tracker(async () => { throw new Error('socket hang up'); });
    queue(t, 1);

    await assert.doesNotReject(() => t.flush());
    assert.equal(repo.trackerOutbox.pending(10).length, 1, 'kept for a retry');
  });

  test('a batch gives up after eight attempts', async () => {
    const t = tracker(async () => { throw new Error('down'); });
    queue(t, 1);
    for (let i = 0; i < 8; i += 1) await t.flush();

    assert.equal(repo.trackerOutbox.pending(10).length, 0);
    assert.equal(repo.trackerOutbox.counts().failed, 1);
  });

  test('each group is posted separately', async () => {
    // Tracker extracts per conversation; mixing groups would invent a thread.
    const posts = [];
    const t = tracker(async (url, opts) => {
      posts.push(JSON.parse(opts.body).group.id);
      return { ok: true, status: 200, async json() { return {}; } };
    });

    const a = makeGroup();
    t.maybeQueue(msg({ text: 'Task\none', mentions: [OWNER] }), a);

    const other = repo.groups.upsert('120363888@g.us', 'Second Group');
    repo.groups.setTrackerEnabled(other.id, 1);
    t.maybeQueue(msg({
      groupId: '120363888@g.us', groupName: 'Second Group',
      text: 'Task\ntwo', mentions: [OWNER]
    }), repo.groups.byWaId('120363888@g.us'));

    await t.flush();
    assert.deepEqual(posts.sort(), ['120363777@g.us', '120363888@g.us']);
  });
});

describe('lead capture is never affected', () => {
  /** A CRM double that records creates. */
  const fakeCrm = () => {
    const created = [];
    return {
      created,
      async createLead(f) { created.push(f); return { lead: { id: 'crm-1', ...f }, deferred: {}, dropped: [] }; },
      async updateLead(id, f) { return { lead: { id }, dropped: [] }; },
      async addRemark() { return {}; },
      async findByPhone() { return { status: 'none', lead: null }; },
      async getLead(id) { return { id, current_stage: 'created' }; }
    };
  };

  test('a Tracker explosion does not stop a lead reaching the CRM', async () => {
    // The rule the whole design rests on: task capture may never cost a lead.
    const g = repo.groups.upsert(GROUP_JID, 'FMC In-House');
    repo.groups.setActive(g.id, 1);
    repo.groups.setPurpose(g.id, 'inhouse');
    repo.groups.setSendEnabled(g.id, 1);
    repo.groups.setTrackerEnabled(g.id, 1);

    repo.employees.upsert({
      waPhone: '+919812345678', crmProfileId: 'crm-profile-1', name: 'Rahul', email: 'r@x.com'
    });

    const crm = fakeCrm();
    const exploding = {
      maybeQueue() { throw new Error('tracker is on fire'); }
    };
    const wa = { sent: [], async reply(m) { this.sent.push(m); return true; } };

    const o = new Orchestrator({ crm, whatsapp: wa, tracker: exploding });
    await o.handle(msg({
      text: 'Priya Sharma\n9876543210\n@919812345678',
      mentions: ['+919812345678']
    }), {});

    assert.equal(crm.created.length, 1, 'the lead must still reach the CRM');
    assert.equal(crm.created[0].phone, '+919876543210');
    assert.match(wa.sent[0].text, /Lead created/);
  });

  test('a group that only feeds Tracker never creates a lead', async () => {
    // is_active is off, so nothing about lead capture may happen here.
    const g = makeGroup({ tracker: 1, active: 0 });
    const crm = fakeCrm();
    const t = tracker();
    const wa = { sent: [], async reply(m) { this.sent.push(m); return true; } };

    const o = new Orchestrator({ crm, whatsapp: wa, tracker: t });
    await o.handle(msg({
      text: 'Task\nPriya Sharma 9876543210',
      mentions: [OWNER]
    }), {});

    assert.equal(crm.created.length, 0, 'no lead from a non-lead group');
    assert.equal(wa.sent.length, 0, 'and nothing said in the group');
    assert.equal(repo.trackerOutbox.pending(10).length, 1, 'but the task was queued');
  });
});
