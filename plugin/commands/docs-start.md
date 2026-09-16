---
description: Start a contrail project — its GitHub repo, the interview, the diagrams, then publish
argument-hint: "<project name>"
---

Run the full intake for `$ARGUMENTS`. Ask for the project name if none was given; never invent one.

## 1. The repository

The markdown is the source of truth and it lives in GitHub, so settle that before scaffolding.

Ask: **"Which GitHub repo is this project's? Paste the URL, or say `create`."**

- **A URL:** clone it. Scaffold into the clone, so `docs/` sits in the repo from the first commit.
- **`create`:** confirm the owner and name, create the repo, then clone it. Creating a repo is not
  undoable — say the full `owner/name` and wait for a yes.
- Repo already has a `docs/` folder: do not overwrite it. `contrail init` skips what exists, but say
  what it skipped.

## 2. Scaffold

`contrail init --template agency-project --project "<name>"`, run inside the clone. Creates the Plane
project, enables its Docs tab, and writes 32 files. The output lists every document and the questions
it owes.

## 3. The brief, then the interview

Ask for the brief first — whatever they already have. Answer what it genuinely covers.

Then `contrail questions`. Put each round to them **in the conversation, in your own words, a whole
round at a time**. They are the only source that can answer most of these. After each round, write
their answers into that round's documents and run `contrail questions` again; answered documents drop
out, so the interview resumes rather than repeats.

`unanswered: "<why not>"` is only for what they say they do not know, and the reason should record
that they were asked. Add a matching row to `03-management/open-questions.md`. **Never invent a
figure, a name or a date.**

## 4. Diagrams

A person reading this should be able to see the shape of the thing, not just read about it. Author
diagrams with **Archify**, never mermaid — mermaid flattens to a PNG, Archify produces explorable
HTML with themes and export.

- Write the IR as JSON beside the document: `docs/04-technical/diagrams/<name>.<type>.json`.
- Set `meta.visual_preset` to `signal-flow`.
- Reference it from the document:

  ```archify {type=architecture, src=./diagrams/system.architecture.json, summary="One sentence on what this shows."}
  ```

- `summary` is mandatory; a missing one is a build error, not a warning.
- Diagram type by what the text describes: `architecture` for components and connections, `sequence`
  for an ordered exchange, `workflow` for a branching process with handoffs, `dataflow` for data
  crossing a boundary, `lifecycle` for an entity moving through states.
- At minimum give `04-technical/architecture.md` and `04-technical/prd.md` a diagram. `contrail check`
  reports `undiagrammed-doc` and `flow-without-diagram` on anything else that needs one — clear those
  before preview.
- Archify not installed? `contrail` prints the exact install and `archify.bin` instructions.

## 5. Check, then confirm the HTML

`contrail check` — clear the errors, and the diagram warnings above. This also regenerates
`docs/llms.txt`, the index that tells an agent which document to read; commit it with the docs.

`contrail preview` — hand the person the `file://` link and **wait for them to confirm it**. That is
byte-for-byte the HTML the Plane Docs tab serves, so it is the last point at which a human sees what
a human will see.

## 6. Publish and commit

`contrail deploy --target plane`. Every page ships twice: `.html` for people, `.md` for agents. A
deploy refuses if a document changed after the preview they confirmed — re-preview and re-confirm.

Then commit and push the repo: the documents, their diagram IR, and `docs/llms.txt`.

Read the `contrail-docs` skill before writing any document body — it owns the frontmatter schema, the
title conventions and the diagram rules.
