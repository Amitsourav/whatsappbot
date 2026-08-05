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

## The three blockers

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
