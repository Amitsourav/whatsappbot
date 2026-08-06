const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Point the database at a throwaway file before anything loads config.
const TEST_DB = path.join(__dirname, '..', 'data', 'test-orchestrator.db');
process.env.DB_PATH = TEST_DB;

const db = require('../src/db');
const repo = require('../src/db/repositories');
const { Orchestrator } = require('../src/pipeline/orchestrator');
const { DuplicateLeadError } = require('../src/crm/client');

const RAHUL_WA = '+919812345678';
const RAHUL_CRM = 'crm-profile-rahul';

/** A CRM double that records what it was asked to do. */
function fakeCrm(overrides = {}) {
  const calls = { created: [], updated: [], remarks: [], fetched: [] };
  return {
    calls,
    async createLead(fields) {
      calls.created.push(fields);
      if (overrides.createThrows) throw overrides.createThrows;
      return { lead: { id: 'crm-lead-1', ...fields }, deferred: overrides.deferred || {}, dropped: [] };
    },
    async updateLead(id, fields) {
      calls.updated.push({ id, fields });
      return { lead: { id, ...fields }, dropped: [] };
    },
    async addRemark(id, text, sourceId) {
      calls.remarks.push({ id, text, sourceId });
      return { id: 'remark-1' };
    },
    async findByPhone() {
      return overrides.existingByPhone || null;
    },
    async getLead(id) {
      calls.fetched.push(id);
      return { id, current_stage: overrides.existingStage || 'contacted',
               full_name: overrides.existingName || 'Priya S' };
    }
  };
}

/** A WhatsApp double that records outgoing replies. */
function fakeWhatsApp() {
  const sent = [];
  return { sent, async reply(msg) { sent.push(msg); return true; } };
}

function makeGroup({ active = true, send = true, purpose = 'inhouse' } = {}) {
  const g = repo.groups.upsert('120363999@g.us', 'FMC In-House');
  repo.groups.setActive(g.id, active);
  repo.groups.setPurpose(g.id, purpose);
  repo.groups.setSendEnabled(g.id, send);
  return repo.groups.byWaId('120363999@g.us');
}

const incoming = (over = {}) => ({
  id: 'MSG-' + Math.random().toString(36).slice(2),
  groupId: '120363999@g.us',
  groupName: 'FMC In-House',
  isGroup: true,
  fromMe: false,
  senderPhone: '+919000000001',
  text: 'New lead @919812345678\nPriya Sharma\n9876543210',
  mentions: [RAHUL_WA],
  quotedId: null,
  timestamp: 1754400000,
  ...over
});

beforeEach(() => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  db.close();
  db.init();
  repo.employees.upsert({
    waPhone: RAHUL_WA, crmProfileId: RAHUL_CRM, name: 'Rahul Kumar', email: 'r@x.com'
  });
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('new lead — the happy path', () => {
  test('creates in the CRM, assigns the tagged employee, confirms in the group', async () => {
    const group = makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.equal(crm.calls.created.length, 1);
    assert.equal(crm.calls.created[0].full_name, 'Priya Sharma');
    assert.equal(crm.calls.created[0].phone, '+919876543210');
    assert.equal(crm.calls.created[0].assigned_agent_id, RAHUL_CRM);

    assert.match(wa.sent[0].text, /Lead created/);
    assert.match(wa.sent[0].text, /Priya Sharma/);

    const stored = repo.leads.recent()[0];
    assert.equal(stored.status, 'created');
    assert.equal(stored.crm_lead_id, 'crm-lead-1');
    assert.equal(group.send_enabled, 1);
  });

  test('labelled fields ride along with the create', async () => {
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210\nUniversity: DU\nCourse: MBA'
    }));

    assert.equal(crm.calls.created[0].university, 'DU');
    assert.equal(crm.calls.created[0].target_degree, 'MBA');
  });

  test('update-only fields are patched after create, not lost (C11)', async () => {
    makeGroup();
    const crm = fakeCrm({ deferred: { loan_amount: '15 lakh' } });
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming());

    assert.equal(crm.calls.updated.length, 1);
    assert.deepEqual(crm.calls.updated[0].fields, { loan_amount: '15 lakh' });
  });

  test('unrecognised text is preserved as a remark', async () => {
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210\nvery keen, call after 6'
    }));

    assert.match(crm.calls.remarks[0].text, /very keen, call after 6/);
  });

  test('a redelivered message does nothing the second time', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const msg = incoming();

    await o.handle(msg);
    await o.handle(msg);

    // WhatsApp replays messages after a reconnect; without the unique message id
    // this would be a second lead for the same person.
    assert.equal(crm.calls.created.length, 1);
  });
});

