# Pitch demo

Synthetic data only. Sign in with the shared `DEMO_PASSCODE`. Personas in the **Pitch demo** group of the sign-in list are the presenter's cast. Nothing here is a real unit, person, or mailbox.

The roster is the 99th Notional Wing. <!-- mf-banned-ok: fictional pitch-demo wing -->

## Cast

| Persona | What they show |
| --- | --- |
| Morgan Calder | Wing tasking authority. Creates the tasker. |
| Blake Pell | Awards Monitor in the logistics squadron. Sees the tasker, the document, and the assignment notice. |
| Sloane Harlow | Squadron commander. Sees the chain notice. |

Jules Adler (system administrator) can add and edit people. Edits are written to the audit log.

## Walkthrough

1. Sign in as **Morgan Calder**. The acting role is tasking authority.
2. Open **Work**, then **Create tasker**.
3. Enter a title, a fictional description, a suspense date, priority, and category `awards_package`.
4. Leave the unit boxes clear and set **Additional duty** to `Awards Monitor`. The routing preview lists the awards monitors across the squadrons, including Blake Pell.
5. Attach a sample file. The control states: Demo only. Do not upload real, CUI, or PII documents.
6. Submit. One tasker is created per matched action officer. The detail page lists the file (images and PDFs preview inline; anything allowed can be downloaded) and the audit events for routing and the upload.
7. Sign out. Sign in as **Blake Pell**. The bell shows an unread count. The notification says Blake was tasked, and the work list opens the same tasker and document.
8. Sign out. Sign in as **Sloane Harlow**. The bell shows a chain notice: "A member of your chain, Blake Pell, was tasked with …, suspense …".
9. Open **Outbox**. Each notice has one simulated email. Status is "Simulated — not sent".

**Directory** filters by unit, AFSC, and additional duty. A profile shows the org path and the chain of command derived from supervisor links.

Re-running `npm run seed` does not duplicate the wing when it is already present. `npm run seed -- --reset` is owner-only and reloads the pilot plus the wing.
