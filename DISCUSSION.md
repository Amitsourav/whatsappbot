# Discussion Log

Chronological record of every design discussion. Nothing is implemented from here
until the discussion is complete and the owner says go.

Conclusions that become firm move into `PROJECT.md`. This file keeps the reasoning,
including options we rejected and why — so we never re-argue a settled point.

---

## Session 1 — 2026-08-05

### Topic: Read the existing codebase

Reviewed v1 in full. Findings:

- ~1,400 lines backend (CommonJS), 7-page React admin panel.
- Parser had been rewritten to extract `status`/`remark`, but the test suite still
  asserted an `email` field. 9 of 11 tests failing. Email was dead weight in the
  schema, the CRM payload, and `insertLead` (always `undefined`).
- Local database held only dev leftovers: groups "Check" and "rahulll", both with
  no bank column mapped, 29 test leads from March. Real config lives on the VM.
- `ADMIN_PASS` was still the shipped default `changeme123`.
- No git repository.

### Topic: How does a bot get into a WhatsApp group?

**Question:** Can we add a bot to a WhatsApp group?

**Answer: no — WhatsApp has no concept of a bot member.** A group contains phone
numbers and nothing else. There is no bot directory, no invite-an-app flow, no
equivalent of Slack or Telegram bots. Meta has never exposed this.

A "bot" is therefore always the same thing:

> a real phone number that is a member of the group, with software driving it.

The software links to that number as a **linked device** (Settings → Linked
Devices), exactly like using WhatsApp on a laptop. It then receives every message
that number receives. Nothing is "added" to the group except a phone number.

**Rejected alternative: the official Meta WhatsApp Cloud API.** It cannot read
group messages at all — group access is not exposed to any developer, at any tier.
It only covers 1-to-1 conversations initiated with a business number. This rules it
out entirely and locks us into `whatsapp-web.js`. This is a platform limitation,
not a shortcut we chose.

### Topic: Which number should drive the bot?

| | Own number | Dedicated second number |
|---|---|---|
| Already in bank groups | yes | must be added, group by group |
| Personal WhatsApp isolated from server | no | yes |
| Sees group history | already has it | only from joining onward |
| Cost | none | SIM + a spare phone kept online |

The deciding factor: bank-run groups are administered by the bank's representative,
who generally will not add an extra number on request. For groups the owner runs
himself, a second number is easy.

**Status: open.** Owner is currently setting up a number on a phone.

Setup checklist given for the new number: register with OTP on a real phone; set a
recognisable profile name and photo (an anonymous number gets removed from bank
groups); disable default disappearing messages; keep the phone charged and online;
never use the number for broadcasts or messaging strangers (new numbers doing bulk
activity get banned); keep the SIM active so it is not recycled.

### Topic: How long does the QR scan last?

**Once, then effectively forever** — with one condition.

- The session is written to `.wwebjs_auth/` and reused on every restart. Restarting
  PM2, rebooting the VM, redeploying: no rescan, as long as that folder survives.
- WhatsApp logs out linked devices if the **primary phone** stays offline for about
  14 days. The server being offline does not matter; the phone does.
- Other things that force a rescan: the folder is deleted, the device is logged out
  from the phone, or a WhatsApp Web change breaks the library.

**Consequence recorded as a project risk:** `.wwebjs_auth/` is the most fragile
thing in the system. A deploy that replaces the project folder destroys the login
and requires physical access to the phone to recover. v1's own setup guide advised
deleting this folder as routine troubleshooting — that advice was wrong.

### Topic: Scrap v1 and rebuild

**Decision: full rebuild.** v1's code had drifted from what it actually did, and
patching it was judged slower than rebuilding cleanly.

Sequence: v1 was first archived to `_scrap-v1/` (473 MB, reduced to 153 MB by
dropping `node_modules` and the browser cache), verified that `.env`,
`google-credentials.json`, `data/bot.db` and `.wwebjs_auth/` survived the move —
then permanently deleted on the owner's instruction.

Unaffected by the deletion: the Google Sheet and all real lead data (lives in
Google's cloud), and the VM at `34.131.106.13`, which still runs v1 and still holds
its own copy of the credentials and session.

To re-gather for v2: Sheet ID (from the sheet URL), `google-credentials.json` (copy
from the VM or regenerate and re-share the sheet), group→bank mappings, and a fresh
QR scan.

### Topic: Foundation code

Written and committed before the design discussion was complete — **noted as a
process correction: no further implementation until the discussion concludes.**

What exists: `config.js` (validated, refuses default passwords), `logger.js`,
database migration runner and schema 001, `CLAUDE.md`, `PROJECT.md`. No parser, no
WhatsApp connection, no sheet code. All of it is decision-independent plumbing.

---

## Session 2 — 2026-08-05 (design discussion)

Discussion in progress. Topics to cover:

1. What real messages actually look like — the input that decides the parser
2. Parsing approach: AI, rules, or hybrid
3. Volume and cost
4. What the sheet should do in edge cases (conflicting statuses, name mismatches,
   one message containing several leads)
5. Which admin panel screens are genuinely used
6. CRM: in or out
7. Deployment and cutover from the running v1

*(Notes appended as we go.)*
