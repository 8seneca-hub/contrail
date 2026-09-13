# Spec — project docs hosting inside Plane

**For:** whoever works in `8seneca-hub/8seneca-projects` (the Plane fork).
**Written:** 2026-09-13.
**Size:** roughly 200 lines of Python plus a small frontend route.

## What this is for

contrail builds a project's documentation into a static site — HTML, CSS, and self-contained
interactive diagram files. Today that site has nowhere good to live: Plane Community has no Pages API,
its editor sanitizes away anything rich, and hosting it elsewhere means a second auth system.

This spec puts it inside Plane: uploaded through an API, stored in the MinIO you already run, served
back with Plane's own permissions, and displayed as a Docs tab in the project.

The deciding advantage over hosting it outside Plane: **access follows project membership**. Someone
on the Meridian project sees Meridian's documents and nobody else's. No separate ACL, no shared
password, no "everyone logged in sees every client's budget".

## What already exists and should be reused

- `plane.settings.storage.S3Storage` with `generate_presigned_post`
- The `FileAsset` model and its `EntityTypeContext`
- The presigned-upload pattern in `apps/api/plane/api/views/asset.py`
- Plane's existing permission classes for workspace and project membership

Nothing here needs new infrastructure.

---

## Piece 1 — upload

Add `PROJECT_DOCS` to `FileAsset.EntityTypeContext`.

```
POST /api/v1/workspaces/<slug>/projects/<project_id>/docs/uploads/
```

Request — the manifest of one build:

```json
{
  "build_id": "2026-09-13T11-42-07Z-a1b2c3",
  "audience": "internal",
  "files": [
    { "path": "index.html",            "size": 4821,   "type": "text/html", "sha256": "9f2b…" },
    { "path": "04-technical/prd.html", "size": 18422,  "type": "text/html", "sha256": "c41a…" },
    { "path": "diagrams/a3b58290.html","size": 807898, "type": "text/html", "sha256": "a3b5…" },
    { "path": "site.css",              "size": 6210,   "type": "text/css",  "sha256": "0e77…" }
  ]
}
```

Response — one presigned POST per file, so bytes go straight to MinIO and never through Django:

```json
{
  "build_id": "2026-09-13T11-42-07Z-a1b2c3",
  "uploads": [
    { "path": "index.html", "upload_data": { "url": "...", "fields": { ... } } }
  ]
}
```

Store each object under a **versioned prefix**:

```
docs/<project_id>/<audience>/<build_id>/<path>
```

### Then commit the build

```
POST /api/v1/workspaces/<slug>/projects/<project_id>/docs/commit/
{ "build_id": "...", "audience": "internal" }
```

This flips a pointer — a small row recording the current `build_id` per (project, audience).

**Why a pointer rather than overwriting in place.** Uploading fifty files takes time. If readers were
served from the live prefix mid-upload, they would see a half-updated site: new pages linking to
diagrams that have not landed yet. Writing to a fresh prefix and flipping one pointer makes the
swap atomic, and makes rollback a matter of pointing at the previous build.

Prune old builds on a schedule — keep the last three.

### Who is allowed to upload

Both write endpoints take the same `X-API-Key` header as the rest of Plane's API, and a key belongs
to a person — so apply the **same project membership check as the read path**, at member or admin
level. Not workspace membership: a workspace member who is not on this project must not be able to
replace its documentation, and a guest must not either.

This is easy to leave out, because the upload endpoint is the one nobody browses to. Without it,
any key in the workspace can overwrite any project's docs.

### Error semantics that matter

- **Commit of a `build_id` that was never uploaded, or only partly uploaded → 400, and do not move
  the pointer.** A pointer to a prefix that isn't there makes the Docs tab blank with no obvious
  cause. Cheap insurance: before committing, LIST the prefix and compare the object count against
  the manifest you stored at upload time; refuse if it is short.
- **Commit of a build already committed → fine, idempotent.** A retried deploy should not error.
- **Upload manifest with a path containing `..`, a leading `/`, or a backslash → 400.** Reject it at
  the manifest, not only at serve time — that way a hostile path never reaches storage at all.

### One thing to check in your presign policy

The diagram files are large — around 800 KB each, occasionally more. A presigned POST policy with a
`content-length-range` capped lower than that will reject exactly those files, and the failure
surfaces as an opaque 403 from MinIO rather than anything readable.

Set the range from the `size` the manifest declares for each file (which also stops a client
uploading something far larger than it announced), and allow at least 25 MB of headroom.

## Piece 2 — serving

This is the piece that makes relative links work, and the one to get right.

```
GET /api/v1/workspaces/<slug>/projects/<project_id>/docs/<path:path>
```

Behaviour:

1. Resolve the current `build_id` for (project, audience=internal) from the pointer.
2. **Check project membership** using Plane's existing permission classes. A non-member gets 404, not
   403 — a 403 confirms the project exists.
3. Map to the S3 key `docs/<project_id>/internal/<build_id>/<path>`.
4. Stream the object back with its stored `Content-Type`.
5. Empty path or a path ending in `/` serves `index.html` beneath it.

Everything sits under one path prefix on one origin, which is exactly why relative links
(`../diagrams/x.html`, `site.css`, iframe `src`) resolve without rewriting.

### Security requirements — please do not skip these

**Path traversal.** Reject any path containing `..`, a leading `/`, or a backslash, before it reaches
S3. Normalise and then verify the resolved key still begins with the expected prefix.

**Content-Type.** Serve the type recorded at upload. Add `X-Content-Type-Options: nosniff` so a
mistyped object cannot be reinterpreted as something executable.

**Never serve an audience the caller did not ask for.** The endpoint above serves `internal` only.
Client builds are a separate concern (see "Client access" below) — do not add an `?audience=` query
parameter that a member could flip.

