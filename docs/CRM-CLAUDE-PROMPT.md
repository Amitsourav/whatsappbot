# Prompts for the CRM codebase's Claude Code

Two stages. **Send Prompt 1 first.** Only send Prompt 2 once we've read the answers
and know what's actually missing.

---

## Prompt 1 — Discovery (send this now)

> We are building a service that will create and update leads in this CRM
> automatically. It reads messages from a WhatsApp group, extracts the lead, and
> writes it here — assigned to a specific employee, at the "Created" stage. Later,
> when people reply in WhatsApp with more details, it updates that same lead's
> fields.
>
> **Do not write or change any code for this task.** Read the codebase and produce a
> report. I need to know what already exists before deciding what to build.
>
> Where something does not exist, say so plainly. Do not describe what could be
> built or what would be typical — I need the current reality, and a confident
> guess is worse than "this is missing".
>
> Please produce a markdown document covering:
>
> **1. Stack and API surface**
> - Language, framework, database
> - Is there an HTTP API? Base URL in dev and in production
> - How routes are organised, and where in the repo they live
>
> **2. The Lead model**
> - Every field: exact name as the API expects it, type, required or optional
> - For any dropdown / enum / fixed-choice field, list the exact allowed values
> - Which fields are computed or system-managed and should not be written directly
> - Any validation rules (formats, lengths, uniqueness constraints)
>
> **3. The User / employee model**
> - Fields, and specifically how a user is identified — internal ID, email, or both
> - Is there an endpoint that lists users? If so, its path and response shape
>
> **4. Existing lead endpoints**
> For each of create, read, update, search — if it exists:
> - Method and path
> - Request body, with a real example
> - Response body, with a real example
> - Error responses and status codes
>
> Be explicit about which of these do **not** exist today.
>
> **5. Authentication**
> - How the API authenticates. Is there a way to issue a long-lived credential for a
>   machine client (not a human login)?
>
> **6. Stages**
> - The field name that holds the stage
> - Every possible value
> - The exact value that means "Created"
>
> **7. Assignment**
> - How a lead is linked to the employee who owns it — field name and what
>   identifier it takes
> - Can assignment be set in the same request that creates the lead, or does it
>   need a second call?
>
> **8. Duplicates**
> - Is phone number unique on a lead? What happens if we create a lead with a phone
>   that already exists — rejected, allowed, merged?
> - Is there a way to look up a lead by phone number?
>
> **9. Notes / comments**
> - Is there a notes or comments field on a lead, or a separate related table?
> - Is it append-only, or does writing replace what was there?
> - If it's a related table, what does creating an entry look like?
>
> **10. Operational details**
> - Rate limits
> - Is there a staging environment, or can the CRM be run locally? We will be
>   creating throwaway test leads and would rather not put them in production data.
> - Does create support an idempotency key? (If we retry after a network timeout, we
>   must not create the lead twice.)
>
> **11. Gaps**
> Given what we're trying to do — create a lead assigned to a user at a fixed stage,
> then patch individual fields on it later, and append notes — list what is missing
> or would need changing. Do not build any of it yet.

---

## Prompt 2 — Build (ready to send)

*Written against the discovery report of 2026-08-05.*

> Thanks — that report was exactly what we needed, and the `lead.notes` warning
> saved us from corrupting the voice pipeline's data. We'll use
> `POST /leads/{id}/remarks` throughout and leave `lead.notes` alone.
>
> Please implement the following, in this order, and nothing beyond it.
>
> **1. A machine credential (highest priority — blocks everything)**
>
> We need a service account with admin scope and a long-lived, revocable
> credential. A 24/7 integration cannot hold a human's password: it can't be
> revoked without locking out that person, and its writes would be
> indistinguishable from theirs in any audit trail.
>
> Whatever shape fits your codebase — a real API key, or extending
> `X-Internal-Secret` to the lead endpoints with proper scoping. Requirements:
> - Admin-equivalent scope (we need unscoped search — see item 3)
> - Revocable independently of any human account
> - Its writes identifiable as the integration's in any audit trail
>
> If this will take a while, tell us and we'll run on a dedicated admin user with
> token rotation in the meantime — but we'd like the real thing.
>
> **Please build the credential as a general mechanism, not wired to specific
> endpoints.** This is a first phase; a second WhatsApp capture path is being
> designed now and will likely need more of the API. We'd rather you build auth
> that works across the lead endpoints generally than have to revisit it. Note that
> `X-Internal-Secret` is currently attached to exactly two endpoints — that's the
> shape we're trying to avoid repeating.
>
> One thing we do **not** want, now or later: **delete**. The integration never
> deletes anything, and we'd like the credential to be unable to.
>
> **2. Return the existing lead's ID in the duplicate error**
>
> The smallest change with the biggest effect for us. Today a duplicate create
> returns `400 already exists` with no `id` in the body, so we can't pivot to
> updating that lead — we'd have to fall back to substring search, which is
> ambiguous.
>
> Please include the existing lead's `id` in the duplicate error response.
>
> If you'd rather solve it more thoroughly, either of these also works and we'd
> take it gladly:
> - An `Idempotency-Key` header on create
> - `GET /leads/by-phone?phone=` — exact match, not substring
>
> Any one of the three closes it. We only need one.
>
> **3. A test tenant**
>
> We'll create dozens of throwaway leads while building, and they must not land in
> live data. Since the CRM is already multi-tenant with per-tenant scoping, a
> dedicated test tenant would isolate us without waiting for real staging
> (backlog #14). Please create one and send us its credentials.
>
> **4. The Lead field list**
>
> Not code — just the reference. Every field on a lead: exact API name, type,
> required or optional, and for every enum the complete set of allowed values.
> We're mapping WhatsApp text onto these fields and need the exact strings the API
> accepts.
>
> **Please do not:**
> - Add any delete endpoint — this integration never deletes anything
> - Change `custom_fields` or `tags` semantics on our account. We know they're
>   replace-not-merge and we simply won't write to them
> - Change `lead.notes`. We're staying away from it entirely
>
> **One question:** `normalize_phone` runs on create but not on update. We don't
> intend to ever patch a phone number, so this doesn't affect us — but it looks
> like a latent bug for any other caller that does. Worth a look independently.
