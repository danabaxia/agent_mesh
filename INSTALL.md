# Installing agent-mesh

`agent-mesh` is a zero-dependency Node CLI (Node **>= 20**). It ships as an npm
tarball and installs globally — no build step, no native modules.

## Quick install (from a checkout)

**macOS / Linux**
```sh
scripts/install.sh
```

**Windows (PowerShell or pwsh)**
```powershell
./scripts/install.ps1
```

Both scripts: verify Node >= 20, run the test suite (hermetic — it stubs the
`claude` binary), `npm pack` the publishable tarball, `npm install -g` it, and
verify the `agent-mesh` command resolves. Flags: `--pack` / `-Pack` to only
build the tarball, `--no-test` / `-NoTest` to skip the test gate.

## Manual install

```sh
npm pack                       # → agent-mesh-<version>.tgz (honors package.json "files")
npm install -g ./agent-mesh-*.tgz
# or, directly from the checkout:
npm install -g .
```

To distribute: copy the `.tgz` to the target machine and run
`npm i -g agent-mesh-<version>.tgz` there.

If `agent-mesh` isn't found after install, add npm's global bin to your `PATH`:
```sh
export PATH="$(npm prefix -g)/bin:$PATH"   # macOS/Linux
```

## Verify

```sh
agent-mesh --help
```

## First run

```sh
agent-mesh init-mesh ./my-mesh                 # create a mesh root
agent-mesh add ./my-mesh ./some-agent-folder   # register an agent (--apply to write)
agent-mesh doctor ./my-mesh                     # check the mesh wiring
agent-mesh dashboard ./my-mesh --allow-shell    # launch the dashboard (privileged surface on)
```

The dashboard prints a tokenized URL (`http://127.0.0.1:7077/?t=…`). The
privileged surface — native CLI launch (⌘ Terminal), session log/management,
the image proxy — is gated behind `--allow-shell` plus the per-session token and
a same-origin check. Without `--allow-shell` the board shows status only.

## Platform notes

- **macOS**: the ⌘ Terminal launcher opens iTerm (if installed) or Terminal.app.
- **Windows**: the launcher opens Windows Terminal (`wt`) if available, else a
  `cmd` window; the generated session runs under `cmd.exe` (works regardless of
  whether your default shell is PowerShell). For **do-mode** (write) delegations
  on Windows, set `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1` only after confirming
  your managed-settings policy is compatible with the path-guard (see
  `docs/superpowers/specs/2026-06-06-settings-inheritance-design.md`).

## Uninstall

```sh
npm uninstall -g agent-mesh
```
