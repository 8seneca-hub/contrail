# Deploying

This is what you need on your first day: two Vercel projects, from one repository, built from
one `docs/` tree — one internal, one for the client. Do this once per engagement.

## Why two projects, not one

Vercel's Deployment Protection is configured **per project and per environment — never per
path.** There is no supported way to have one deployment where, say, `/03-management/*` is
protected and `/04-technical/*` is public. Routing Middleware does not help either —
protection applies to middleware requests too.

So the split happens at build time instead: contrail filters documents by `audience` before
either build ever runs, and the result is two separate Vercel projects pointed at the same
repository.

| | Internal project | Client project |
|---|---|---|
| Build command | `contrail site --out dist` | `contrail site --out dist --audience client` |
| Contains | every document | only `audience: client` documents |
| Protection | Vercel Authentication, **All Deployments** scope | none |
| Who reads it | the team | the client |

**Do not "simplify" this into one deployment with path rules later.** It is tempting —
one project is less setup than two — but Vercel cannot do it (protection is per-project, not
per-path, see above), and even if a future version of Vercel could, it would put the internal
build's margin figures and the client-facing site on the same host, one misconfigured rule
away from both being reachable at once. The failure this design prevents is a client reading
a budget line that was never meant to leave the team: two projects make that leak physically
impossible — the client project never contains the internal material in the first place — a
single project with a protection rule only makes it *unlikely*, and unlikely is not the bar
for a client's commercial data.

## Setting up the internal project

1. In Vercel, **Add New… → Project**, import this repository.
2. Set the **Build Command** to `contrail site --out dist` (or your framework preset's
   equivalent, with that as the build step) and the **Output Directory** to `dist`.
3. Deploy once so the project exists, then go to **Settings → Deployment Protection**.
4. Enable **Vercel Authentication**, scope set to **All Deployments** (not just previews —
   the whole point is that production is protected too). A viewer needs a Vercel account with
   access to this team; nobody else gets past the login wall.
5. Name the project something that will not be confused with the client one — e.g.
   `<client>-internal`. You will put this exact name in `contrail.config.ts` as
   `vercel.internalProject` (see below).

## Setting up the client project

1. **Add New… → Project** again, same repository, but a **second, separate** Vercel project.
2. Set the **Build Command** to `contrail site --out dist --audience client`.
3. Leave **Deployment Protection** off. This is deliberate, not an oversight — see the next
   section for why.
4. Name it `<client>-client` (or similar) and record it as `vercel.clientProject`.

## Why the client project needs no password

contrail filters documents at build time. `--audience client` means only documents explicitly
marked `audience: client` are ever read, rendered, or written to `dist/` — a document that
isn't marked for the client does not exist as far as that build is concerned. The client
deployment does not *contain* internal material, so there is nothing on that host to protect.
Absence is a stronger guarantee than access control, and it is free: a password on a bundle
that contains the secret is one misconfiguration (a wrong scope, an expired session, a
forwarded link) away from a leak. A bundle that never received the secret cannot leak it no
matter what happens to the password.

If the client's own security policy requires a login on their own site regardless, you can
still add **Password Protection** to the client project. Know the cost before you turn it on:
Password Protection is available on **Enterprise**, or on **Pro plus a $150/month add-on**
(the add-on unlocks the full Advanced Deployment Protection tier — Password Protection,
Trusted IPs, and SSO/Passport). Budget for that explicitly if you want it; it is a business
decision about the client relationship, not a security requirement contrail's design leaves
unmet.

## Configuring `contrail.config.ts`

```ts
export default {
  // ...
  vercel: {
    internalProject: 'meridian-internal', // exact Vercel project name from step 5 above
    clientProject: 'meridian-client',
  },
  site: {
    host: 'vercel',
    internalUrl: 'https://meridian-internal.vercel.app',
    clientUrl: 'https://meridian-client.vercel.app',
  },
}
```

`vercel.internalProject`/`vercel.clientProject` are what `contrail deploy` checks against the
project actually linked in this directory — see the guard below.

## `contrail deploy`

```
contrail deploy [--audience client|internal] [--prod] [--dry-run] [--yes]
```

Builds the site for the chosen audience (`internal` is the default — everything), then shells
out to `vercel deploy --prebuilt` against the built directory. contrail never reads, stores,
or logs a Vercel token: the Vercel CLI owns authentication entirely, and its own prompts and
output pass straight through to your terminal.

