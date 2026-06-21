# Deploying the A2A Dev-Society daemon (P1)

The daemon (`scripts/dev-society-daemon.mjs`) runs the dev roles as a **real A2A mesh** on a
machine you control, develops `approved` + `route:a2a` issues *through* the mesh, and opens PRs
that the existing GitHub-Actions Dev-mesh (review/CI/merge/curate) finishes. It **augments**, it
does not replace. Design + rationale: [`docs/superpowers/specs/2026-06-16-a2a-dev-society-design.md`](../docs/superpowers/specs/2026-06-16-a2a-dev-society-design.md).

> **Where it runs:** your laptop or a small always-on VPS (a few $/mo) — **not** GitHub
> Actions (those runners are ephemeral; a daemon can't live there). GitHub is just the
> trigger + artifact + human-merge layer.

## Versioning — trunk + release cuts
This repo is **trunk-based**: `main` is the single living line the mesh develops 24/7 (every
idea/fix/feature is merged into `main`, gated by CI + human merge). You don't deploy `main`
directly — you **cut a release** from it when it's mature enough, and deploy that:

```sh
# cut a release from the current main (pick a tag, a branch, or both):
git fetch origin && git checkout main && git pull --ff-only
git tag -a v1.0 -m "release v1.0" && git push origin v1.0      # immutable tag (recommended)
# or a release branch you can patch:  git checkout -b v1.0 main && git push -u origin v1.0
```

Deploy a **release** on your host, not a long-lived parallel branch — that avoids the
"my deployment drifts from main" gap. To **upgrade**, cut a *new* release from `main` when you
judge it ready and redeploy (`git fetch && git checkout v1.1 && restart`). The daemon always
*builds* issues against `origin/main` (so its PRs target the trunk); the release only pins the
*framework code* your host runs. This is your "release when mature" control point.

## Prerequisites (on the host)
- **Node ≥ 20** and this repo cloned.
- **`claude` CLI authenticated** (`claude --version` works headlessly) using
  OAuth/subscription auth. This repo does not use key-based Anthropic auth for
  autonomous mesh work.
- **`gh` CLI authenticated** (`gh auth status`) with push + PR rights to the repo. (A
  fine-grained PAT with `contents`+`pull-requests` works; `workflows` scope too if society
  changes may touch `.github/workflows/**`.)
- Outbound network to GitHub + the Anthropic API.

## Configure (env)
```sh
export DEV_SOCIETY_REPO=danabaxia/agent_mesh   # required (owner/repo)
export DEV_SOCIETY_POLL_MS=60000               # poll interval (default 60s)
export DEV_SOCIETY_BASE=main                   # base branch
# optional: DEV_SOCIETY_WORKROOT, DEV_SOCIETY_LEDGER, DEV_SOCIETY_TIMEOUT_MS, AGENT_MESH_CLAUDE
```

## Run
```sh
node scripts/dev-society-daemon.mjs --selftest   # no GitHub/claude — proves wiring
node scripts/dev-society-daemon.mjs --once        # process at most one task, then exit (cron-friendly)
node scripts/dev-society-daemon.mjs               # poll forever
```
Keep it alive with your process manager of choice (`systemd`, `pm2`, `tmux`, a `launchd` plist,
or a `* * * * *` cron of `--once`).

### 24/7 install (recommended)
`scripts/dev-society-install.sh` packages the always-on setup: it runs the `--selftest`, then
generates and loads the right unit for your OS — a **launchd LaunchAgent** on macOS (GUI session,
so it can reach the keychain for `gh`/`claude` OAuth) or a **systemd `--user` service** on Linux
(with lingering, so it survives logout). Both use `RunAtLoad`/`KeepAlive` (restart on crash,
start at boot). The unit is generated from detected absolute paths at install time — nothing
machine-specific is committed.

```sh
DEV_SOCIETY_REPO=danabaxia/agent_mesh scripts/dev-society-install.sh install   # daemon + daily report
scripts/dev-society-install.sh install-report  # just the daily-report schedule
scripts/dev-society-install.sh status      # state / pid
scripts/dev-society-install.sh logs        # tail .dev-society/daemon.out.log
scripts/dev-society-install.sh restart     # restart now
scripts/dev-society-install.sh uninstall   # stop + remove both units
```
`install` sets up TWO units: the always-on daemon AND a **daily report** (a calendar-scheduled
unit — launchd `StartCalendarInterval` / a systemd timer — that runs `scripts/daily-report.mjs
--post` once a day to post the PR/Issue/Token digest). Logs: `.dev-society/daemon.out.log` /
`daemon.err.log` for the daemon, `daily-report.out.log` for the report. Reads `DEV_SOCIETY_BASE`
(default `main`), `DEV_SOCIETY_POLL_MS` (default `60000`), `DAILY_REPORT_HOUR` (default `8`, local
time), and `AGENT_MESH_CLAUDE` at install time and persists them into the units.

## How to feed it work
Label an issue **`approved` + `route:a2a`** (the `route:a2a` label opts it into the A2A society;
the GitHub `backlog` worker deliberately skips `route:a2a` issues so they're never double-built).
The daemon then, for the lowest-numbered eligible issue:
1. claims it (`→ in-progress`), makes a fresh worktree off `base`;
2. **Coder agent (A2A `do`)** authors the change in the worktree (path-guard confined);
3. runs the suite (shell step); **Reviewer agent (A2A `ask`)** reviews the diff;
4. if green + changed: commits, pushes `dev-society/issue-<n>`, opens a PR (`Closes #<n>`,
   review findings in the body), and moves the label `→ pr:in-review`;
5. appends a metrics record to the ledger (`.dev-society/ledger.jsonl`).
From the PR onward the normal GitHub-Actions Dev-mesh runs (review/CI/human merge/curate).

## Monitor from your phone
- **Control** (approve/merge/comment): the **GitHub mobile app** — works anywhere, no setup.
- **Watch the live mesh** (sessions, delegation, metrics): run `agent-mesh dashboard <mesh>
  --allow-shell` on the host and reach it from your phone via **Tailscale** (`tailscale serve
  7077`) — private, no public exposure.

### Mesh Concierge — discuss + instruct + review from your phone
The **Mesh Concierge** (spec `docs/superpowers/specs/2026-06-21-mesh-mobile-concierge-design.md`)
is a private, mobile-first PWA in front of the running dashboard. From your phone you can
**discuss ideas** with an ask-only concierge agent, **deliver instructions** that land in the
evolve pipeline (it drafts a GitHub issue you file with one tap), and **review status**.

One-time setup:
1. Install Tailscale on the Mac **and** the phone, and `tailscale up` (interactive login) on each
   — both join the same private tailnet.
2. With the dashboard running on `:7077`, on the Mac run:
   ```sh
   node scripts/mesh-mobile-serve.mjs <mesh-root>
   ```
   It runs `tailscale serve --http=80 7077` (proxies the tailnet → `127.0.0.1:7077`; **no LAN/internet
   socket is opened**) and prints a one-time link `http://<your-mac>.<tailnet>.ts.net/m?t=<token>`.
   The link is `http`, not `https`: Tailscale's WireGuard layer already encrypts all tailnet traffic,
   so this is private + encrypted in transit **without** needing the tailnet's "HTTPS Certificates"
   feature (OFF by default — an `--https` serve would fail with *"does not support getting TLS certs"*
   until you enable it in the admin console). If you prefer a real `https://` URL, enable HTTPS
   Certificates + MagicDNS in the Tailscale admin console first.
3. Open that link **once** on your phone (over the tailnet), then *Add to Home Screen*.

Security: the dashboard stays bound to `127.0.0.1`; the same-origin gate accepts `*.ts.net`
MagicDNS hosts (and anything in `AGENT_MESH_DASHBOARD_ALLOWED_HOSTS`) but **still requires the
token** on every route. The concierge is **ask-only** (it cannot write the repo); the *only* write
is `gh issue create`, performed framework-side and **only on your explicit Confirm tap**, with a
fixed label allowlist (`idea` / `approved` / `route:a2a`).

## Why writes/IO are the daemon's job, not the agents' (security model, validated in P0)
- **Onward delegation is ask-only** — an agent can't delegate a *write* to a peer, so the daemon
  issues the top-level `do` to the Coder itself.
- **`do` mode has no `Bash`** and **`memory/` + trusted config are path-guard-protected** — so
  agents can't run git/gh/tests or author their own config/memory. The daemon does all trusted
  writes, GitHub I/O, and test execution. This is a deliberate safety boundary, not a workaround.

## Safety
Same-repo only; the human merge gate stands (the daemon opens PRs, never merges code); a red
suite blocks the PR and flags the issue `blocked`; every PROJECT.md invariant is enforced by the
mesh runtime the daemon drives.
