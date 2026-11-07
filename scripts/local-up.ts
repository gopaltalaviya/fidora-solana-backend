/**
 * Everything, locally, in one command — no keys, no API quota, no devnet SOL:
 *
 *   npm run demo:local
 *
 * 1. A fresh solana-test-validator (empty ledger every run) with the Fidora
 *    program preloaded from ../fidora-solana-programs/artifacts/fidora.so,
 *    checked against its SHA256SUMS first. Native on Linux/macOS; on Windows
 *    it runs in WSL (FIDORA_WSL_DISTRO, default Ubuntu).
 * 2. `scripts/deploy.mjs --cluster localnet` in the programs repo:
 *    config, vault, and a 6-decimal test USDC.
 * 3. `scripts/demo.ts` with AGENT_MODE=cached: the committed model
 *    recordings replay, so every model call is free and repeatable.
 *
 * `npm run test:live` (--checks) runs, instead of the demo, every live check
 * that needs no model: verify-solana, the x402 smoke, the x402 attacks and
 * the sweep check (devnet test keys saved, then handed back).
 *
 * A fresh ledger matters: agent ids start at 1, which is what the
 * recordings were made with. Ends with "Demo passed." and exit code 0.
 */
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keypair} from '@solana/web3.js';
import {IDL, ROOT, programsRoot} from '../src/chain/fidora.js';

const PROGRAMS = programsRoot();
const SO = join(PROGRAMS, 'artifacts', 'fidora.so');
const RPC = 'http://127.0.0.1:8899';
const win = process.platform === 'win32';
const distro = process.env.FIDORA_WSL_DISTRO || 'Ubuntu';

function die(m: string): never {
  console.error(`✗ ${m}`);
  process.exit(2);
}
function step(title: string, cmd: string, args: string[], opts: {cwd?: string; env?: Record<string, string>} = {}) {
  console.log(`\n▸ ${title}\n  $ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, {stdio: 'inherit', shell: win, cwd: opts.cwd ?? ROOT, env: {...process.env, ...opts.env}});
  if (r.status !== 0) {
    stopValidator();
    die(`${title} failed (exit ${r.status ?? r.signal})`);
  }
}

if (!existsSync(SO)) die(`no ${SO} — clone fidora-solana-programs beside this repo, or set FIDORA_PROGRAMS_ROOT`);
const want = readFileSync(join(PROGRAMS, 'artifacts', 'SHA256SUMS'), 'utf8').split(/\s+/)[0];
const got = createHash('sha256').update(readFileSync(SO)).digest('hex');
if (got !== want) die(`artifacts/fidora.so is ${got}, SHA256SUMS says ${want}`);

const toWsl = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
const args = [
  '--reset',
  '--log',
  '--ledger',
  win ? '/tmp/fidora-ledger' : join(ROOT, '.ledger'),
  '--mint',
  Keypair.generate().publicKey.toBase58(),
  '--bind-address',
  '127.0.0.1',
  '--dynamic-port-range',
  '18000-18200',
  '--rpc-port',
  '8899',
  '--bpf-program',
  IDL.address,
  win ? toWsl(SO) : SO,
];

let validator: ChildProcess | null = null;
function stopValidator() {
  if (win) spawnSync('wsl', ['-d', distro, '--', 'pkill', '-f', 'solana-test-validator'], {stdio: 'ignore'});
  validator?.kill('SIGTERM');
}
process.on('SIGINT', () => {
  stopValidator();
  process.exit(130);
});

console.log('\n▸ a fresh local Solana validator with the Fidora program preloaded');
if (win) {
  spawnSync('wsl', ['-d', distro, '--', 'pkill', '-f', 'solana-test-validator'], {stdio: 'ignore'});
  // A launcher file, not an inline `bash -lc` string: quoting through wsl.exe
  // is fragile, and WSL ends a process whose stdin is closed — so stdin stays a pipe.
  const launcher = join(tmpdir(), 'fidora-validator.sh');
  writeFileSync(launcher, `#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
exec solana-test-validator ${args.join(' ')} > /tmp/fidora-validator.log 2>&1
`);
  validator = spawn('wsl', ['-d', distro, '--', 'bash', toWsl(launcher)], {stdio: ['pipe', 'ignore', 'ignore']});
} else {
  validator = spawn('sh', ['-c', `exec solana-test-validator ${args.join(' ')} > "${join(ROOT, '.ledger', '..', 'validator.log')}" 2>&1`], {stdio: ['pipe', 'ignore', 'ignore']});
}
validator.on('error', (e) => die(`could not start solana-test-validator: ${e.message} (install the Solana CLI: docs.anza.xyz)`));
for (let i = 0; ; i++) {
  try {
    const r = await (await fetch(RPC, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'})).json();
    if ((r as {result?: string}).result === 'ok') break;
  } catch {
    // not up yet
  }
  if (i > 90) {
    stopValidator();
    die('the validator did not answer at 127.0.0.1:8899 within 3 minutes');
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
console.log('  validator healthy at 127.0.0.1:8899');

try {
  if (!existsSync(join(PROGRAMS, 'node_modules', '@anchor-lang', 'core'))) step('programs repo tooling', 'npm', ['ci'], {cwd: PROGRAMS});
  step('initialize Fidora on the local validator', 'node', ['scripts/deploy.mjs', '--cluster', 'localnet'], {cwd: PROGRAMS});
  if (process.argv.includes('--checks')) {
    // npm run test:live — every live check, none needs a model.
    step('verify-solana: every program flow', 'node', ['scripts/verify-solana.mjs', '--cluster', 'localnet'], {cwd: PROGRAMS});
    step('x402 smoke: the escrow scheme end to end', 'npx', ['tsx', 'scripts/x402-smoke.ts']);
    step('x402 attacks: hostile workers against the orchestrator', 'npx', ['tsx', 'scripts/x402-attacks.ts']);
    step('sweep: devnet test keys are saved, then handed back', 'npx', ['tsx', 'scripts/sweep-check.ts']);
    console.log('\nAll live checks passed.');
  } else {
    step('the demo (cached models: no key, no quota)', 'npx', ['tsx', 'scripts/demo.ts', ...process.argv.slice(2)], {env: {AGENT_MODE: process.env.AGENT_MODE || 'cached'}});
  }
} finally {
  stopValidator();
}
