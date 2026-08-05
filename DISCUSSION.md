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

### Topic: How to treat replies (Q8)

**Problem:** the rule "a reply updates the lead" breaks down because most replies in
a working group are not information. Of a realistic seven replies on one lead, three
carried data ("Delhi University", "she needs 15 lakh", "MBA course") and four were
conversation ("ok", "calling her now", "👍", "done"). Writing all seven into fields
would leave `College: ok` in the CRM.

Framing that decided it: **a missed lead is visible, corrupted data is not.** Nobody
notices a wrong value sitting in a field until it is used in front of a customer.

**Options put forward:** (A) labelled format only, (B) AI interprets free text,
(C) everything into Notes, (D) AI with human confirmation.

**Decision: A + C combined.** Labelled replies write to structured fields; every
other reply appends to Notes.

Why this is a good fit here: it is fully deterministic, costs nothing, cannot
corrupt a structured field, and loses no information. The cost is one habit for the
team — use `Field: value` when you want a real field set.

**Recorded as R9.** Also recorded as **R10**: this approach works because the
in-house group contains our own staff, whose message format we can mandate. Bank
groups contain people we do not control, so Way 2 cannot simply reuse R9.

### Topic: Identifying a lead message (R8)

A lead message always contains a phone number **and** an employee `@mention`. Both
present means new lead; anything else is not.

### Topic: Reply handling details (Q8a–Q8f) — all answered

| | Question | Decision |
|---|---|---|
| Q8a | Noise in Notes? | **No.** Filter "ok", "done", emoji-only. Never reaches CRM |
| Q8b | Label aliases? | **Yes.** `Clg` / `College` / `University` → College |
| Q8c | Accept `-` and `=` as separators? | **Yes** *(assumed, pending confirm)* |
| Q8d | Several fields in one reply? | **Yes.** Update all of them |
| Q8e | Unknown labels? | **Yes, to Notes.** Never dropped |
| Q8f | Overwriting a filled field? | **Yes, overwrite.** Old value preserved in Notes |

Recorded as **R11.1–R11.6**.

Two engineering notes attached to these answers:

**On Q8a — the filter must match the whole message, never a word inside one.**
"done" alone is noise; "documents done" is information. A substring match would
silently discard real updates, which is exactly the class of failure R9 was chosen
to avoid.

**Safeguard added:** filtered messages are still written to our own database even
though they never reach the CRM. The noise list is a guess about how people talk,
and it will be wrong somewhere. Keeping the raw record means it can be corrected
against real usage instead of argued about in the abstract.

**On Q8f — the CRM holds current truth, Notes holds history.** A field overwrite
appends the previous value and a timestamp to Notes, so nothing that was once
recorded is ever destroyed by a correction.

### Topic: CRM discovery report received

Report came back with file:line citations. Recorded in `docs/CRM-INTEGRATION.md`.

**Fits our design better than expected:** stage `created` is automatic on create,
`assigned_agent_id` is on the create schema so assignment is one call, `PUT` is a
genuine partial patch, and `POST /leads/{id}/remarks` is an append-only notes table.

**Two findings that would have caused silent damage:**

1. **`lead.notes` is destructive on write, and the AI voice pipeline appends to that
   same column.** Every "append to Notes" rule we wrote (R9, R11.1–R11.6) would have
   destroyed the voice pipeline's data — damage in another system, which nobody
   would have thought to check. Recorded as **C1**: Notes always means the remarks
   endpoint.

2. **`custom_fields` and `tags` are replace-not-merge on PUT**, so writing one key
   wipes the rest, including the `ai_last_call` block the voice pipeline stores
   there. Recorded as **C2**: never write these.

**Three blockers**, all raised with the CRM team:

- **B1 no machine credential** — only a ~1h user JWT. A service holding a human's
  password can't be revoked without locking out that person, and its writes look
  like theirs in the audit trail. Asked for a service account.
- **B2 no idempotency, and the duplicate error omits the lead ID** — so we can't
  turn "already exists" into "update that one" without an ambiguous substring
  search. Asked for the `id` in the error body as the cheap fix, with idempotency
  key or exact phone lookup as alternatives. Any one closes it.
- **B3 no staging** — a local run points at production Supabase. Proposed a
  **dedicated test tenant** instead, since the CRM is already multi-tenant. Far
  cheaper than their backlog item #14 and solves our actual problem.

**Also recorded:** C3 never patch phone (`normalize_phone` doesn't run on update),
C4 authenticate as a dedicated admin and always send `assigned_agent_id` explicitly
(a manager omitting it silently becomes the counsellor), C5 search is substring and
can return several rows — more than one result means human review, never a guess.

Stage values are 29, not the 23 their comment and ARCHITECTURE.md claim. Irrelevant
to us — we only ever use `created` — but noted.

**Still outstanding:** the Lead field list. Without exact field names and enum
values we cannot implement R11.2 (aliases) or R11.5 (unknown labels).

### Topic: Sending Prompt 2 before Way 2 is designed

Decided to send Prompt 2 now rather than wait. All four items — machine credential,
lead ID in the duplicate error, test tenant, field list — are needed regardless of
what Way 2 turns out to be, so holding them only delays work that has to happen.

Added one instruction before sending: **build the credential as a general mechanism,
not wired to specific endpoints.** Their existing `X-Internal-Secret` is attached to
exactly two endpoints, which is why it is useless to us — repeating that shape would
mean redoing the auth work when Way 2 lands. Also stated explicitly that the
credential should be unable to delete, now or later.

### Topic: CRM build delivered — B1 and B2 closed

**B1 machine credential — done.** `X-API-Key`, resolved in `get_current_user`, so it
works on every authenticated route and future routes inherit it. Deliberately not
the endpoint-scoped `X-Internal-Secret` shape we warned against. The key resolves to
a service-account *profile*, which is what makes attribution work — every audit
column is an FK to `profiles.id`, so our writes appear under "WhatsApp Ingest
Service". Cannot delete (global middleware, pre-routing), cannot manage keys.
Recorded as **C6**.

**B2 duplicate error — done.** Response now carries `existing_lead_id`,
`existing_lead_name`, `error_code`, `duplicate_field`, with `detail` left
byte-identical for the frontend. Fully closes the retry problem.

**B3 test tenant — partially.** It is a separate tenant, **not a separate
database** — it lives in FMC production Supabase, and isolation rests on
`company_id` scoping that has zero dedicated tests. Recorded as **C8**: good for
validating API shape, not a safety net. No bulk or destructive operations against
it; test leads must be identifiable as test data.

**New field facts:** `loan_amount_lakh` is write-only — absent from `LeadOut`, so
reads must use `loan_amount` (**C7**). Stage value for Created is `created`.

**Credentials were pasted into a chat channel.** Recommended rotation before the
integration goes live — their own report raised the same point.

**Not deployed.** Code is uncommitted in their working tree, but the migration was
applied to production, so `api_keys` exists in prod while the code does not. The key
will not authenticate against the live URL until they deploy. Additive-only, so the
split state is safe; we simply cannot integrate yet.

**Found on their side, affects us directly:** `update_lead` has neither phone
normalisation nor a duplicate check. A counsellor editing a phone in the CRM UI can
create two live leads for one person, silently defeating the dedup our entire
identity model rests on. The other path raises an uncaught IntegrityError → 500 with
internals leaked. Asked them to fix it — their estimate is two lines plus a test.
