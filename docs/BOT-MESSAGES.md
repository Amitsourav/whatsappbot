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
