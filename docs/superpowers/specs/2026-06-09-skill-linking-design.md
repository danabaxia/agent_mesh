# Skill Discovery, Linking & Dashboard Curation — Design

- **Date:** 2026-06-09
- **Status:** approved (design)
- **Topic:** auto-discover global Claude skills, link (not copy) them into the mesh, and curate skill membership from the dashboard

## 1. Problem & intent

A mesh today seeds skills under `<meshRoot>/mesh/skills/` (e.g. the `citation-format`
seed from [src/builder/init-mesh.js](../../../src/builder/init-mesh.js)) and gates
which skills each agent may run via the per-agent allowlist in
[src/skills-policy.js](../../../src/skills-policy.js). There is no way to bring a
user's existing **global Claude skills** (`~/.claude/skills/`) into a mesh without
hand-copying folders, and the dashboard shows skills **read-only**.

We want to:

1. **Auto-discover** all of the user's global Claude skills into a "master" list.
2. **Link** chosen skills into the mesh — a filesystem link, **never a physical copy**.
3. Make skill membership **editable from the dashboard** at two levels:
   - **mesh level:** add/remove a discovered skill to/from the mesh registered set;
   - **agent level:** add/remove a mesh-registered skill to/from each agent.

"Editable" means **curation of membership**, not editing `SKILL.md` content. No skill
file is ever written by this feature.

## 2. Scope (decided)

- **Discovery source is `~/.claude/skills/` only** — the user's personal global skills.
  Plugin skills (`~/.claude/plugins/cache/*/skills/`) and arbitrary extra roots are
  **out of scope**. The global skills root resolves as
  `(process.env.CLAUDE_CONFIG_DIR || <homedir>/.claude)/skills` so a relocated
  `~/.claude` still works.
- **Representation:** Approach A — a real filesystem **directory junction (Windows) /
  symlink (POSIX)** under `mesh/skills/<name>`, plus a provenance record in
  `mesh.json`. (Rejected: a link-free logical registry — diverges from the explicit
  "link" intent and touches every discovery site; and pure links with no record —
  unsafe delete, no provenance.)
- **No content editing**, no copy fallback, no plugin skills, no per-skill "hide from
  master" feature.

## 3. Data model — three tiers

```
~/.claude/skills/<name>/SKILL.md                ← MASTER  (auto-scanned, read-only mirror of disk)
            │   register (create link)          ─ mesh-level curation
            ▼
<meshRoot>/mesh/skills/<name> ──junction/symlink──▶ ~/.claude/skills/<name>
   mesh.json:  "meshSkills": [{ name, source, linkType }]   ← MESH REGISTERED
            │   add / remove per agent           ─ agent-level curation
            ▼
mesh.json  agents[i].skills: ["name", ...]       ← AGENT ALLOWED  (existing skills-policy)
```

Why this slots in with zero runtime change: discovery
(`discoverSkillNames`), policy (`resolveSkillPolicy` →
[delegate-invocation.js:32](../../../src/delegate-invocation.js)), the agent-context
prompt block, and the dashboard already read `mesh/skills/<name>/SKILL.md`. A junction
is indistinguishable from a real directory to `readdir`/`readFile` and to `claude`'s
own skill loader — the existing `citation-format` real-dir seed proves the path works.
`readManifest` does a plain `JSON.parse`
([manifest.js:221](../../../src/builder/manifest.js)) and validation only checks
`agents`, so a new top-level `meshSkills` field survives untouched.

## 4. Components

### 4.1 `src/skill-link.js` (new, pure-ish; fs reads/writes injectable via `io`)

- `globalSkillsRoot()` → `(process.env.CLAUDE_CONFIG_DIR || homedir()/.claude)/skills`.
- `scanGlobalSkills(io)` → `[{ name, source, summary }]` for every subdir of the global
  root that contains `SKILL.md` (summary via the existing
  `extractSkillSummary`). Read-only; reflects disk.
- `listMeshSkills(meshRoot, io)` → reads `mesh.json.meshSkills`; for each, computes
  `broken: !exists(source)`.
- `masterList(meshRoot, io)` → joins the two: scanned skills each tagged
  `registered` (present in `meshSkills`) and `broken`.
- `registerMeshSkill(meshRoot, name, io)`:
  - `isSafeSkillName(name)` (reuse from `skills-policy.js`) else reject.
  - `source = join(globalSkillsRoot(), name)` — **server-derived, never client-supplied**;
    must exist and contain `SKILL.md`.
  - If `mesh/skills/<name>` already exists and is **not** a managed link → **refuse**
    (`already_exists`) — never clobber a real/hand-authored dir.
  - Create the link: `fs.symlink(source, link, 'junction')` on Windows, `'dir'` on
    POSIX. On failure → return structured error (`link_failed`); **no copy fallback**.
  - Upsert `{ name, source, linkType }` into `mesh.json.meshSkills`. Idempotent.
