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

## Prompt 2 — Build (send only after reading the report)

*Draft. Fill in the gaps identified by Prompt 1 before sending.*

> Based on your report, please implement the following, and nothing beyond it:
>
> *(list the specific missing endpoints here)*
>
> Requirements that apply to all of it:
> - **Create-lead must return the new lead's ID in the response.** The WhatsApp
>   service stores that ID to link the conversation to the record. Without it,
>   follow-up updates are impossible.
> - **Update must accept a partial payload** — only the fields that changed.
> - **Machine authentication**, separate from human login, and revocable.
> - **A dedicated API user or role** for the integration, so its writes are
>   distinguishable from a person's in any audit trail.
> - Validation errors must say which field failed and why.
> - Do not add delete endpoints. The integration never deletes anything.
>
> Please also write a short integration document: endpoint, example request,
> example response, for each thing you build.
