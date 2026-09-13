---
description: Build the contrail site (internal, or client with --audience client)
argument-hint: "[--out <dir>] [--audience client]"
---

Run `contrail site $ARGUMENTS` and show the result. This wraps `contrail site` — the build lives in
`src/emit/site.ts`, not here. Omitting `--audience client` builds the internal site with every
document; `--audience client` builds the filtered client site and its own `llms.txt`. Never pass
`--audience internal` — it isn't a build mode; omit the flag instead.
