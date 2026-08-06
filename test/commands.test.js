const { test, describe } = require('node:test');
const assert = require('node:assert');
const commands = require('../src/pipeline/commands');

describe('command detection', () => {
  test('recognises the command on its own', () => {
    for (const text of ['my leads', 'My Leads', 'MY LEADS.', 'myleads',
                        'my list', 'my open leads', 'mere leads']) {
      assert.equal(commands.parse(text)?.name, 'myLeads', `missed "${text}"`);
    }
  });

  test('recognises help', () => {
    for (const text of ['help', 'Help', 'commands', 'bot help']) {
      assert.equal(commands.parse(text)?.name, 'help', `missed "${text}"`);
    }
  });

  test('NEVER fires inside ordinary conversation', () => {
    // The property that matters. A bot that answers when someone happens to say
    // "help" is an interruption, not a tool — and this group is where the team
    // actually works.
    const CONVERSATION = [
      'let me check my leads later',
      'send me my leads for today please',
      'help him with the file',
      'I need help',
      'can you help me',
      'my leads are pending with bank',
      'sharing my leads now',
      'he needs help with documents',
      'my leads list is long'
    ];
    for (const text of CONVERSATION) {
      assert.equal(commands.parse(text), null, `misfired on "${text}"`);
    }
  });

  test('a long message is conversation whatever it contains', () => {
    assert.equal(commands.parse('my leads ' + 'x'.repeat(40)), null);
  });

  test('empty input is not a command', () => {
    assert.equal(commands.parse(''), null);
    assert.equal(commands.parse(null), null);
  });
});
