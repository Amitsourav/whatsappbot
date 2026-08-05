# Bot messages — draft for approval

Every message the bot posts into the in-house group. It sends **nothing else**, ever,
and never posts in any other group.

All replies are sent as a **quoted reply** to the message that triggered them, so it
is always obvious which lead is being discussed.

---

## When it speaks

| Situation | Speaks? |
|---|---|
| Lead created | ✅ Yes — confirmation |
| Lead already exists | ✅ Yes — warning |
| No `@mention` on a lead | ✅ Yes — asks for one |
| More than one `@mention` | ✅ Yes — asks for one |
| A reply set a CRM field | ✅ Yes — short confirmation |
| A reply had a label it could not use | ✅ Yes — explains why |
| A reply was plain text (went to notes) | ❌ Silent |
| A reply was "ok" / "done" / 👍 | ❌ Silent — ignored entirely |
| Anything in a bank group | ❌ Never posts there at all |

The reason field updates are confirmed: the labelled-format habit only sticks if
people get feedback. If someone types `Clg - DU` and it silently lands in notes
instead of the field, they never learn to type it correctly.

---

## 1. Lead created

```
✅ Lead created
Priya Sharma · +91 98765 43210
Assigned to @Rahul
```

## 2. Lead already exists

```
⚠️ Lead already exists
Priya Sharma · +91 98765 43210
Already with Rahul Kumar · added your message as a note
```

Assignment is deliberately **not** changed — silently moving someone else's lead to a
different person causes arguments. The message is recorded as a note so nothing is
lost, and a human can reassign if it is genuinely wrong.

## 3. No employee mentioned

```
⚠️ Please tag the employee for this lead
Priya Sharma · +91 98765 43210
Reply with @name and I'll create it
```

The lead is **held**, not discarded. Once someone replies with a mention, it is
created. It also appears in the admin panel so it cannot be forgotten.

## 4. More than one employee mentioned

```
⚠️ You tagged 2 people — Rahul and Priya
Please tag only one employee per lead
```

Held the same way as case 3. Nothing is created until it is unambiguous.

## 5. A reply updated a field

```
✅ University → Delhi University
```

Several at once:

```
✅ University → Delhi University
✅ Course → MBA
```

## 6. A reply had a label it could not use

```
⚠️ "Budget Range" isn't a field I know — saved as a note instead
```

For a value outside a locked list:

```
⚠️ "Some Random Bank" isn't in the bank list — saved as a note instead
Banks: Axis, PNB, SBI, Yes Bank, ICICI, IDFC, BOI, Kuhoo, Avanse, Credila,
Propelld, Tata Capital, Zolve, Nomad, UniCred, Auxilo, Incred, Edgro
```

## 7. Something went wrong on our side

```
⚠️ Couldn't save this to the CRM — retrying
Priya Sharma · +91 98765 43210
```

Sent only once per lead, never repeatedly, however many retries happen underneath.
If it eventually succeeds, message 1 follows.

---

## Safety rules on sending

**S1 — The bot ignores its own messages.** Without this, its own "please tag the
employee" reply — which contains no mention and no phone — could feed back into the
pipeline, and in the worst case it talks to itself.

**S2 — One reply per triggering message.** A message can never produce two bot
replies, however many things are wrong with it.

**S3 — Hard rate limit.** A cap per minute across the whole group. If it is hit,
the bot stops sending and logs loudly rather than flooding the group. Capture
continues regardless — a rate limit must never cost a lead.

**S4 — Kill switch.** Sending can be turned off from the admin panel while capture
keeps running. If the bot ever misbehaves in front of the team, that is the button.

**S5 — In-house group only.** Sending is enabled per group and off by default. Bank
groups are never eligible.

**S6 — Never send on a retry loop.** Message 7 fires once. Retries are silent.


---

## Amendment, 2026-08-05 — a lead needs no name

**Phone is the identity.** A lead shared as just a number is complete, and holding
it for a missing name was wrong: it turned an ordinary message into a chore.

The CRM requires `full_name`, so when no name is found the **phone number stands in
as the name**. It is honest, searchable, and obviously provisional. A later reply
carrying `Name: Priya Sharma` replaces it.

Message 3c ("I couldn't find the student's name") is therefore withdrawn. The bot
never asks for a name — only for an assignee it genuinely cannot determine.

Confirmation for an unnamed lead shows the number alone:

```
✅ Lead created
+91 82720 61608
Assigned to @Ankit
```


---

## Amendment, 2026-08-05 — a duplicate shows where the lead stands

Message 2 was a bare "already exists". In the live CRM, with 10,000 leads, that is
the common reply — and it left the team no wiser than before. It now reports the
lead's actual state, so nobody has to open the CRM to find out whether it is
already being worked, and by whom.

```
⚠️ Already in the CRM · #8871
Jaanvi Dixit · +91 75798 83047

Stage: Processing
Counsellor: Rudra Taneja
Pre-counsellor: Himanshu
University: GLA University, Mathura
Course: B.Tech
Loan: 7 Lakh
Added: 12 Mar 2026

Your message was saved as a note
```

Only fields that hold a value are shown — a blank row is noise. Agent names are
resolved from the cached user list, because the single-lead response does not
always populate them.

Assignment is still never changed, and the message is still saved as a remark.
