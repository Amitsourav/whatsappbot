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
  const calls = { created: [], updated: [], remarks: [] };
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
    async addRemark(id, text) {
      calls.remarks.push({ id, text });
      return { id: 'remark-1' };
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
  test('no mention → held and the group is asked to tag someone (Q6)', async () => {
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

  test('no name → held rather than filed under a guess', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming({
      text: 'New lead @919812345678\n9876543210'
    }));

    assert.equal(crm.calls.created.length, 0);
    assert.equal(repo.leads.held()[0].held_reason, 'no_name');
    assert.match(wa.sent[0].text, /couldn't find the student's name/);
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
    assert.match(wa.sent[0].text, /Lead already exists/);
    assert.equal(repo.leads.recent()[0].status, 'existing');
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
