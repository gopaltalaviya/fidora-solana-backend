/**
 * Live check of src/dev/throwaway.ts on the local validator: a test key on a
 * public cluster is saved BEFORE it is funded, and the sweep returns every
 * lamport and its token-account rent to the deployer.
 *
 *   npx tsx scripts/sweep-check.ts      # needs the local validator (npm run test:live starts one)
 *
 * The cluster is the local validator relabelled "devnet" (keys go to a temp
 * folder), so this exercises the exact devnet code path with no devnet SOL.
 */
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type Cluster, openCluster} from '../src/chain/fidora.js';
import {deployerKey, newAgentKeys} from '../src/dev/accounts.js';
import {keysDir, sweep} from '../src/dev/throwaway.js';

const local = await openCluster('localnet');
const deployer = deployerKey(local);
const root = mkdtempSync(join(tmpdir(), 'fidora-sweep-'));
// Same connection, but named like a public cluster: keys are saved and swept.
const c = {...local, name: 'devnet'} as Cluster;
let failures = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`  ✗ ${m}`);
};

try {
  console.log(`sweep check on ${local.network} (relabelled devnet, keys in a temp folder)`);
  const keys = await newAgentKeys(c, deployer, 5_000_000n, root);
  const dir = keysDir(c, root);
  const saved = existsSync(dir) ? readdirSync(dir) : [];
  for (const kp of [keys.owner, keys.wallet]) {
    const file = `${kp.publicKey.toBase58()}-keypair.json`;
    saved.includes(file) ? ok(`key ${kp.publicKey.toBase58().slice(0, 8)}… was saved to disk (newKey writes it before returning it)`) : fail(`key ${kp.publicKey.toBase58()} was funded but never saved`);
  }
  const ownerSol = await c.connection.getBalance(keys.owner.publicKey, 'confirmed');
  const tokens = await c.connection.getParsedTokenAccountsByOwner(keys.owner.publicKey, {programId: (await import('@solana/spl-token')).TOKEN_PROGRAM_ID}, 'confirmed');
  tokens.value.length === 1 && ownerSol > 0 ? ok(`the owner holds ${ownerSol / 1e9} SOL and a test-USDC token account`) : fail(`setup: ${ownerSol} lamports, ${tokens.value.length} token accounts`);

  const before = await c.connection.getBalance(deployer.publicKey, 'confirmed');
  const back = await sweep(c, deployer, (m) => console.log(m), root);
  const after = await c.connection.getBalance(deployer.publicKey, 'confirmed');
  for (const kp of [keys.owner, keys.wallet]) {
    const left = await c.connection.getBalance(kp.publicKey, 'confirmed');
    left === 0 ? ok(`${kp.publicKey.toBase58().slice(0, 8)}… holds 0 lamports after the sweep`) : fail(`${kp.publicKey.toBase58()} still holds ${left} lamports`);
  }
  const leftTokens = await c.connection.getParsedTokenAccountsByOwner(keys.owner.publicKey, {programId: (await import('@solana/spl-token')).TOKEN_PROGRAM_ID}, 'confirmed');
  leftTokens.value.length === 0 ? ok('its token account was closed, the rent returned') : fail(`${leftTokens.value.length} token account(s) left open`);
  // The deployer gets back what was swept, less only the fees it paid (5000 lamports a signature).
  const fees = before + back - after;
  fees > 0 && fees <= 6 * 10_000 ? ok(`the deployer got back ${back / 1e9} SOL; it paid ${fees} lamports of fees`) : fail(`deployer ${before} → ${after}, swept ${back}`);
  readdirSync(dir).length === 0 ? ok('the swept keys\' files were deleted') : fail(`files left: ${readdirSync(dir).join(', ')}`);
  (await sweep(c, deployer, () => {}, root)) === 0 ? ok('a second sweep finds nothing to return') : fail('a second sweep moved funds');
} catch (e) {
  fail(`${(e as Error).stack ?? e}`);
} finally {
  rmSync(root, {recursive: true, force: true});
}
console.log(failures === 0 ? '\nsweep check passed.' : `\nsweep check FAILED: ${failures}.`);
process.exit(failures === 0 ? 0 : 1);