Before every deploy, the CLI must already be linked to a Vercel project in this directory
(`vercel link`, once, per audience/checkout). Two guards run before anything is published:

1. **Wrong-project guard.** contrail compares the project linked in `.vercel/project.json`
   against `vercel.internalProject`/`vercel.clientProject` for the audience you asked for. A
   mismatch aborts immediately and names both the expected and the actual project — publishing
   an internal build to the client project is the single worst thing this tool could do, and
   it is one mistyped flag or one stale `vercel link` away without this check.
2. **Client production confirmation.** `--prod --audience client` prints the document count
   and every title it is about to publish, then asks you to confirm — unless you pass `--yes`.
   A client may read the page the moment it lands; there is no meaningful undo.

`--dry-run` prints the `vercel` command it would run and the file count, and deploys nothing.

Typical first deploy of each project:

```bash
# once, per checkout, per project
vercel link   # link to the internal project, or the client project — do this in two checkouts,
              # or re-run `vercel link` before each deploy if you use one

# internal
contrail deploy --audience internal --prod

# client — asks for confirmation unless you pass --yes
contrail deploy --audience client --prod
```

## Deploying into Plane instead of Vercel

`--target plane` uploads the built site to a self-hosted Plane instance, which serves it behind its
own project membership check and shows it in the project's Docs tab. The protocol is specified in
[`plane-docs-api-spec.md`](plane-docs-api-spec.md), which is also the document to hand to whoever
works on the Plane fork.

Prefer this over any proxy-level gate. Caddy — or anything else in front of Plane — can only ask "is
this visitor logged in", which grants everyone in the workspace every project's documents, including
other clients' budgets. Only Plane knows who is on which project.

```ts
// contrail.config.ts
selfhost: { target: 'plane', projectId: '<the project UUID>' }
```

`plane.baseUrl` and `plane.workspace` supply the rest of the address; `PLANE_API_KEY` must be
exported and is never read from config.

```bash
contrail deploy --target plane --audience internal --dry-run   # prints the manifest, uploads nothing
contrail deploy --target plane --audience internal
```

Each deploy uploads to a fresh build prefix and then commits it. Until the commit lands, readers see
the previous build — so a failed or interrupted upload leaves the live site alone rather than
serving a half-updated one. If Plane presigns fewer files than the manifest listed, or any upload
fails, contrail aborts **before** committing and says so.

Client documents are a separate decision: Plane members are the team, not the client. Either the
Plane side grows a share token for the `client` build, or client docs stay on Vercel as described
above.

### What happens when documents change

A deploy sends a whole build, not a set of edits. That makes the day-to-day flow short — edit the
Markdown, `contrail check`, deploy — and it makes deletes work without a delete command: a document
you removed is simply not in the next build, and the pointer flip retires it and publishes
everything else at the same instant.

Measured on a 31-file tree: editing one document changes one built file; **adding** one changes 32
of 33, because every page renders the navigation. So an edit is cheap to publish and a new document
is not — which is the opposite of what most people assume, and the reason contrail sends a hash per
file so the server can skip what it already holds.

Three things that catch people out:

**Un-marking a document as `client` does not retract it.** Removing `audience: client` takes it out
of the *next client build* — but until someone actually runs the client deploy, the client site
still serves the previous build, which still contains it. If a document reached a client by mistake,
deploying `--audience internal` changes nothing; the fix is to deploy the client build. Deploy both
audiences together, always, and this cannot bite you:

```bash
contrail deploy --target plane --audience internal
contrail deploy --target plane --audience client
```

**A deleted document survives in storage until its old build is pruned.** It is unreachable — the
server only serves the current build — but the bytes are still in MinIO for the next couple of
builds. If you deleted something *because* it should not exist anywhere, ask for that project's
older builds to be pruned rather than assuming the delete did it.

**A rename breaks links people have already pasted.** The new path works and every link inside the
site is rebuilt, but a URL someone dropped into a ticket last month now 404s. Rename early, or
accept it.

**Deploying from a stale checkout reverts things.** Two deploys race by last-commit-wins, and the
loser is not a merge — it is the whole site as that checkout saw it. Deploy from CI on `main`, not
from laptops, and this never comes up.

### The Railway volume target

`--target railway` predates the Plane API and remains implemented
(`selfhost: { target: 'railway', volume, slug, internalPath, clientPath }`). Use it only where the
Plane endpoints do not exist: it needs a separate authentication gate in the proxy, and that gate
cannot distinguish one project from another.
