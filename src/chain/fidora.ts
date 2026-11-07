/**
 * The one place the backend talks to the Fidora program.
 *
 * Localnet and devnet only: a mainnet RPC is refused. The x402 network id is
 * the cluster's real CAIP-2 id, `solana:<first 32 chars of the genesis
 * hash>`, read from the node — never assumed — so a local validator is
 * never labelled devnet.
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import anchor from '@anchor-lang/core';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

const {AnchorProvider, Program, BN, BorshCoder, EventParser} = anchor;
export {BN};

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const IDL = JSON.parse(readFileSync(join(ROOT, 'idl', 'fidora.json'), 'utf8'));
export const PROGRAM_ID = new PublicKey(IDL.address);
export const coder = new BorshCoder(IDL);

/** Solana devnet's CAIP-2 id (x402 docs, @x402/svm). */
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
/** Refused whatever the cluster is called: the RPC URL is no evidence, the genesis hash is. */
const PUBLIC_REFUSED: Record<string, string> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'mainnet-beta',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'testnet',
};

export type ClusterName = 'localnet' | 'devnet';

export interface Deployment {
  cluster: ClusterName;
  programId: string;
  startSlot: number;
  accounts: {config: string; vault: string; paymentMint: string; arbiter: string; owner: string};
}

export interface Cluster {
  name: ClusterName;
  rpcUrl: string;
  connection: Connection;
  /** CAIP-2, from the node's genesis hash. */
  network: string;
  deployment: Deployment;
  explorerTx(sig: string): string;
}

const DEFAULT_RPC: Record<ClusterName, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
};

/** Where the programs repo is: its deployments/<cluster>.json is the source of truth. */
export function programsRoot(env = process.env): string {
  return resolve(env.FIDORA_PROGRAMS_ROOT || join(ROOT, '..', 'fidora-solana-programs'));
}

export async function openCluster(name: ClusterName, env = process.env): Promise<Cluster> {
  if (name !== 'localnet' && name !== 'devnet') throw new Error(`cluster must be localnet or devnet, not ${name}`);
  const rpcUrl = (name === 'devnet' ? env.RPC_URL_DEVNET : env.RPC_URL_LOCALNET) ?? DEFAULT_RPC[name];
  if (/mainnet/i.test(rpcUrl)) throw new Error(`refusing ${rpcUrl}: mainnet`);
  const file = join(programsRoot(env), 'deployments', `${name}.json`);
  if (!existsSync(file)) throw new Error(`no ${file} — deploy the program first (fidora-solana-programs: scripts/deploy.mjs --cluster ${name})`);
  const deployment = JSON.parse(readFileSync(file, 'utf8')) as Deployment;
  if (deployment.programId !== PROGRAM_ID.toBase58()) {
    throw new Error(`deployment programId ${deployment.programId} differs from the IDL's ${PROGRAM_ID.toBase58()}`);
  }
  const connection = new Connection(rpcUrl, 'confirmed');
  const genesis = await connection.getGenesisHash();
  const network = `solana:${genesis.slice(0, 32)}`;
  const refused = PUBLIC_REFUSED[network];
  if (refused) throw new Error(`refusing ${rpcUrl}: its genesis hash is Solana ${refused === 'testnet' ? 'testnet' : 'mainnet'} (${refused}), and Fidora runs on localnet and devnet only`);
  if (name === 'devnet' && network !== SOLANA_DEVNET) throw new Error(`${rpcUrl} is ${network}, not devnet`);
  if (name === 'localnet' && network === SOLANA_DEVNET) throw new Error(`${rpcUrl} is devnet, not a local validator`);
  return {
    name,
    rpcUrl,
    connection,
    network,
    deployment,
    explorerTx: (sig) =>
      name === 'devnet' ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : sig,
  };
}

// ── PDAs ─────────────────────────────────────────────────────────────────

const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
export const pda = {
  config: () => PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0],
  vault: () => PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_ID)[0],
  agent: (id: number | bigint) => PublicKey.findProgramAddressSync([Buffer.from('agent'), u64le(id)], PROGRAM_ID)[0],
  job: (id: number | bigint) => PublicKey.findProgramAddressSync([Buffer.from('job'), u64le(id)], PROGRAM_ID)[0],
  wallet: (pk: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('wallet'), pk.toBuffer()], PROGRAM_ID)[0],
};

