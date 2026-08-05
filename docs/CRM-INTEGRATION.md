# CRM integration — confirmed facts and derived rules

Source: discovery report from the CRM codebase, 2026-08-05, with file:line citations.
Update this document whenever the CRM changes.

---

## Confirmed API behaviour

| Area | Reality |
|---|---|
| Create lead | Lands at stage `created` automatically. Stage cannot be set on create — and does not need to be, per R5 |
| Assignment | `assigned_agent_id` is on the create schema → assign in the same call, no second request |
| Update | `PUT /leads/{id}` uses `exclude_unset=True` — a genuine partial patch despite the verb |
| Notes | `POST /leads/{id}/remarks` — separate append-only table, validated 1–5000 chars |
| Phone dedup | Enforced at two layers, scoped per tenant |
| Stages | 29 values (not 23 as the code comment and ARCHITECTURE.md claim). We only ever use `created` |
| Tenancy | Multi-tenant — dedup and scoping are per tenant |

---

## Derived rules — these override earlier assumptions

**C1 — Notes means `POST /leads/{id}/remarks`. Never `lead.notes`.**

`lead.notes` is **destructive on write**, and the AI post-call pipeline appends to
that same column. Writing our WhatsApp notes there would silently destroy the voice
pipeline's data — damage outside this project, in a system nobody would think to
check.

R9 and R11.1–R11.6 all say "append to Notes". Every one of them means the
**remarks endpoint**. This is the single most important line in this document.

**C2 — Never write `custom_fields` or `tags` on update.**

Both are replace-not-merge on PUT (a plain `setattr` loop). Patching `custom_fields`
wipes every other key in it, including the `ai_last_call` block the voice pipeline
writes. If we ever genuinely need to write there, it must be read-modify-write —
but the default is: do not touch these.

**C3 — The bot never patches `phone`.**

`normalize_phone` runs on create but **not** on update, so patching a phone bypasses
normalisation and would leave an unnormalised value in the identity field. Phone is
the lead's identity; it is set once at create and never modified by us.

**C4 — Authenticate as a dedicated admin account, and always send
`assigned_agent_id`.**

There is an auto-own rule: if the caller is a manager and `assigned_agent_id` is
omitted, that manager silently becomes the counsellor. Two consequences:

- Use an **admin** account, not a manager account
- **Always** send `assigned_agent_id` explicitly, never rely on a default

Admin scope is also required for search, which is silently scoped down for
non-admin roles — as a non-admin we would get partial results with no error.

**C5 — Search is substring, not exact. Treat multiple results as ambiguous.**

Only `GET /leads/search?q=` exists — substring ILIKE. A full phone number is a
reasonably safe query, but the endpoint can still return several rows. Rule: if a
phone search returns more than one lead, do not guess — hold it for human review.

---

## Additional derived rules

**C6 — Authenticate with `X-API-Key`. The key resolves to a service-account
profile.**

Resolved inside `get_current_user`, so it works on every authenticated route and
routes added later inherit it — nothing to wire for Way 2. Scope follows the
profile's role; ours is admin, which gives the unscoped search C5 requires.

Attribution is automatic: `leads.created_by`, `lead_remarks.author_id` and
`lead_stage_logs.changed_by` are all FKs to `profiles.id`, so our writes are
identifiable as the integration's rather than a person's. Verified live — a test
remark came back authored by "WhatsApp Ingest Service".

The key **cannot delete**: `ApiKeyDeleteGuardMiddleware` rejects any DELETE carrying
the header before routing, before auth, before any DB work. Global, so future DELETE
routes are covered automatically. It also cannot mint or manage keys.

**C7 — Read `loan_amount`, never `loan_amount_lakh`.**

`loan_amount_lakh` is write-only: it stores correctly but is absent from `LeadOut`,
so it never comes back in a response. Reading it would always yield nothing.

**C8 — The test tenant is a sandbox for API shape, not a safety net.**

