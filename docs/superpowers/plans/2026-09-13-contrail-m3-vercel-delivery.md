# contrail M3 — Vercel delivery and the internal/client split

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** One documentation source deploys to two Vercel projects — an internal site only the team can reach, and a client site that is safe to hand over — with the build itself making it impossible to confuse the two.

**Spec:** extends the M2 plan. contrail still only generates and manages documentation; deploying is a command it offers, not a workflow it runs.

## The decision, and why

Vercel's Deployment Protection is configured **per project and per environment — never per path**. There is no supported way to have one deployment where `/03-management/*` is protected and `/04-technical/*` is public. (Even Routing Middleware does not help: protection applies to middleware requests too.)

Verified protection options and their real cost:

| Method | Plan | Note |
|---|---|---|
| Vercel Authentication | All plans | Viewer needs a Vercel account with team access |
| Password Protection | Enterprise, **or Pro + $150/month add-on** | The add-on unlocks all Advanced Deployment Protection |
| Trusted IPs | Enterprise only | |
| Passport (your IdP) | Enterprise only | |
| Standard Protection (everything except production domains) | All plans | |
| All Deployments (production included) | Pro and Enterprise | |

**The architecture: one repository, one `docs/` tree, two Vercel projects.**

```
project-repo/
  docs/                    ← the unified source; every document lives here once
  contrail.config.ts
```

| | Internal project | Client project |
|---|---|---|
| Build | `contrail site --out dist` | `contrail site --out dist --audience client` |
| Contains | every document | only `audience: client` documents |
| Protection | Vercel Authentication, All Deployments scope | none needed — see below |
| Audience | the team | the client |

**Why the client site needs no password.** contrail filters at build time, so the client deployment does not *contain* internal material — the budget is not hidden on that host, it was never uploaded. Absence is a stronger guarantee than access control, and it is free. A password on a bundle that contains the secret is one misconfiguration away from a leak; a bundle without the secret cannot leak it.

Add Password Protection only if the client's own security policy demands a login, and know it costs $150/month on Pro. That is a business decision, not a security necessity.

**Why not one project with path rules.** Because Vercel cannot do it, and because even if it could, it would put the margin figures on the same host as the client site and make a config change the only thing standing between them.

## A problem this milestone must fix

Both builds currently render `<title>Documentation</title>` and an identical index. Someone holding two browser tabs — or two URLs — cannot tell which is which. That is how the wrong link gets pasted into an email. The builds must be distinguishable at a glance, in the page and in the tab title.

## Global Constraints

- The client build must remain physically free of internal material. Nothing in this milestone may weaken M2's Task 3 guarantee; its tests must keep passing untouched.
- `contrail` does not store Vercel tokens. Deployment uses the Vercel CLI's own auth, and contrail shells out to it.
- ESM, explicit `.js` extensions, TS strict. Do not modify `src/plane/` or the two write guards.

---

### Task 1: Build identity — make the two builds impossible to confuse

**Files:** `src/emit/site.ts`, `templates/site.css`, `tests/build-identity.test.ts`

Every page of a build declares which build it is:

- The `<title>` carries the project name and, for internal builds, an explicit marker: `Charter · Meridian Portal (internal)` versus `Charter · Meridian Portal`.
- The index page shows the project name as its heading — from `00-meta/project.yml` — rather than the generic "Documentation".
- An internal build renders a persistent banner on every page: *Internal — contains commercial information. Not for client distribution.* Make it visually unmissable and make it print (`@media print`), because the way this leaks is a printed PDF.
- A client build renders no banner. Its absence is the signal, and it keeps the client-facing artifact clean.

Tests: an internal build's title and banner are present on every page including the index; a client build has neither, and the word "internal" appears nowhere in its output; the banner survives a print stylesheet.

---

### Task 2: `contrail deploy`

**Files:** `src/deploy.ts`, `src/cli.ts`, `tests/deploy.test.ts`

```
contrail deploy [--audience client|internal] [--prod] [--dry-run]
```

Builds, then shells out to `vercel deploy --prebuilt` with the right directory. The Vercel CLI owns authentication; contrail never reads or stores a token.

Two guards, both of which exist because the failure they prevent is public:

1. **Refuse to deploy an internal build to a project configured as the client project**, and vice versa. Record which Vercel project each audience targets in `contrail.config.ts` (`vercel.internalProject`, `vercel.clientProject`) and compare against the linked project before deploying. A mismatch aborts and explains which project it expected.
2. **`--prod` on a client deployment prints what it is about to publish** — the document count and every title — and requires confirmation unless `--yes`. Deploying to a client URL is outward-facing and irreversible in the way that matters: they may have already read it.

`--dry-run` prints the command and the file count, and deploys nothing.

Tests: the CLI runner is injected, never invoking real `vercel`; a project mismatch aborts with a message naming both projects; `--prod --audience client` without `--yes` does not deploy; `--dry-run` invokes nothing.

---

### Task 3: Self-aware site URLs

**Files:** `src/config.ts`, `src/emit/site.ts`, `src/check.ts`, `tests/site-url.test.ts`

Add `site.internalUrl` and `site.clientUrl` to config. With them, a build knows its own address, which unlocks:

- Absolute URLs in `llms.txt`, so an agent can fetch a document rather than guess its path.
- A canonical link tag per page.
- **Cross-build references that do not leak.** An internal document may link to the client site by URL. A client document must never link to the internal site — the lint errors if one does, because a URL is enough to tell a client that a document about them exists.

This is also what replaces the dormant Plane page: the deployed site *is* the documentation home, and `site.clientUrl` is the link you send.

Tests: an internal build emits absolute URLs against `internalUrl`; a client build against `clientUrl`; a client document linking to `internalUrl` is an error; a build with no configured URL still works with relative links.

---

### Task 4: Deployment documentation

**Files:** `docs/deploying.md`, `README.md`

Write down what someone needs on their first day: creating the two Vercel projects from one repository with different build commands, setting Vercel Authentication with the All Deployments scope on the internal project, leaving the client project unprotected and why that is safe, and the $150/month figure if they decide they want Password Protection anyway.

Include the failure mode this design prevents, in one paragraph, so the next person does not "simplify" it back into a single deployment.

---

## Done when

- Internal and client builds are distinguishable from the tab title alone.
- `contrail deploy --audience client` refuses to publish to the internal project.
- A client document linking to the internal site is a lint error.
- `docs/deploying.md` is enough to set both projects up without asking anyone.
- M2's audience tests pass untouched.

## Not in this milestone

CI wiring, custom domains, and any automated deploy-on-merge. contrail offers a deploy command; when and how it runs is the user's decision.