/** sha256 as the 32-byte array the program stores. */
export function sha256(data: string | Uint8Array): number[] {
  return Array.from(createHash('sha256').update(data).digest());
}
export const hex = (b: number[] | Uint8Array) => Buffer.from(b).toString('hex');

// ── the program client ───────────────────────────────────────────────────

/** A read-only Anchor client (instruction building and account decoding need no wallet). */
export function programFor(c: Cluster) {
  const readOnly = {
    publicKey: PublicKey.default,
    signTransaction: async () => {
      throw new Error('read-only client: sign with the agent wallet explicitly');
    },
    signAllTransactions: async () => {
      throw new Error('read-only client: sign with the agent wallet explicitly');
    },
  };
  return new Program(IDL, new AnchorProvider(c.connection, readOnly as never, {commitment: 'confirmed'}));
}
export type FidoraProgram = ReturnType<typeof programFor>;

export interface AgentAccount {
  id: bigint;
  owner: PublicKey;
  wallet: PublicKey | null;
  cardUri: string;
  frozen: boolean;
  purse: {balance: bigint; perTaskCap: bigint; dailyCap: bigint};
  stake: {available: bigint; locked: bigint};
  workerRecord: {completed: bigint; failed: bigint; disputesLost: bigint; unresolved: bigint; reviews: bigint; reviewScoreSum: bigint};
  clientRecord: {paid: bigint; disputesRejected: bigint; disputesUpheld: bigint; silent: bigint};
}

const big = (v: {toString(): string}) => BigInt(v.toString());

/** Decode an Agent account into plain bigints. */
export function toAgent(raw: Record<string, any>): AgentAccount {
  return {
    id: big(raw.id),
    owner: raw.owner,
    wallet: raw.wallet ?? null,
    cardUri: raw.cardUri,
    frozen: raw.frozen,
    purse: {balance: big(raw.purse.balance), perTaskCap: big(raw.purse.perTaskCap), dailyCap: big(raw.purse.dailyCap)},
    stake: {available: big(raw.stake.available), locked: big(raw.stake.locked)},
    workerRecord: Object.fromEntries(Object.entries(raw.workerRecord).map(([k, v]) => [k, big(v as never)])) as never,
    clientRecord: Object.fromEntries(Object.entries(raw.clientRecord).map(([k, v]) => [k, big(v as never)])) as never,
  };
}

export async function fetchAgent(p: FidoraProgram, id: number | bigint): Promise<AgentAccount> {
  return toAgent(await (p.account as any).agent.fetch(pda.agent(id)));
}

export async function allAgents(p: FidoraProgram): Promise<AgentAccount[]> {
  const rows = await (p.account as any).agent.all();
  return rows.map((r: {account: Record<string, unknown>}) => toAgent(r.account));
}

export async function fetchJob(p: FidoraProgram, id: number | bigint) {
  return (p.account as any).job.fetch(pda.job(id));
}

export async function nextJobId(p: FidoraProgram): Promise<number> {
  return ((await (p.account as any).config.fetch(pda.config())).nextJobId as {toNumber(): number}).toNumber();
}

/** The state name of a decoded job, e.g. "created", "settled". */
export const stateOf = (job: {state: Record<string, unknown>}) => Object.keys(job.state)[0]!;

// ── instructions ─────────────────────────────────────────────────────────

