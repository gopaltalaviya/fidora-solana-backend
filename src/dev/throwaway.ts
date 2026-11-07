/**
 * Throwaway test keys, with no SOL stranded on a key nobody holds.
 *
 * On localnet a key is just generated. On any other cluster every key is first
 * written to `.keys/<cluster>/<pubkey>-keypair.json` (gitignored), BEFORE any
 * SOL is sent to it. `sweep` later returns everything it holds to the
 * deployer, which is your own wallet:
 *   - each token account is emptied (burned: it is test USDC) and closed, so its
 *     rent comes back too;
 *   - then every lamport is sent back.
 * The deployer pays the fees. A key's file is deleted once its balance is zero.
 */
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID, createBurnInstruction, createCloseAccountInstruction} from '@solana/spl-token';
import {ROOT, type Cluster} from '../chain/fidora.js';

export const keysDir = (c: Pick<Cluster, 'name'>, root = ROOT) => join(root, '.keys', c.name);

/** A new keypair; on any cluster but localnet it is saved before it is returned. */
export function newKey(c: Pick<Cluster, 'name'>, root = ROOT): Keypair {
  const kp = Keypair.generate();
  if (c.name !== 'localnet') {
    const dir = keysDir(c, root);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, `${kp.publicKey.toBase58()}-keypair.json`), JSON.stringify(Array.from(kp.secretKey)), {mode: 0o600});
  }
  return kp;
}

async function send(c: Cluster, payer: Keypair, signers: Keypair[], ixs: TransactionInstruction[]) {
  const {blockhash, lastValidBlockHeight} = await c.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({feePayer: payer.publicKey, blockhash, lastValidBlockHeight}).add(...ixs);
  tx.sign(payer, ...signers);
  const sig = await c.connection.sendRawTransaction(tx.serialize());
  await c.connection.confirmTransaction({signature: sig, blockhash, lastValidBlockHeight}, 'confirmed');
  return sig;
}

/** Return what one key holds to `to` (which also pays the fees). Answers the lamports returned. */
export async function sweepKey(c: Cluster, kp: Keypair, to: Keypair): Promise<number> {
  const owner = kp.publicKey;
  let back = 0;
  const tokens = await c.connection.getParsedTokenAccountsByOwner(owner, {programId: TOKEN_PROGRAM_ID}, 'confirmed');
  for (const {pubkey, account} of tokens.value) {
    const info = (account.data as {parsed: {info: {mint: string; tokenAmount: {amount: string}}}}).parsed.info;
    const amount = BigInt(info.tokenAmount.amount);
    const ixs: TransactionInstruction[] = [];
    if (amount > 0n) ixs.push(createBurnInstruction(pubkey, new PublicKey(info.mint), owner, amount));
    ixs.push(createCloseAccountInstruction(pubkey, to.publicKey, owner));
    await send(c, to, [kp], ixs);
    back += account.lamports;
  }
  const lamports = await c.connection.getBalance(owner, 'confirmed');
  if (lamports > 0) {
    await send(c, to, [kp], [SystemProgram.transfer({fromPubkey: owner, toPubkey: to.publicKey, lamports})]);
    back += lamports;
  }
  return back;
}

/** Sweep every saved key of this cluster back to `to`. Safe to run again. */
export async function sweep(c: Cluster, to: Keypair, log: (m: string) => void = console.log, root = ROOT): Promise<number> {
  if (c.name === 'localnet') return 0;
  const dir = keysDir(c, root);
  if (!existsSync(dir)) return 0;
  let total = 0;
  let n = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('-keypair.json'))) {
    const file = join(dir, f);
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
    try {
      total += await sweepKey(c, kp, to);
      if ((await c.connection.getBalance(kp.publicKey, 'confirmed')) === 0) rmSync(file);
      n++;
    } catch (e) {
      log(`  ! ${kp.publicKey.toBase58()} not swept (its key stays in ${dir}): ${String((e as Error).message ?? e).slice(0, 200)}`);
    }
  }
  if (n) log(`  swept ${n} test key(s): ${total / 1e9} SOL back to ${to.publicKey.toBase58()}`);
  return total;
}
