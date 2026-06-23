/**
 * Expose the local voice console to your PHONE over the tailnet, at
 *   https://<your-host>.ts.net/voice
 * ADDITIVE: mounts a /voice path; it does NOT touch the existing `/` → :7077
 * dashboard mapping. HTTPS (already enabled on the tailnet) gives the secure
 * context iOS Safari needs for the microphone.
 *
 *   node voice-demo/voice-serve.mjs          # print the exact command + URL
 *   node voice-demo/voice-serve.mjs --go     # actually run `tailscale serve`
 *
 * Stop later with:  tailscale [--socket=…] serve --https=443 --set-path=/voice off
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.VOICE_DEMO_PORT || 7099);
const userspaceSock = join(homedir(), '.tailscale-userspace', 'tailscaled.sock');
const socketArgs = existsSync(userspaceSock) ? [`--socket=${userspaceSock}`] : [];

function ts(args) {
  return execFileSync('tailscale', [...socketArgs, ...args], { encoding: 'utf8' });
}

let host = 'YOUR-HOST.ts.net';
try {
  const status = JSON.parse(ts(['status', '--json']));
  host = (status.Self?.DNSName || host).replace(/\.$/, '');
} catch { /* leave placeholder */ }

const serveArgs = ['serve', '--bg', '--https=443', '--set-path=/voice', `http://127.0.0.1:${PORT}`];
const cmd = ['tailscale', ...socketArgs, ...serveArgs].join(' ');
let token = '';
try { token = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '.voice-token'), 'utf8').trim(); } catch {}
const phoneUrl = `https://${host}/voice/?t=${token}` ;

console.log('\n  Phone voice console setup');
console.log('  -------------------------');
console.log(`  command : ${cmd}`);
console.log(`  phone   : ${phoneUrl}`);
console.log('  (HTTPS gives iOS Safari the secure context the mic needs.)\n');

if (process.argv.includes('--go')) {
  try {
    ts(serveArgs);
    console.log('  ✓ serve mapping added. Open on your phone:');
    console.log(`    ${phoneUrl}\n`);
    console.log('  Off:  tailscale ' + [...socketArgs, 'serve', '--https=443', '--set-path=/voice', 'off'].join(' ') + '\n');
  } catch (e) {
    console.error('  ✗ failed to add serve mapping:', String(e.message || e).slice(0, 300));
    console.error('  Run the command above manually, or check `tailscale serve status`.\n');
    process.exit(1);
  }
} else {
  console.log('  Dry run. Re-run with --go to apply (additive; leaves your / → :7077 alone).\n');
}