export async function ixCreateJob(
  p: FidoraProgram,
  a: {wallet: PublicKey; clientId: number | bigint; workerId: number | bigint; jobId: number; amount: bigint; specHash: number[]; acceptWindow: number; workWindow: number},
): Promise<TransactionInstruction> {
  return (p.methods as any)
    .createJob(new BN(a.amount.toString()), a.specHash, new BN(a.acceptWindow), new BN(a.workWindow))
    .accountsPartial({
      wallet: a.wallet,
      config: pda.config(),
      client: pda.agent(a.clientId),
      worker: pda.agent(a.workerId),
      job: pda.job(a.jobId),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

type JobMethod = 'acceptJob' | 'submitResult' | 'declineJob' | 'approve' | 'dispute' | 'cancel' | 'autoApprove' | 'expireUnaccepted';

export async function ixJob(
  p: FidoraProgram,
  method: JobMethod,
  a: {signer: PublicKey; jobId: number; clientId: number | bigint; workerId: number | bigint},
  ...args: unknown[]
): Promise<TransactionInstruction> {
  return (p.methods as any)
    [method](...args)
    .accountsPartial({
      signer: a.signer,
      config: pda.config(),
      job: pda.job(a.jobId),
      client: pda.agent(a.clientId),
      worker: pda.agent(a.workerId),
    })
    .instruction();
}

/** A transaction signed by `signer` alone (it is also the fee payer). */
export async function signedTx(c: Cluster, signer: Keypair, ixs: TransactionInstruction[]): Promise<Transaction> {
  const {blockhash, lastValidBlockHeight} = await c.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({feePayer: signer.publicKey, blockhash, lastValidBlockHeight}).add(...ixs);
  tx.sign(signer);
  return tx;
}

export const txToBase64 = (tx: Transaction) => tx.serialize().toString('base64');
export const txFromBase64 = (b64: string) => Transaction.from(Buffer.from(b64, 'base64'));

/**
 * Send a fully signed transaction and wait until it is confirmed; throws with
 * the program's logs on failure.
 *
 * Confirmation polls the signature's own status rather than trusting a
 * block-height window: a transaction decoded from base64 (as every x402
 * payload is) no longer carries `lastValidBlockHeight`, and a window check
 * against `undefined` reported transactions as expired that had in fact
 * landed — money locked, answer "failed". The status is the truth; expiry is
 * declared only once the blockhash itself is no longer valid AND the
 * signature is still unknown.
 */
export async function sendAndConfirm(c: Cluster, tx: Transaction, timeoutMs = 60_000): Promise<string> {
  const sig = await c.connection.sendRawTransaction(tx.serialize(), {skipPreflight: false, preflightCommitment: 'confirmed'});
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const {value} = await c.connection.getSignatureStatuses([sig], {searchTransactionHistory: false});
    const st = value[0];
    if (st?.err) {
      const t = await c.connection.getTransaction(sig, {commitment: 'confirmed', maxSupportedTransactionVersion: 0});
      throw new Error(`${sig} failed: ${JSON.stringify(st.err)} ${(t?.meta?.logMessages ?? []).join(' | ')}`);
    }
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    if (!st && tx.recentBlockhash) {
      const valid = await c.connection.isBlockhashValid(tx.recentBlockhash, {commitment: 'confirmed'});
      if (!valid.value) {
        // One last look: it may have landed in the last slot of its window.
        const again = (await c.connection.getSignatureStatuses([sig], {searchTransactionHistory: true})).value[0];
        if (!again) throw new Error(`${sig} expired: its blockhash is no longer valid and it never landed`);
        if (again.err) {
          const t = await c.connection.getTransaction(sig, {commitment: 'confirmed', maxSupportedTransactionVersion: 0});
          throw new Error(`${sig} failed: ${JSON.stringify(again.err)} ${(t?.meta?.logMessages ?? []).join(' | ')}`);
        }
        if (again.confirmationStatus === 'confirmed' || again.confirmationStatus === 'finalized') return sig;
        // Landed but not yet confirmed: keep polling, under the deadline below.
      }
    }
    if (Date.now() > deadline) throw new Error(`${sig}: not confirmed within ${timeoutMs} ms — state unknown, check the signature before retrying`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** The Fidora events a confirmed transaction emitted (Anchor "Program data:" logs). */
export async function eventsOf(c: Cluster, sig: string): Promise<{name: string; data: Record<string, any>}[]> {
  const t = await c.connection.getTransaction(sig, {commitment: 'confirmed', maxSupportedTransactionVersion: 0});
  const logs = t?.meta?.logMessages ?? [];
  return [...new EventParser(PROGRAM_ID, coder).parseLogs(logs)] as never;
}

/** Read the Anchor error name (e.g. "PerTaskCapExceeded") from a thrown error or a log list. */
export function errorName(e: unknown): string | null {
  const text = `${(e as Error)?.message ?? ''} ${((e as {logs?: string[]})?.logs ?? []).join(' ')}`;
  const m = text.match(/Error Code: (\w+)/);
  return m ? m[1]! : null;
}
