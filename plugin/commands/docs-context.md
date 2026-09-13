---
description: Rank this project's contrail-managed documents for a task, with a reason per document
argument-hint: "[--task feature|estimate|scope|decision|client-call|onboard|test|deploy|risk] [keywords...] [--audience client] [--json] [--limit <n>]"
---

Run `contrail context $ARGUMENTS` and show the result, unedited. This wraps `contrail context` —
the ranking logic lives there (`src/context.ts`), not here. If no arguments were given, run
`contrail context` with no flags, look at what task the user is actually working on, and re-run
with the closest `--task` or a couple of keywords.
