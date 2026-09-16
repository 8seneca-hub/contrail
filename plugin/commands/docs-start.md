---
description: Start a contrail project — scaffold it, interview the user, then publish
argument-hint: "<project name>"
---

Run the full intake for `$ARGUMENTS`. If no name was given, ask for one rather than inventing it.

1. `contrail init --template agency-project --project "<name>"`. This creates the Plane project and
   the five-section tree. The output lists every scaffolded document and the questions it owes.

2. `contrail questions`. Put each round to the user **in the conversation, in your own words, a
   whole round at a time**. They are the only source that can answer these. Do not answer on their
   behalf from the brief alone, and do not mark documents `unanswered` to get past the gate — that
   turns a docs tree into 23 pages of placeholder, which is the failure this command exists to
   prevent.

3. After each round, write what they told you into the documents that round named, then run
   `contrail questions` again for the next round. Answered documents drop out, so the interview
   resumes where it left off.

4. Anything the user says they genuinely do not know: set `unanswered: "<what is missing, and that
   they were asked>"` in that document's frontmatter, and add a row to
   `03-management/open-questions.md`. Never invent a figure, a name or a date.

5. `contrail check`, then `contrail preview`. Give the user the `file://` link and **wait for them
   to confirm it**. That HTML is exactly what the Plane Docs tab serves.

6. `contrail deploy --target plane`. Every page ships as HTML for people and as `.md` for agents.
   A deploy refuses if a document changed after the preview they confirmed.

Read the `contrail-docs` skill before writing any document body — it owns the frontmatter schema,
the title conventions and the diagram rules.
