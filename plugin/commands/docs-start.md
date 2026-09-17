---
description: Start a contrail project — its GitHub repo, the interview, the diagrams, then publish
argument-hint: "<project name>"
---

Run the full intake for `$ARGUMENTS`. Ask for the project name if none was given; never invent one.

## 0. Can this machine render a diagram?

`contrail doctor` first. If the **archify** check fails, stop and ask the user to run the install
command it prints, then re-run doctor. Do not carry on and author diagrams anyway: Archify is only
invoked by a document that already references one, so a project with none builds clean and reports
`0 diagram(s)` as though nothing were wrong. The user finds out when they open the Docs tab and the
diagrams they asked for are not there.

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

## 3. What already exists

Most projects are not starting from nothing, and material the client already wrote answers questions
faster and more accurately than asking someone to recall them. Ask once, listing the kinds:

> Is there a brief or RFQ, a Drive or SharePoint folder, spreadsheets (estimates, pricing, backlogs),
> an OpenAPI/Swagger spec, past proposals, meeting notes, an existing repo or wiki?

Read whatever they point you at and land each item **verbatim** in `docs/01-overview/intake/`. That
folder exists for exactly this, and a raw client artefact must keep its own words — synthesis happens
in the real documents, which cite the intake file they came from.

Two kinds need more than a copy:

- **Google Sheets** — do not paste the numbers. Use a `sheet` block, so the document shows live values
  with a link back and a cached snapshot: ```` ```sheet {id=<spreadsheet id>, range="Estimate!A1:E40",
  summary="..."} ```` Needs a Google service account (`sheets.credentialsPath`, or
  `GOOGLE_APPLICATION_CREDENTIALS`).
- **OpenAPI/Swagger** — the spec belongs beside `04-technical/api-reference.md`, and that document
  summarises what the API does rather than restating every endpoint.

## 4. The brief, then the interview

Answer what the intake material genuinely covers before asking anyone anything.

Then `contrail questions`. Put each round to them **in the conversation, in your own words, a whole
round at a time**. They are the only source that can answer most of these. After each round, write
their answers into that round's documents and run `contrail questions` again; answered documents drop
out, so the interview resumes rather than repeats.

`unanswered: "<why not>"` is only for what they say they do not know, and the reason should record
that they were asked. Add a matching row to `03-management/open-questions.md`. **Never invent a
figure, a name or a date.**

## 5. Diagrams

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
- **Every document needs a diagram.** `contrail check` errors on any that has none, and a deploy
  refuses. Where one genuinely has no shape — the glossary, the approvals log, open questions — set
  `nodiagram: "<why there is nothing to draw>"` rather than drawing filler.
- Archify not installed? `contrail` prints the exact install and `archify.bin` instructions.

## 6. Check, then confirm the HTML

`contrail check` — clear the errors, and the diagram warnings above. This also regenerates
`docs/llms.txt`, the index that tells an agent which document to read; commit it with the docs.

`contrail preview` — hand the person the `file://` link and **wait for them to confirm it**. That is
byte-for-byte the HTML the Plane Docs tab serves, so it is the last point at which a human sees what
a human will see.

## 7. Publish and commit

`contrail deploy --target plane`. Every page ships twice: `.html` for people, `.md` for agents. A
deploy refuses if a document changed after the preview they confirmed — re-preview and re-confirm.

Then commit and push the repo: the documents, their diagram IR, and `docs/llms.txt`.

Read the `contrail-docs` skill before writing any document body — it owns the frontmatter schema, the
title conventions and the diagram rules.
