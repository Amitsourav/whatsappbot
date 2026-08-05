# Requirements

What the bot must do. Written before implementation, one capture path at a time.

Leads arrive by **two paths**:

1. **In-house group** → creates and updates leads in the in-house CRM *(documented below)*
2. **Bank groups** → *(not yet discussed)*

---

# Way 1 — In-house group → CRM

## Who is in the group

All employees, plus admins.

## The flow today (manual)

1. Admin posts a lead in the in-house group and `@mentions` the employee it belongs to.
2. That employee reads it and types the lead into the CRM by hand.
3. Further details discussed in the group are typed into the CRM by hand as well.

## The flow we are building (automatic)

```
Admin posts lead in in-house group, @mentioning an employee
        │
        ▼
Bot reads the message
        │
        ├── extracts the lead details
        └── reads the @mention → the mentioned person's phone number
                │
                ▼
        Look up phone number in the employee map → CRM user (name + email)
                │
                ▼
        Create lead in CRM
          • assigned to that employee
          • stage = "Created"
                │
                ▼
        Remember: this WhatsApp message  ←→  this CRM lead
                                │
                                ▼
    Later, anyone replies to that message with more detail
    (e.g. a college name)
                                │
                                ▼
        Bot finds the linked CRM lead and updates the
        relevant field with the new information
```

## Confirmed rules

**R1 — Mentions are always real `@mentions`.**
Admins select the person from WhatsApp's mention list; they do not type names as
plain text. This matters technically: a real mention carries the mentioned person's
**phone number as structured data** on the message, so assignment is exact rather
than guessed. No name matching, no ambiguity between two people called Rahul.

*Implication:* if someone types a name instead of mentioning, the bot cannot
reliably determine the assignee. Decide the fallback — see Q6.

**R2 — Employees are mapped phone number → CRM user, and this mapping comes first.**
Built and maintained before anything else works. A message mentioning an unmapped
number cannot be assigned.

**R3 — The CRM is in-house.**
We control it, so if an API endpoint is missing it can be added rather than
worked around.

**R4 — Employees are identified in the CRM by name and email.**
So the employee map is: `WhatsApp phone number → { name, email }`.

**R5 — The bot only ever creates leads at stage "Created".**
It never advances a lead to a later stage. What happens after Created is a human
process and out of scope. *(Owner: later stages not needed for now.)*

**R6 — Replies update fields on the existing lead.**
When new information arrives as a reply, the bot writes it to the appropriate
field on the already-created lead. It does not create a second lead.

**R7 — The link between a WhatsApp message and a CRM lead must persist.**
Stored locally, keyed on the WhatsApp message ID, so a reply arriving days later
still finds the right lead.

## Open questions — Way 1

**Q1 — What are the CRM's lead fields?**
Needed for R6. "Update the right column" requires knowing the columns. A list of
field names and their types would unblock this. Which of them can the bot write?

**Q2 — How does the bot talk to the CRM?**
Is there an API today? If so: base URL, auth method, and the endpoints for
create-lead and update-lead. If not, one needs building — it is in-house, so this
is a decision, not an obstacle.

**Q3 — What does a lead message actually contain?**
Name and phone at minimum, presumably. What else is typically in the first
message? Real examples would settle this faster than description.

**Q4 — Where does the employee map come from?**
Entered by hand in the admin panel, or read from the CRM's user list?

**Q5 — What if the phone number already exists in the CRM?**
Create a duplicate, update the existing lead, reassign it to the newly mentioned
employee, or flag it for a human? This will happen.

**Q6 — What if a message has no `@mention`, or mentions an unmapped number?**
Skip it, create the lead unassigned, or hold it for review in the panel?

**Q7 — Who may update a lead by replying?**
Anyone in the group, only the assigned employee, or only admins?

**Q8 — How does the bot tell an update from ordinary chat?**
A reply saying "ok" or "thanks" or "done" is not a field update. Writing those
into CRM fields would corrupt the record. Needs a rule.

**Q9 — Can one message contain several leads?**
And if so, several different mentions?

---

# Way 2 — Bank groups

*Not yet discussed.*