describe('leads that are held for a human', () => {
  test('no mention, number unknown → held and the group is asked to tag (Q6)', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(
      incoming({ text: 'Priya Sharma\n9876543210', mentions: [] })
    );

    assert.equal(crm.calls.created.length, 0, 'nothing should reach the CRM');
    assert.equal(repo.leads.held().length, 1, 'and nothing should be lost');
    assert.match(wa.sent[0].text, /Please tag the employee/);
  });

  test('no mention, but the number IS a lead → answer who owns it', async () => {
    // A number posted with no tag is usually the question "who has this one?".
    // Seen live: "78668 78035 / Existing lead. / Whoever the counsellor is please
    // call" — the bot had the answer and said nothing useful.
    makeGroup();
    const crm = fakeCrm({
      existingByPhone: {
        id: 'known-lead', serial_no: 4211, full_name: 'Ganpati Podder',
        current_stage: 'processing', assigned_agent_id: 'agent-9'
      }
    });
    crm.users = new Map([['agent-9', { id: 'agent-9', full_name: 'Zaid Ansari' }]]);

    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(
      incoming({ text: '78668 78035\nExisting lead.', mentions: [] })
    );

    assert.match(wa.sent[0].text, /Already in the CRM/);
    assert.match(wa.sent[0].text, /Counsellor: Zaid Ansari/, 'the question actually asked');
    assert.match(wa.sent[0].text, /Stage: Processing/);
    assert.equal(crm.calls.created.length, 0, 'must not create anything');
    assert.equal(repo.leads.recent()[0].status, 'existing');
  });

  test('two mentions → held with both names (Q9)', async () => {
    makeGroup();
    repo.employees.upsert({
      waPhone: '+919999888877', crmProfileId: 'p2', name: 'Priya Singh'
    });
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm: fakeCrm(), whatsapp: wa }).handle(incoming({
      mentions: [RAHUL_WA, '+919999888877']
    }));

    assert.match(wa.sent[0].text, /You tagged 2 people/);
    assert.match(wa.sent[0].text, /Rahul Kumar and Priya Singh/);
  });

  test('an unmapped employee → held, and the fix is named', async () => {
    makeGroup();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm: fakeCrm(), whatsapp: wa }).handle(incoming({
      text: 'New lead @919111111111\nPriya Sharma\n9876543210',
      mentions: ['+919111111111']
    }));

    assert.equal(repo.leads.held()[0].held_reason, 'unknown_employee');
    assert.match(wa.sent[0].text, /isn't set up as an employee/);
  });

  test('no name → created anyway, identified by its number', async () => {
    // Phone is the identity; a lead shared as just a number is complete.
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming({
      text: 'New lead @919812345678\n9876543210'
    }));

    assert.equal(crm.calls.created.length, 1);
    assert.equal(crm.calls.created[0].full_name, '+919876543210',
      'the number stands in for the name the CRM requires');
    assert.equal(crm.calls.created[0].phone, '+919876543210');
    assert.equal(repo.leads.held().length, 0);
    assert.match(wa.sent[0].text, /Lead created/);
  });

  test('a name arriving later replaces the placeholder', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const msg = incoming({ text: 'New lead @919812345678\n9876543210' });
    await o.handle(msg);

    await o.handle(incoming({
      text: 'Name: Priya Sharma', mentions: [], quotedId: msg.id
    }));

    assert.deepEqual(crm.calls.updated.at(-1).fields, { full_name: 'Priya Sharma' });
  });
});