## Piece 3 — displaying it

A **Docs** tab in the project, rendering:

```html
<iframe
  src="/api/v1/workspaces/{slug}/projects/{id}/docs/index.html"
  sandbox="allow-scripts allow-popups"
></iframe>
```

### The `sandbox` attribute is the most important line in this spec

contrail's diagrams are self-contained interactive HTML — they contain JavaScript. Served from
`projects.8seneca.com`, that JavaScript would run **on Plane's own origin**, where it can read the
session cookie, read `localStorage`, and call Plane's API as the logged-in user. A single malicious or
compromised diagram would own the workspace.

`sandbox="allow-scripts"` **without** `allow-same-origin` gives the iframe a unique opaque origin. The
diagrams stay fully interactive; they simply cannot see Plane. Those two tokens must not both be
present — together they let the frame remove its own sandbox.

If you would rather not rely on the attribute alone, add a response header on the docs endpoint:

```
Content-Security-Policy: default-src 'self' 'unsafe-inline' data:; frame-ancestors 'self'
```

Belt and braces. The sandbox attribute is the part that must exist.

Note this does **not** involve the editor sanitizer. The iframe is application code in a React route,
not user-entered page content, so nothing about Plane's editor needs changing.

## Document lifecycle — what MinIO actually has to do

Worth being explicit about, because the answer is "less than you would expect". contrail does not
send document operations. It sends **whole builds**, and a build is immutable once committed.

| The team does this | contrail sends | MinIO ends up with |
|---|---|---|
| Edits a document | a new build | one changed object; the other ~50 byte-identical |
| Adds a document | a new build | nearly every object rewritten — every page carries the nav |
| Deletes a document | a new build | the object is simply never written into the new prefix |
| Renames or moves one | a new build | new path present, old path absent |

Measured on a real tree of 31 files: **editing one document changes exactly one file; adding one
changes 32 of 33**, because every page renders the navigation. Rebuilding an unchanged tree
produces byte-identical output, which is what makes the optional reuse below safe.

**There is no delete endpoint, and there should not be one.** A deleted document is one that the
next manifest does not mention, so it never reaches the new prefix, and the pointer flip makes it
unreachable in the same instant the rest of the build goes live. Nothing to get out of sync.

### Pruning is the only cleanup, and it is the only thing that erases

Keep the last three builds; delete the rest. Two consequences worth stating plainly:

- Storage is roughly `build size × 3` per project per audience. The sample build is 1.7 MB, so
  about 5 MB per project — the diagram files dominate it, not the pages.
- **A deleted document still exists in the previous build's prefix until that build is pruned.** It
  is unreachable through the API, because the serving endpoint only ever resolves the current
  pointer — but the object is there. If a document is being deleted *because* its contents should
  not exist, pruning that project's older builds is the step that actually removes it. Please make
  that possible to trigger on demand, not only on a schedule.

This is also the reason the serving endpoint must never accept a caller-supplied `build_id`. A
parameter like `?build=<id>` would turn every retained prefix into a way to read a document that
was deliberately removed.

### Optional: let contrail skip files you already have

Only worth building if the simple version proves slow. Each manifest entry carries a `sha256`. If
you already hold an object with those bytes from an earlier build of the same project and audience,
answer with `{"path": "...", "reused": true}` instead of presigned fields, and server-side copy it
into the new prefix. contrail already understands that answer and will skip sending those bytes.

An implementation that presigns everything is correct — this only changes how much crosses the
network. For the common case, editing a single document, it is the difference between sending a
few kilobytes and sending the whole site.

Whatever you choose: a path that is **neither** presigned **nor** marked reused makes contrail
abort before committing, because the alternative is publishing a build with a page or stylesheet
missing.

## Client access

Clients are not Plane members, so none of the above reaches them. Two options, to decide separately —
do not let this block the internal side:

- **A share token.** A per-project, revocable token that serves the `client` build at
  `/api/v1/public/docs/<token>/<path>` with no session. contrail already builds a client bundle that
  contains no internal material, so a leaked token exposes only what was meant for that client.
- **Keep client docs on Vercel**, as they are today. Zero work, separate system.

## What contrail will do

contrail is being updated to speak this protocol:

```bash
contrail deploy --target plane --audience internal
```

1. Build the audience-filtered site
2. `POST …/docs/uploads/` with the manifest
3. POST each file to its presigned URL (multipart form, straight to MinIO), skipping any the
   server marked `reused`
4. `POST …/docs/commit/` to flip the pointer

It authenticates with a Plane API key from the environment, never stored in config. It already
implements this exact presigned pattern for Plane page assets, so the client side is mostly written.

## Verification

Please run these and report results. Numbers 3 and 5 are the ones that matter.

1. Upload a build, commit it, open the Docs tab → **the site renders, diagrams interactive**
2. Click through to a nested page → **relative links and CSS resolve**
3. Log in as someone **not** on that project, hit the docs URL directly → **404, never content**
4. Upload a new build without committing → **the old build still serves**
5. In the iframe's console, run `document.cookie` → **empty**, and `parent.location` → **throws**

Number 5 is the sandbox working. If the cookie is readable, the sandbox is misconfigured and the
feature is not safe to ship.

## Please do not

- Add `allow-same-origin` alongside `allow-scripts` on the iframe.
- Serve docs from a path outside the permission check "just for testing".
- Overwrite the live prefix in place instead of using build pointers.
- Return 403 for a non-member — use 404.

## Open questions back to contrail

1. Is a per-file presigned upload acceptable, or would you prefer a single tarball that the server
   unpacks? Per-file keeps bytes out of Django; a tarball is one request. contrail can do either.
2. Do you want the client share token in this first pass, or shall we keep client docs on Vercel?
