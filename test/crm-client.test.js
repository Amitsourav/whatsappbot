const { test, describe } = require('node:test');
const assert = require('node:assert');
const { CrmClient, CrmError, DuplicateLeadError } = require('../src/crm/client');

/**
 * Build a client backed by a scripted fetch, so we can assert on exactly what
 * would go over the wire without touching the real CRM.
 */
function mockClient(handler) {
  const calls = [];
  const client = new CrmClient({
    baseUrl: 'https://crm.test/api/v1',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined
      });
      const result = await handler(calls.length, calls[calls.length - 1]);
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        text: async () => (result.body === undefined ? '' : JSON.stringify(result.body))
      };
    }
  });
  return { client, calls };
}

const okLead = (over = {}) => ({
  status: 201,
  body: { id: 'lead-uuid-1', full_name: 'Priya Sharma', current_stage: 'created', ...over }
});

describe('sanitise — payload guards', () => {
  test('drops fields the CRM would silently ignore (C10)', () => {
    const { client } = mockClient(() => okLead());
    const { payload, dropped } = client.sanitise(
      { full_name: 'A', not_a_real_field: 'x' }, 'create'
    );
    assert.deepEqual(payload, { full_name: 'A' });
    assert.equal(dropped[0].field, 'not_a_real_field');
  });

  test('never writes protected fields', () => {
    const { client } = mockClient(() => okLead());
    const { payload } = client.sanitise(
      { full_name: 'A', notes: 'x', tags: ['y'], custom_fields: { z: 1 } }, 'update'
    );
    // notes would destroy the AI call pipeline's history (C1); tags and
    // custom_fields are replace-not-merge (C2).
    assert.deepEqual(payload, { full_name: 'A' });
  });

  test('truncates over-length values (C12)', () => {
    const { client } = mockClient(() => okLead());
    const { payload } = client.sanitise({ loan_amount: '9'.repeat(80) }, 'update');
    assert.equal(payload.loan_amount.length, 50);
  });

  test('update-only fields are flagged on create, not accepted (C11)', () => {
    const { client } = mockClient(() => okLead());
    const { payload, dropped } = client.sanitise(
      { full_name: 'A', loan_amount: '15 lakh' }, 'create'
    );
    assert.deepEqual(payload, { full_name: 'A' });
    assert.equal(dropped.find((d) => d.field === 'loan_amount').reason, 'update_only');
  });
});

describe('createLead', () => {
  test('sends the API key header and returns the lead', async () => {
    const { client, calls } = mockClient(() => okLead());
    const { lead } = await client.createLead({ full_name: 'Priya Sharma' });

    assert.equal(lead.id, 'lead-uuid-1');
    assert.equal(calls[0].headers['X-API-Key'], 'test-key');
    assert.equal(calls[0].method, 'POST');
  });

  test('keeps update-only values as deferred instead of losing them (C11)', async () => {
    const { client, calls } = mockClient(() => okLead());
    const { deferred } = await client.createLead({
      full_name: 'Priya Sharma',
      loan_amount: '15 lakh'
    });

    assert.equal(calls[0].body.loan_amount, undefined, 'must not be sent to create');
    assert.deepEqual(deferred, { loan_amount: '15 lakh' }, 'must be kept for the patch');
  });

  test('a duplicate surfaces the existing lead id (B2)', async () => {
    const { client } = mockClient(() => ({
      status: 400,
      body: {
        detail: 'A lead with phone +919812345678 already exists (Rohit Verma).',
        error_code: 'duplicate_lead',
        duplicate_field: 'phone',
        existing_lead_id: 'existing-uuid',
        existing_lead_name: 'Rohit Verma'
      }
    }));

    await assert.rejects(
      () => client.createLead({ full_name: 'Priya', phone: '+919812345678' }),
      (err) => {
        assert.ok(err instanceof DuplicateLeadError);
        assert.equal(err.existingLeadId, 'existing-uuid');
        assert.equal(err.duplicateField, 'phone');
        return true;
      }
    );
  });

  test('a create that returns no id is treated as failure', async () => {
    // Without an id we cannot link the WhatsApp thread to the record.
    const { client } = mockClient(() => ({ status: 201, body: { full_name: 'A' } }));
    await assert.rejects(() => client.createLead({ full_name: 'A' }), /returned no id/);
  });

  test('rejects an unknown assigned_agent_id before sending (C13)', async () => {
    const { client, calls } = mockClient(() => okLead());
    client.users = new Map([['known-uuid', { id: 'known-uuid' }]]);

    await assert.rejects(
      () => client.createLead({ full_name: 'A', assigned_agent_id: 'ghost-uuid' }),
      /Unknown assigned_agent_id/
    );
    assert.equal(calls.length, 0, 'must not reach the network');
  });
});