describe('duplicates (Q5)', () => {
  test('keeps the existing owner and records the message as a remark', async () => {
    makeGroup();
    const crm = fakeCrm({
      createThrows: new DuplicateLeadError({
        detail: 'A lead with phone +919876543210 already exists (Priya S).',
        error_code: 'duplicate_lead',
        existing_lead_id: 'existing-crm-id',
        existing_lead_name: 'Priya S'
      })
    });
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    // Reassigning someone else's lead silently would cause arguments.
    assert.equal(crm.calls.updated.length, 0, 'must not change assignment');
    assert.equal(crm.calls.remarks[0].id, 'existing-crm-id');
    assert.match(wa.sent[0].text, /Already in the CRM/);
    assert.equal(repo.leads.recent()[0].status, 'existing');
  });

  test('a duplicate on a FINISHED lead is held, not silently appended', async () => {
    // On a large lead base "lost" is common. A remark on a closed record is buried,
    // so a genuinely revived enquiry would vanish. Ask a human instead.
    makeGroup();
    const crm = fakeCrm({
      existingStage: 'lost',
      existingName: 'Priya S',
      createThrows: new DuplicateLeadError({
        detail: 'exists', error_code: 'duplicate_lead',
        existing_lead_id: 'closed-lead', existing_lead_name: 'Priya S'
      })
    });
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.equal(crm.calls.remarks.length, 0, 'must not append to a closed lead');
    assert.equal(repo.leads.held()[0].held_reason, 'revived_lost');
    assert.match(wa.sent[0].text, /closed lead/);
  });

  test('remarks carry the WhatsApp message id so a retry duplicate is traceable', async () => {
    // POST /remarks is not idempotent — a retry after a timeout appends a second
    // copy. The stamp makes that identifiable rather than mysterious.
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210\nvery keen'
    }));

    assert.ok(crm.calls.remarks[0].sourceId, 'remark must be stamped with its source');
  });
});

describe('replies that update a lead', () => {
  async function createParent(o) {
    const msg = incoming();
    await o.handle(msg);
    return msg.id;
  }

  test('a labelled reply sets the field and confirms it', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await createParent(o);

    await o.handle(incoming({
      text: 'University: Delhi University', mentions: [], quotedId: parentId
    }));

    assert.deepEqual(crm.calls.updated.at(-1).fields, { university: 'Delhi University' });
    assert.match(wa.sent.at(-1).text, /University → Delhi University/);
  });

  test('plain text becomes a remark, never a field', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const parentId = await createParent(o);

    await o.handle(incoming({
      text: 'she is very keen, needs 15 lakh', mentions: [], quotedId: parentId
    }));

    // Nothing infers that "15 lakh" means loan_amount — a wrong guess corrupts a
    // record silently.
    assert.equal(crm.calls.updated.length, 0);
    assert.match(crm.calls.remarks.at(-1).text, /very keen/);
  });

  test('an acknowledgement reaches nothing but is still recorded (R11.1)', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await createParent(o);

    const before = crm.calls.remarks.length;
    await o.handle(incoming({ text: 'ok', mentions: [], quotedId: parentId }));

    assert.equal(crm.calls.remarks.length, before, 'must not reach the CRM');
    assert.equal(wa.sent.length, 1, 'must not reply');
    assert.ok(repo.skipped.recent().some((s) => s.reason === 'noise_acknowledgement'),
      'but must be kept so the noise list can be corrected');
  });

  test('an unknown label is explained and saved as a note', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await createParent(o);

    await o.handle(incoming({
      text: 'Budget Range: 20L', mentions: [], quotedId: parentId
    }));

    assert.match(crm.calls.remarks.at(-1).text, /Budget Range: 20L/);
    assert.match(wa.sent.at(-1).text, /isn't a field I know/);
  });

  test('a reply to something that is not a lead is treated as a new message', async () => {
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'good morning', mentions: [], quotedId: 'UNKNOWN-MSG'
    }));

    assert.equal(crm.calls.created.length, 0);
    assert.equal(crm.calls.remarks.length, 0);
  });
});

describe('group and sending guards', () => {
  test('an inactive group is ignored entirely', async () => {
    makeGroup({ active: false });
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming());
    assert.equal(crm.calls.created.length, 0);
  });

  test('a bank group is recorded but not processed — Way 2 is not built', async () => {
    makeGroup({ purpose: 'bank' });
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming());

    assert.equal(crm.calls.created.length, 0);
    assert.ok(repo.skipped.recent().some((s) => s.reason === 'bank_group_not_implemented'));
  });

  test('sending off still captures the lead (S3/S4)', async () => {
    makeGroup({ send: false });
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    // A send problem must never cost a lead.
    assert.equal(crm.calls.created.length, 1);
    assert.equal(wa.sent.length, 0);
  });

  test('the kill switch silences replies but not capture (S4)', async () => {
    makeGroup();
    repo.settings.set('sending_paused', 'true');
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.equal(crm.calls.created.length, 1);
    assert.equal(wa.sent.length, 0);
  });
});