It is a separate *tenant*, not a separate database — it lives inside the FMC
production Supabase project. Isolation rests entirely on `company_id` scoping, which
is applied consistently but has **zero dedicated tests** (their backlog item #7).

Consequences for how we test:
- Fine for validating request/response shape and integration logic
- **Not** protection against a bug in tenant scoping itself
- Never run bulk or destructive operations against it
- Every test lead we create should be obviously identifiable as test data

Real staging remains their backlog item #14.

---

## Blocker status

**B1 — machine credential: RESOLVED**, pending deploy. See C6.

**B2 — duplicate error: RESOLVED.** The 400 body now carries `existing_lead_id`,
`existing_lead_name`, `error_code` and `duplicate_field`. `detail` was deliberately
left byte-identical for the frontend. This is exactly the cheap fix we asked for and
it fully closes the retry problem: "already exists" now converts to "update that
lead" in one hop, with no ambiguous search.

```json
{
  "detail": "A lead with phone +919812345678 already exists (Rohit Verma).",
  "error_code": "duplicate_lead",
  "duplicate_field": "phone",
  "existing_lead_id": "c964c6c3-3df1-4774-b596-35e6965e25d6",
  "existing_lead_name": "Rohit Verma"
}
```

**B3 — staging: PARTIALLY RESOLVED.** Test tenant exists; see C8 for its limits.

---

## Open risks on the CRM side

**Not deployed.** The code is in their working tree, uncommitted. The migration
`g7b8c9d0e1f2` (additive `CREATE TABLE api_keys`) *was* applied to the FMC
production database, so the table exists in production while the code does not.
**The API key will not authenticate against the live URL until they deploy.**
Additive-only, so the split state is safe — but we cannot integrate until deploy.

**Phone normalisation and dedup are missing on update.** `normalize_phone` runs only
on create; `update_lead` is a plain `setattr` loop with no normalisation and no
duplicate check. Both failure paths are reachable from the existing CRM edit form:

- Editing a phone to `07004428198` when `+917004428198` exists stores it raw. No
  index collision, because the strings differ — **two live leads for the same
  person, and the dedup we rely on is silently defeated.**
- Editing it to an exact existing match raises an uncaught `IntegrityError` → 500,
  leaking `error_type`/`error_message` through the generic handler.

This matters to us directly: our entire identity model assumes one lead per phone.
A counsellor editing a phone in the UI can break that assumption without anyone
noticing. **Asked them to fix it** — two lines plus a test, per their estimate.

**401 replaces 403 for absent credentials.** Correct behaviour, but if anything in
CRM-UI branches on "403 means no token", it needs checking.

---

## Superseded blockers

### B1 — No machine credential *(blocking)*

Every lead endpoint requires a Supabase **user** JWT expiring in about an hour.
There is no API key, no service account, no client-credentials flow.
`X-Internal-Secret` exists but is wired to two endpoints, and the website one only
writes a review-queue row — it cannot create a lead, set a stage, or assign anyone.

*Our position:* a 24/7 service holding a human's password is the wrong shape — it
cannot be revoked without locking out a person, and its writes are indistinguishable
from that person's in any audit trail.

**Ask:** a service account with admin scope and a non-expiring, revocable
credential.

**Interim if that's slow:** a dedicated admin user created solely for this
integration — never used by a human — whose refresh token we rotate. Ugly but
workable, and it at least keeps the audit trail clean.

### B2 — No idempotency, and the duplicate error omits the lead ID *(blocking)*

If the network drops after the CRM commits but before we get the response, we retry:

- Lead has **neither phone nor email** → duplicate created
- Lead has **one of them** → `400 already exists`, but **the error body does not
  include the existing lead's `id`**

That second case is the real problem. We cannot pivot from "already exists" to
"update that lead" in one hop, because we are not told which lead it is. We would
have to fall back to substring search — which is ambiguous per C5.

**Ask, in order of preference:**

1. **Include the existing lead's `id` in the duplicate error body.** Cheapest
   possible fix, and it fully resolves this for us.
2. An `Idempotency-Key` header on create.
3. `GET /leads/by-phone?phone=` — exact lookup, not substring.

Any one of these closes it. The first is a few lines.

*Our own mitigation regardless:* record the outbound attempt locally **before**
calling the CRM, so a crash mid-request is recoverable and never silently retried
into a duplicate.

### B3 — No staging, no local database *(blocking for safe development)*

A single `supabase_db_url`, no docker-compose, no SQLite fallback — running locally
points at real Supabase. Both Railway deployments are production. Staging is item
#14 on the CRM's own backlog.

*We will be creating dozens of throwaway leads while building this.* Those must not
land in live data your team is working.

**Ask:** since the CRM is already multi-tenant with per-tenant scoping, **a
dedicated test tenant** would give us isolation without waiting for real staging.
Far cheaper than backlog item #14 and solves our actual problem.

---

## Field mapping — still outstanding

The report covers the API's shape. We still need the **Lead field list** — exact
names, types, and the allowed values for every enum — to implement R11.2 (label
aliases) and R11.5 (unknown labels to remarks). Without it we cannot decide which
labels map to which fields.
