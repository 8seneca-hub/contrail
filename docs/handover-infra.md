# Handover — hosting contrail docs on projects.8seneca.com

**For:** whoever operates `projects.8seneca.com` and the Railway account.
**From:** the contrail build. Written 2026-09-13.
**Time to complete:** roughly an hour, most of it waiting for a deploy.

You are being asked to serve two static directories and put authentication in front of one of them.
Nothing here changes Plane's application code — the only change to the fork is two blocks in the Caddy
config.

## What you are hosting

contrail builds project documentation into two plain static directories. No server, no runtime, no
database — HTML, CSS and self-contained diagram files.

| Build | Contains | Who should reach it |
|---|---|---|
| **internal** | everything, including budget, effort estimates and margin | the 8Seneca team only |
| **client** | only documents explicitly marked `audience: client` | the client, by link |

**The client build is safe to serve publicly.** It does not *hide* internal documents — it does not
contain them. No page file, no diagram, no path in its index. A leaked client URL exposes nothing.

**The internal build must be authenticated.** It contains our cost basis and margin on live
engagements. This is the only security-relevant decision in this document.

## Target layout

One directory tree, one subdirectory per project, so adding project seven needs no configuration
change:

```
/srv/contrail/
  internal/
    meridian/     →  projects.8seneca.com/docs/meridian/      (authenticated)
    acme/         →  projects.8seneca.com/docs/acme/
  client/
    meridian/     →  projects.8seneca.com/client/meridian/    (public link)
    acme/         →  projects.8seneca.com/client/acme/
```

## What I need you to decide

### 1. Where does projects.8seneca.com actually run?

I could not determine this and did not want to guess. The fork
(`8seneca-hub/8seneca-projects`) contains `docker-compose.yml` and
`deployments/{cli,kubernetes,swarm}`, but no Railway configuration — no `railway.json`, no
`nixpacks.toml`.

The requirement is the same wherever it runs: **a persistent directory the proxy can read, that CI can
write to without a human holding server credentials.** How that is satisfied depends on your answer:

| If Plane runs on | Then |
|---|---|
| **Railway** | Attach a volume to the Plane service, mounted at `/srv/contrail`. CI writes with `railway volume files upload <dir> <path> --overwrite` — contrail already implements this transport. |
| **Kubernetes** | A PVC mounted into the proxy pod. CI writes via whatever you already use for artifacts. |
| **Docker Swarm / a VM** | A bind mount plus an rsync-over-SSH deploy key, restricted with `rrsync -wo /srv/contrail` so the key cannot get a shell or read anything back. |

contrail's deploy command has a pluggable transport for exactly this reason. Railway is implemented;
tell me which of the others you need and it is a small addition.

### 2. How should the internal build authenticate?

Three options. My recommendation is the first, but you know the estate better than I do.

**(a) Plane's own session — recommended.** Caddy asks Plane whether the visitor is logged in. Same
domain, same cookie, no second login, nobody to provision. I verified the endpoint behaves correctly:

```
GET https://projects.8seneca.com/api/users/me/   →  401 unauthenticated
                                                 →  200 with credentials
```

**(b) Keycloak (OIDC).** I noticed `8seneca-hub/8seneca-identity` and that the fork carries
"8Seneca SSO patches". If Plane already authenticates through Keycloak, pointing the docs at Keycloak
directly may be cleaner — and it solves client access properly: invite the client as a user scoped to
their own project, instead of relying on an unguessable URL. **If SSO is already in place, tell me and
I will revise this document; it may be the better answer.**

**(c) Cloudflare Access.** Cloudflare already fronts the domain. Zero Trust is free for up to 50 users
and can gate a path. Useful as a fallback, or to grant a specific external client email. It adds a
second identity system, which is why it is third.

## The Caddy change

Two blocks in `apps/proxy/Caddyfile.ce` of the fork. This is the only change to Plane's repository.

```caddy
# Internal docs — gated by Plane's own session
handle_path /docs/* {
    forward_auth api:8000 {
        uri /api/users/me/
        copy_headers Cookie
    }
    root * /srv/contrail/internal
    file_server
}

# Client docs — public by design; see "What you are hosting" above
handle_path /client/* {
    root * /srv/contrail/client
    file_server
}
```

`handle_path` strips the prefix, so `/docs/meridian/prd.html` resolves to
`/srv/contrail/internal/meridian/prd.html`.

Adjust `api:8000` to whatever the API service is called on your network. Place these blocks **before**
any catch-all that proxies to the web app, or Plane will answer first.

I have not opened a PR for this — it modifies the proxy in front of production, and that should be your
call, reviewed by you. Say the word and I will raise one against the fork.

## How documents get there

Nobody needs server access. CI does the upload, on merge to `main`, in each project repository:

```yaml
# .github/workflows/docs.yml
- run: contrail check --index
- run: contrail deploy --target railway --audience internal --yes
- run: contrail deploy --target railway --audience client --yes
```

One **organisation-level** GitHub secret (`RAILWAY_TOKEN`, or the equivalent for your transport) covers
every project repository. Adding a project needs no new credential and no new access.

Engineers preview locally with `contrail site --out site && open site/index.html`. They never touch the
server, and they do not wait on a deploy to see their work.

## Guards already built into contrail

Because the failure modes here are public and hard to reverse:

- **Empty-build refusal.** A failed build cannot overwrite a live site with nothing.
- **Internal never reaches the client path.** The two paths must be configured and distinct; an
  internal build aimed at the client directory aborts. A mistake here would put margin figures on a
  public URL on our own domain.
- **Slug validation.** The per-project subdirectory cannot contain `..` or an absolute path.
- **`--dry-run`** prints the source, destination, file count and exact command, and uploads nothing.

## Verifying it works

Please run these and report what you see. The third is the one that matters.

1. `curl -I https://projects.8seneca.com/client/meridian/` → **200**
2. Log in to Plane, open `https://projects.8seneca.com/docs/meridian/` → **the site renders**
3. In a private window, not logged in, open the same URL → **401 or a redirect to login, never content**
4. `curl -s https://projects.8seneca.com/client/meridian/ | grep -ci "margin"` → **0**

If step 3 returns content, stop and tell me. That is the boundary this whole design exists to hold.

## Please do not

- **Commit built HTML into the Plane fork.** Every documentation edit would become a Plane deployment,
  and the repository would accumulate every client's documents.
- **Serve the internal build without authentication**, even briefly, even at an unguessable URL. Links
  get pasted into tickets and Slack.
- **Point both builds at the same directory.** contrail will refuse, but the directories should also be
  distinct in your configuration so the refusal is never the only thing standing between them.

## Open questions back to me

1. Where does `projects.8seneca.com` run — Railway, Kubernetes, Swarm, a VM?
2. Is Plane's login already going through Keycloak? If so, option (b) may replace this design.
3. Is there an existing volume or persistent path on that service, or does one need creating?
4. Do you want the Caddy change as a PR against `8seneca-hub/8seneca-projects`?

Answer 1 and 2 and I can finish the remaining work without further access.
