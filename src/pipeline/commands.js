/**
 * Commands the bot answers in the group.
 *
 * The governing rule is the same one the noise filter uses: **the whole message
 * must be the command**. "my leads" is a command; "let me check my leads later"
 * is conversation, and answering it would make the bot an interruption rather
 * than a tool.
 *
 * Deliberately a short, closed list. Every command added is another chance to
 * misfire on something someone genuinely said.
 */

/** command name → the exact phrases that invoke it. */
const COMMANDS = {
  myLeads: [
    'my leads', 'my lead', 'myleads', 'my leads?', 'leads?', 'my list',
    'mere leads', 'my pending', 'my open leads'
  ],
  help: ['help', 'bot help', 'commands', 'what can you do']
};

/**
 * Identify a command.
 *
 * @param {string} text
 * @returns {{ name: string }|null}
 */
function parse(text) {
  if (!text) return null;

  const normalised = String(text)
    .trim()
    .toLowerCase()
    .replace(/[.!,;:]+$/g, '')
    .replace(/\s+/g, ' ');

  // A long message is conversation, whatever it contains.
  if (normalised.length > 24) return null;

  for (const [name, phrases] of Object.entries(COMMANDS)) {
    if (phrases.includes(normalised)) return { name };
  }

  return null;
}

/** What the bot can be asked. Kept short — it is read in a busy group. */
const HELP_TEXT = [
  'What I do:',
  '',
  '• Post a number and tag someone → I create the lead in the CRM',
  '• Post a number with no tag → I tell you who already has it',
  '• Reply to a lead → I add the details to it',
  '• Type "my leads" → I list yours',
  '',
  'For a field, write it plainly: University: Bharath Chennai'
].join('\n');

module.exports = { parse, COMMANDS, HELP_TEXT };
