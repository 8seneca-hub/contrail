---
description: Lint this project's contrail documents, optionally regenerating llms.txt
argument-hint: "[--strict] [--index] [--audience client] [--json]"
---

Run `contrail check $ARGUMENTS` and show the result. This wraps `contrail check` — the lint rules
live in `src/check.ts`, not here. Pass `--index` after adding, editing, or removing any document,
including a deletion — it regenerates `docs/llms.txt`, and skipping it leaves the index pointing at
a file that no longer matches disk.
