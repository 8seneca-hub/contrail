---
description: Scaffold a new contrail-managed document with correct frontmatter and title
argument-hint: "<docKind> <path>"
---

Run `contrail scaffold $ARGUMENTS`. This wraps `contrail scaffold` — it is the only correct way to
create a document (`src/scaffold.ts` owns frontmatter, section, and the derived title; do not
hand-write it). If `$ARGUMENTS` is missing the `docKind` or `path`, ask for whichever is missing
rather than guessing — see the `contrail-docs` skill for the full docKind taxonomy.
