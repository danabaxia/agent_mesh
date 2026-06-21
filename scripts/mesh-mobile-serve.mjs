#!/usr/bin/env node
/**
 * mesh-mobile-serve — expose the local dashboard to your phone, privately, over
 * Tailscale, and print the one-time bootstrap link to open on the phone.
 *
 * Spec: docs/superpowers/specs/2026-06-21-mesh-mobile-concierge-design.md
 *
 * The dashboard stays bound to 127.0.0.1:7077. `tailscale serve` terminates TLS on
 * the tailnet and proxies to localhost — no socket is opened on the LAN/internet.
 * Requires Tailscale installed and `tailscale up` (interactive login) done once.
 *
 * Usage:
 *   node scripts/mesh-mobile-serve.mjs [meshRoot] [--port 7077] [--print-only]
 *
 * Exported helpers are pure so the CLI is hermetically testable.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Extract the MagicDNS hostname (trailing dot stripped) from `tailscale status --json`. */
export function resolveMagicHost(statusJson) {
  const dns = statusJson?.Self?.DNSName;
  if (typeof dns !== 'string' || !dns) return null;
  return dns.replace(/\.$/, '');
}

/** The link to open once on the phone: HTTPS MagicDNS host + the mobile page + token. */
export function bootstrapUrl(host, token) {
  return `https://${host}/m?t=${token}`;
}

/** `tailscale serve` args that proxy tailnet :443 to the local dashboard. */
export function serveArgs(port) {
  return ['serve', '--bg', '--https=443', `127.0.0.1:${port}`];
}

function readToken(meshRoot) {
  try {
    return readFileSync(join(meshRoot, '.agent-mesh', 'dashboard-token'), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Drive the flow. IO is injected so tests stay hermetic.
 * @returns {{ok:boolean, url?:string, message?:string}}
 */
export function run({
  meshRoot,
  port = 7077,
  printOnly = false,
  run: exec,          // (cmd, args) => string stdout  (throws on failure)
  loadToken = readToken,
  log = console.log,
  err = console.error
} = {}) {
  // 1. Tailscale present?
  try { exec('tailscale', ['version']); }
  catch {
    err('Tailscale is not installed. Install it, then log in once:');
    err('  brew install tailscale   # or: https://tailscale.com/download/mac');
    err('  tailscale up');
    return { ok: false, message: 'tailscale-missing' };
  }

  // 2. Logged in / up? Parse status JSON.
  let status;
  try { status = JSON.parse(exec('tailscale', ['status', '--json'])); }
  catch {
    err('Could not read Tailscale status. Is the daemon running and are you logged in?');
    err('  tailscale up');
    return { ok: false, message: 'tailscale-status' };
  }
  const backend = status?.BackendState;
  if (backend && backend !== 'Running') {
    err(`Tailscale is not connected (state: ${backend}). Run: tailscale up`);
    return { ok: false, message: 'tailscale-down' };
  }
  const host = resolveMagicHost(status);
  if (!host) {
    err('Could not determine this machine\'s MagicDNS name (enable MagicDNS in the Tailscale admin console).');
    return { ok: false, message: 'no-magicdns' };
  }

  const token = loadToken(meshRoot);
  if (!token) {
    err(`No dashboard token found under ${meshRoot}/.agent-mesh/dashboard-token — start the dashboard once first.`);
    return { ok: false, message: 'no-token' };
  }

  // 3. Start the proxy (unless print-only).
  if (!printOnly) {
    try { exec('tailscale', serveArgs(port)); }
    catch (e) {
      err(`tailscale serve failed: ${e.message}`);
      return { ok: false, message: 'serve-failed' };
    }
  }

  const url = bootstrapUrl(host, token);
  log('');
  log('  ✅ Mesh Concierge is reachable from your phone (over Tailscale):');
  log('');
  log(`     ${url}`);
  log('');
  log('  Open that link once on your phone (same tailnet), then "Add to Home Screen".');
  log('  Reminder: set AGENT_MESH_DASHBOARD_ALLOWED_HOSTS or rely on the *.ts.net default.');
  log('');
  return { ok: true, url };
}

// ---- CLI ----
function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}
if (isMain()) {
  const argv = process.argv.slice(2);
  const port = Number(argv[argv.indexOf('--port') + 1]) || 7077;
  const printOnly = argv.includes('--print-only');
  const meshRoot = argv.find((a) => !a.startsWith('--') && a !== String(port)) || process.cwd();
  const exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
  const result = run({ meshRoot, port, printOnly, run: exec });
  process.exit(result.ok ? 0 : 1);
}