describe('CRM failures', () => {
  test('a failure leaves the lead pending for retry and warns once (S6)', async () => {
    makeGroup();
    const crm = fakeCrm({ createThrows: new Error('ECONNRESET') });
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    const stored = repo.leads.recent()[0];
    assert.equal(stored.status, 'pending', 'must stay retryable, never be dropped');
    assert.equal(stored.attempts, 1);
    assert.match(wa.sent[0].text, /Couldn't save this to the CRM/);
  });

  test('the lead survives in our database even when the CRM never answers', async () => {
    makeGroup();
    const crm = fakeCrm({ createThrows: new Error('down') });
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming());

    const stored = repo.leads.recent()[0];
    assert.equal(stored.name, 'Priya Sharma');
    assert.equal(stored.phone, '+919876543210');
    assert.equal(stored.raw_message.includes('Priya Sharma'), true);
  });
});

describe('duplicate reply shows where the lead stands', () => {
  test('reports stage, counsellor and detail from the existing lead', async () => {
    // The point is that nobody should have to open the CRM to find out whether a
    // lead is already being worked, and by whom.
    makeGroup();
    const crm = fakeCrm({
      existingStage: 'processing',
      createThrows: new DuplicateLeadError({
        detail: 'exists', error_code: 'duplicate_lead',
        existing_lead_id: 'existing-id', existing_lead_name: 'Jaanvi Dixit'
      })
    });
    crm.getLead = async () => ({
      id: 'existing-id', serial_no: 8871, full_name: 'Jaanvi Dixit',
      current_stage: 'processing', assigned_agent_id: 'agent-1',
      university: 'GLA University', loan_amount: '7 Lakh',
      created_at: '2026-03-12T10:00:00Z'
    });
    crm.users = new Map([['agent-1', { id: 'agent-1', full_name: 'Rudra Taneja' }]]);

    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    const text = wa.sent[0].text;
    assert.match(text, /#8871/, 'serial so it can be found');
    assert.match(text, /Stage: Processing/);
    assert.match(text, /Counsellor: Rudra Taneja/, 'resolved from the cached user list');
    assert.match(text, /University: GLA University/);
    assert.match(text, /Loan: 7 Lakh/);
  });

  test('empty fields are left out rather than shown blank', async () => {
    makeGroup();
    const crm = fakeCrm({
      createThrows: new DuplicateLeadError({
        detail: 'exists', error_code: 'duplicate_lead', existing_lead_id: 'e1'
      })
    });
    crm.getLead = async () => ({
      id: 'e1', serial_no: 12, full_name: 'Someone',
      current_stage: 'created', university: null, loan_amount: null
    });
    crm.users = new Map();

    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.doesNotMatch(wa.sent[0].text, /University:/);
    assert.doesNotMatch(wa.sent[0].text, /Loan:/);
    assert.match(wa.sent[0].text, /Stage: Created/);
  });
});

describe('gap recovery', () => {
  test('a watermark is recorded for every message, lead or not', async () => {
    // This is the point the phone is asked to replay from after a gap. It must be
    // set even for messages that are not leads, or a gap after a run of chatter
    // would replay from far too far back.
    makeGroup();
    const o = new Orchestrator({ crm: fakeCrm(), whatsapp: fakeWhatsApp() });

    await o.handle(incoming({ id: 'MSG-CHAT', text: 'good morning', mentions: [] }));

    const g = repo.groups.byWaId('120363999@g.us');
    assert.equal(g.last_message_id, 'MSG-CHAT');
    assert.ok(g.last_message_ts, 'timestamp must be stored for the replay request');
  });

  test('the watermark never moves backwards', async () => {
    // Replayed messages arrive out of order and are older than what we already
    // have; letting them rewind the watermark would replay the same window
    // forever.
    makeGroup();
    const o = new Orchestrator({ crm: fakeCrm(), whatsapp: fakeWhatsApp() });

    await o.handle(incoming({ id: 'NEW', text: 'hi', mentions: [], timestamp: 2000 }));
    await o.handle(incoming({ id: 'OLD', text: 'hi', mentions: [], timestamp: 1000 }));

    assert.equal(repo.groups.byWaId('120363999@g.us').last_message_id, 'NEW');
  });

  test('replaying a message already handled creates nothing', async () => {
    // What makes aggressive re-fetching safe.
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const msg = incoming();

    await o.handle(msg);
    await o.handle(msg);   // as if replayed from history

    assert.equal(crm.calls.created.length, 1);
  });
});