- `unregisterMeshSkill(meshRoot, name, io)`:
  - Only act if `name` is in `meshSkills` **and** `lstat(link).isSymbolicLink()` — then
    remove **the link, never its target**.
  - Drop the `meshSkills` record **and prune `name` from every `agents[i].skills`** so no
    allowlist dangles.

### 4.2 Per-agent curation (reuses `skills-policy.js` semantics)

Mutates `agents[i].skills`. The three existing states must be surfaced honestly:

| `skills` field | Meaning | UI label |
|---|---|---|
| absent | inherits **all** mesh skills | "Inherit all (N)" |
| `["a","b"]` | restricted to those | "Restricted to 2" |
| `[]` | skills **disabled** | "Disabled" |

- `action:"add"` — ensure array exists, append (only a mesh-registered, safe name).
  Adding the **first** skill flips inherit-all → restricted; the UI warns on that pick.
- `action:"remove"` — remove the name. Emptying the array means **disabled**, not
  inherit-all (existing semantics).
- `action:"reset"` — **delete the `skills` field** → back to inherit-all. Distinct from
  emptying it.

### 4.3 Dashboard API (new routes in [src/dashboard/server.js](../../../src/dashboard/server.js))

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/skills/master` | — | scanned global skills + `registered`/`broken` flags |
| POST | `/api/skills/mesh` | `{name}` | register (create link + record) |
| POST | `/api/skills/mesh/remove` | `{name}` | unregister (remove link + record, prune allowlists) |
| POST | `/api/agent/<name>/skills` | `{name, action}` | `add` / `remove` / `reset` the agent allowlist |

All: validate `isSafeSkillName`, derive `source` server-side, confine writes to
`mesh/skills/` + `mesh.json`, reuse the existing POST body/JSON/error conventions, and
return the updated view-model so the frontend can re-render without a second fetch.

### 4.4 Dashboard UI ([app.js](../../../src/dashboard/public/app.js) / index.html / app.css)

On the existing **Skills board**:

- A **"Skill Library"** panel renders the master list; each row shows the skill name +
  summary and a registered ✓ toggle (**Add → mesh** / **Unlink**). A **"Link all"** bulk
  action registers every discovered skill at once (then prune); per-row add/remove is
  also available. (Decided: include **both** bulk and per-row.)
- Registered mesh skill cards get a `linked` provenance badge ("from ~/.claude/skills")
  and **broken-link** flagging when the source has vanished, with a cleanup affordance.
- **Per-agent detail** gains an add/remove control drawing from the mesh-registered set,
  plus the effective-mode indicator (§4.2) and the first-pick warning.

Follows existing card/detail patterns — no new visual language.

## 5. Security & invariants

- Reuse `isSafeSkillName` so nothing crafted reaches the `Skill(<name>)` matcher.
- The client only ever names a skill; the server computes the link **target** — no
  arbitrary-path linking.
- Never delete a link **target**; never clobber a real directory; `lstat`-guard before
  any link removal so we never recurse into the target.
- Worker confinement is unchanged: linked skills are **read-only prompt config**, the
  path-guard gates **writes** only, and agents never write skill files — so a junction
  resolving outside the mesh root is safe. It matters only to the cosmetic `/api/file`
  content viewer, which this feature does not use.
- `mesh.json` stays the single source of truth for what is managed; a real
  (non-`meshSkills`) dir under `mesh/skills/` is treated as hand-authored and is never
  auto-removed.

## 6. Testing

- `test/skill-link.test.js` (new): scan against a fake global root; `register` creates
  link + record; `unregister` removes the **link not the target** and prunes allowlists;
  collision refusal on a real dir; `link_failed` surfaces (no copy); broken-link
  detection; name sanitization. Allowlist transitions all ↔ list ↔ none ↔ reset.
- Extend `test/dashboard-server.test.js` with route tests against a temp mesh for the
  four new endpoints (happy path + bad name + collision + non-managed delete refusal).
- Cross-platform link creation: junction on Windows (the suite already runs green on
  Windows), symlink on POSIX. Hermetic — no real `~/.claude` dependency (inject the
  global root via `io`/env).

## 7. Out of scope / non-goals

- Editing `SKILL.md` content from the dashboard.
- Plugin skills and arbitrary extra scan roots (deferred; a later change could revisit a
  configurable-roots option).
- Copying skills (links only, by requirement).
- A "hide from master list" / ignore feature.
