/**
 * Test-network people and agents, created on chain the way a person would:
 * an owner keypair registers the agent and funds it; the agent's own wallet
 * keypair accepts. Localnet and devnet only (openCluster refuses mainnet).
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, type PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo} from '@solana/spl-token';
import {BN, type Cluster, type FidoraProgram, pda, programsRoot, sendAndConfirm} from '../chain/fidora.js';
import {newKey} from './throwaway.js';

export interface Person {
  name: string;
  keypair: Keypair;
}

export interface OnChainAgent {
  id: bigint;
  owner: Keypair;
  wallet: Keypair;
}

/** The deployer: payment-token mint authority and config owner on the test cluster. */
export function deployerKey(c: Cluster, env = process.env): Keypair {
  const path =
    c.name === 'localnet'
      ? join(programsRoot(env), '.localnet', 'deployer-keypair.json')
      : env.FIDORA_DEPLOYER_KEYPAIR;
  if (!path || !existsSync(path)) throw new Error(`no deployer keypair (${path ?? 'FIDORA_DEPLOYER_KEYPAIR unset'})`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

export async function sendSol(c: Cluster, from: Keypair, to: PublicKey, sol: number) {
  const {blockhash, lastValidBlockHeight} = await c.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({feePayer: from.publicKey, blockhash, lastValidBlockHeight}).add(
    SystemProgram.transfer({fromPubkey: from.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL)}),
  );
  tx.sign(from);
  return sendAndConfirm(c, tx);
}

export async function tokenAccount(c: Cluster, payer: Keypair, owner: PublicKey): Promise<PublicKey> {
  const mint = new (await import('@solana/web3.js')).PublicKey(c.deployment.accounts.paymentMint);
  return (await getOrCreateAssociatedTokenAccount(c.connection, payer, mint, owner)).address;
}

export async function mintTestUsdc(c: Cluster, deployer: Keypair, owner: PublicKey, amount: bigint) {
  const mint = new (await import('@solana/web3.js')).PublicKey(c.deployment.accounts.paymentMint);
  const ata = await tokenAccount(c, deployer, owner);
  await mintTo(c.connection, deployer, mint, ata, deployer, amount);
  return ata;
}

/**
 * Register an agent: the owner signs `register_agent` naming the wallet, the
 * wallet signs `accept_wallet`. Returns the on-chain id.
 */
export async function registerAgent(
  c: Cluster,
  p: FidoraProgram,
  owner: Keypair,
  wallet: Keypair,
  cardUri: string,
  caps: {perTask?: bigint; daily?: bigint} = {},
): Promise<bigint> {
  const cfg = await (p.account as any).config.fetch(pda.config());
  const id = BigInt(cfg.nextAgentId.toString());
  const reg = await (p.methods as any)
    .registerAgent(
      wallet.publicKey,
      cardUri,
      caps.perTask !== undefined ? new BN(caps.perTask.toString()) : null,
      caps.daily !== undefined ? new BN(caps.daily.toString()) : null,
    )
    .accountsPartial({owner: owner.publicKey, config: pda.config(), agent: pda.agent(id), systemProgram: SystemProgram.programId})
    .instruction();
  await sendTx(c, owner, [reg]);
  const acc = await (p.methods as any)
    .acceptWallet(new BN(id.toString()))
    .accountsPartial({wallet: wallet.publicKey, agent: pda.agent(id), index: pda.wallet(wallet.publicKey), previousIndex: null, systemProgram: SystemProgram.programId})
    .instruction();
  await sendTx(c, wallet, [acc]);
  return id;
}

export async function deposit(
  c: Cluster,
  p: FidoraProgram,
  kind: 'fund' | 'stake',
  payer: Keypair,
  agentId: bigint,
  amount: bigint,
): Promise<string> {
  const mint = new (await import('@solana/web3.js')).PublicKey(c.deployment.accounts.paymentMint);
  const from = await tokenAccount(c, payer, payer.publicKey);
  const ix = await (p.methods as any)
    [kind](new BN(amount.toString()))
    .accountsPartial({payer: payer.publicKey, config: pda.config(), agent: pda.agent(agentId), from, vault: pda.vault(), mint, tokenProgram: TOKEN_PROGRAM_ID})
    .instruction();
  return sendTx(c, payer, [ix]);
}

export async function sendTx(c: Cluster, signer: Keypair, ixs: import('@solana/web3.js').TransactionInstruction[]) {
  const {blockhash, lastValidBlockHeight} = await c.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({feePayer: signer.publicKey, blockhash, lastValidBlockHeight}).add(...ixs);
  tx.sign(signer);
  return sendAndConfirm(c, tx);
}

/**
 * A new owner and its agent's wallet, both with a little SOL, the owner with
 * test USDC. Off localnet both keys are saved before they are funded, and
 * `sweep` (src/dev/throwaway.ts) returns what they hold to the deployer.
 */
export async function newAgentKeys(c: Cluster, deployer: Keypair, usdc: bigint, keysRoot?: string): Promise<{owner: Keypair; wallet: Keypair}> {
  const owner = newKey(c, keysRoot);
  const wallet = newKey(c, keysRoot);
  await sendSol(c, deployer, owner.publicKey, c.name === 'localnet' ? 2 : 0.05);
  await sendSol(c, deployer, wallet.publicKey, c.name === 'localnet' ? 1 : 0.03);
  if (usdc > 0n) await mintTestUsdc(c, deployer, owner.publicKey, usdc);
  return {owner, wallet};
}