describe('retry behaviour', () => {
  test('retries 5xx and eventually succeeds', async () => {
    const { client, calls } = mockClient((n) =>
      n < 3 ? { status: 503, body: { detail: 'unavailable' } } : okLead()
    );
    const { lead } = await client.createLead({ full_name: 'A' });
    assert.equal(lead.id, 'lead-uuid-1');
    assert.equal(calls.length, 3);
  });

  test('does not retry a 4xx', async () => {
    const { client, calls } = mockClient(() => ({ status: 422, body: { detail: 'bad' } }));
    await assert.rejects(() => client.createLead({ full_name: 'A' }));
    assert.equal(calls.length, 1, 'a 422 means the request was wrong — retrying cannot help');
  });

  test('retries network failures', async () => {
    let n = 0;
    const client = new CrmClient({
      baseUrl: 'https://crm.test/api/v1',
      apiKey: 'k',
      fetchImpl: async () => {
        if (++n < 3) throw new Error('ECONNRESET');
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'x' }) };
      }
    });
    const { lead } = await client.createLead({ full_name: 'A' });
    assert.equal(lead.id, 'x');
    assert.equal(n, 3);
  });
});

describe('remarks and safety', () => {
  test('addRemark posts to the remarks endpoint, never lead.notes (C1)', async () => {
    const { client, calls } = mockClient(() => ({ status: 201, body: { id: 'r1' } }));
    await client.addRemark('lead-1', 'University changed to DU');

    assert.equal(calls[0].url, 'https://crm.test/api/v1/leads/lead-1/remarks');
    assert.equal(calls[0].body.body, 'University changed to DU');
  });

  test('remark text is truncated to the CRM limit', async () => {
    const { client, calls } = mockClient(() => ({ status: 201, body: { id: 'r1' } }));
    await client.addRemark('lead-1', 'x'.repeat(6000));
    assert.equal(calls[0].body.body.length, 5000);
  });

  test('DELETE is refused by our own client', async () => {
    const { client, calls } = mockClient(() => ({ status: 200 }));
    await assert.rejects(() => client.request('DELETE', '/leads/x'), /never issues DELETE/);
    assert.equal(calls.length, 0, 'must not rely on the CRM middleware to stop us');
  });

  test('empty update makes no request', async () => {
    const { client, calls } = mockClient(() => ({ status: 200, body: {} }));
    const { lead } = await client.updateLead('lead-1', { notes: 'blocked' });
    assert.equal(lead, null);
    assert.equal(calls.length, 0);
  });
});

describe('phone is create-only (C3) — regression', () => {
  test('phone IS sent on create', async () => {
    // Caught live: phone had been in a blanket never-write set, so it was stripped
    // from create too. The lead stored with no phone, and dedup silently stopped
    // working — the guarantee the whole identity model rests on.
    const { client, calls } = mockClient(() => okLead());
    await client.createLead({ full_name: 'A', phone: '+919876543210' });
    assert.equal(calls[0].body.phone, '+919876543210');
  });

  test('phone is NOT sent on update', async () => {
    const { client, calls } = mockClient(() => ({ status: 200, body: { id: 'x' } }));
    const { dropped } = await client.updateLead('lead-1', {
      phone: '+919999999999',
      university: 'JNU'
    });
    assert.equal(calls[0].body.phone, undefined);
    assert.equal(calls[0].body.university, 'JNU');
    assert.ok(dropped.some((d) => d.field === 'phone' && d.reason === 'update_forbidden'));
  });
});

describe('remark bodies carry no bookkeeping', () => {
  test('the message id is a field, not text in the note', async () => {
    // It used to be appended as "[wa:…]", which put machine bookkeeping into
    // text counsellors read all day.
    const { client, calls } = mockClient(() => ({ status: 201, body: { id: 'r1' } }));
    await client.addRemark('lead-1', 'University changed to DU', 'WAMSG123');

    assert.equal(calls[0].body.body, 'University changed to DU');
    assert.doesNotMatch(calls[0].body.body, /\[wa:/);
    assert.equal(calls[0].body.wa_message_id, 'WAMSG123');
  });

  test('no message id means no stray key', async () => {
    const { client, calls } = mockClient(() => ({ status: 201, body: { id: 'r1' } }));
    await client.addRemark('lead-1', 'plain note');

    assert.equal(calls[0].body.body, 'plain note');
    assert.equal(calls[0].body.wa_message_id, undefined);
  });

  test('a long note loses its tail, not its identifier', async () => {
    // Truncation used to run after stamping, so the longest notes — the ones most
    // worth tracing — were exactly the ones that lost the stamp.
    const { client, calls } = mockClient(() => ({ status: 201, body: { id: 'r1' } }));
    await client.addRemark('lead-1', 'x'.repeat(6000), 'WAMSG123');

    assert.equal(calls[0].body.body.length, 5000);
    assert.equal(calls[0].body.wa_message_id, 'WAMSG123');
  });
});
