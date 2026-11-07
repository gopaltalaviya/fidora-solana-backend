/**
 * The facilitator is the boundary: it must relay exactly what the quote
 * asked for and nothing else. These build real Fidora transactions offline
 * (no validator) and tamper with them; every tampered payload must be
 * refused before anything reaches the chain.
 */
import {describe, expect, it} from 'vitest';
import {Keypair, PublicKey, SystemProgram, Transaction} from '@solana/web3.js';
import type {PaymentPayload, PaymentRequirements} from '@x402/core/types';
import {type Cluster, PROGRAM_ID, ixCreateJob, ixJob, pda, sha256, hex, txToBase64} from '../src/chain/fidora.js';
import {FIDORA_ESCROW, FidoraEscrowFacilitator, FidoraEscrowServer, phaseOf} from '../src/x402/escrow.js';
import anchor from '@anchor-lang/core';
import {IDL} from '../src/chain/fidora.js';

const MINT = Keypair.generate().publicKey.toBase58();
const NETWORK = 'solana:TestNetTestNetTestNetTestNet0001';
let simulated = 0;
const cluster = {
  name: 'localnet',
  rpcUrl: 'http://unused',
  network: NETWORK,
  deployment: {cluster: 'localnet', programId: PROGRAM_ID.toBase58(), startSlot: 0, accounts: {config: '', vault: '', paymentMint: MINT, arbiter: '', owner: ''}},
  // Reaching the network means the tamper check let it through.
  connection: {simulateTransaction: async () => ((simulated++), {value: {err: null, logs: []}})},
  explorerTx: (s: string) => s,
} as unknown as Cluster;
const program = new anchor.Program(IDL, {connection: cluster.connection} as never);

const wallet = Keypair.generate();
const workerWallet = Keypair.generate();
const CLIENT = 7n;
const WORKER = 9n;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: FIDORA_ESCROW,
  network: NETWORK as never,
  asset: MINT,
  amount: '20000',
  payTo: pda.agent(WORKER).toBase58(),
  maxTimeoutSeconds: 120,
  extra: {programId: PROGRAM_ID.toBase58(), workerAgentId: WORKER.toString(), acceptWindow: 300, workWindow: 1800, paymentFlow: 'escrow'},
  ...over,
});

function sign(signer: Keypair, ixs: import('@solana/web3.js').TransactionInstruction[]) {
  const tx = new Transaction({feePayer: signer.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1}).add(...ixs);
  tx.sign(signer);
  return tx;
}

async function lockPayload(
  over: {amount?: bigint; workerId?: bigint; jobId?: number; extra?: import('@solana/web3.js').TransactionInstruction[]; signer?: Keypair; acceptWindow?: number; workWindow?: number; clientAgentId?: string; specHash?: string} = {},
) {
  const specHash = sha256('spec');
  const ix = await ixCreateJob(program as never, {
    wallet: wallet.publicKey,
    clientId: CLIENT,
    workerId: over.workerId ?? WORKER,
    jobId: over.jobId ?? 5,
    amount: over.amount ?? 20_000n,
    specHash,
    acceptWindow: over.acceptWindow ?? 300,
    workWindow: over.workWindow ?? 1800,
  });
  const tx = sign(over.signer ?? wallet, [ix, ...(over.extra ?? [])]);
  return {
    x402Version: 2,
    accepted: requirements(),
    payload: {transaction: txToBase64(tx), jobId: 5, clientAgentId: over.clientAgentId ?? CLIENT.toString(), specHash: over.specHash ?? hex(specHash)},
  } as unknown as PaymentPayload;
}

const facilitator = new FidoraEscrowFacilitator({cluster});

describe('fidora-escrow facilitator: the lock (create_job)', () => {
  it('accepts exactly what the quote asks for, and only then simulates', async () => {
    simulated = 0;
    const r = await facilitator.verify(await lockPayload(), requirements());
    expect(r).toMatchObject({isValid: true, payer: wallet.publicKey.toBase58()});
    expect(simulated).toBe(1);
  });

  const refusals: [string, () => Promise<PaymentPayload>, RegExp][] = [
    ['a lower amount than quoted', () => lockPayload({amount: 1n}), /pays 1, the quote is 20000/],
    ['another worker than payTo', () => lockPayload({workerId: 42n}), /another worker/],
    ['another job than payload.jobId', () => lockPayload({jobId: 6}), /another job/],
    [
      'an extra instruction (a SOL transfer to an attacker)',
      () => lockPayload({extra: [SystemProgram.transfer({fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1})]}),
      /only Fidora instructions/,
    ],
    // The worker sizes its windows to the work: a lock that shrinks them makes
    // accept_job fail after the work is done (the worker works for nothing).
    ['an accept window other than quoted', () => lockPayload({acceptWindow: 1}), /accept_window 1, the quote is 300/],
    ['a work window other than quoted', () => lockPayload({workWindow: 1}), /work_window 1, the quote is 1800/],
    ['a spec hash other than the payload’s', () => lockPayload({specHash: hex(sha256('other'))}), /spec_hash differs/],
    ['a client agent other than the payload’s', () => lockPayload({clientAgentId: '8'}), /another client agent/],
  ];
  for (const [what, make, reason] of refusals) {
    it(`refuses ${what}, before touching the chain`, async () => {
      simulated = 0;
      const r = await facilitator.verify(await make(), requirements());
      expect(r.isValid).toBe(false);
      expect(r.invalidReason).toMatch(reason);
      expect(simulated).toBe(0);
    });
  }

  it('refuses a transaction whose signature does not verify', async () => {
    const p = await lockPayload();
    const tx = Transaction.from(Buffer.from((p.payload as {transaction: string}).transaction, 'base64'));
    tx.signatures[0]!.signature = Buffer.alloc(64, 1);
    (p.payload as {transaction: string}).transaction = tx.serialize({verifySignatures: false}).toString('base64');
    const r = await facilitator.verify(p, requirements());
    expect(r).toMatchObject({isValid: false});
    expect(r.invalidReason).toMatch(/signature/);
  });

  it('refuses requirements for another network or another token', async () => {
    expect((await facilitator.verify(await lockPayload(), requirements({network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never}))).invalidReason).toMatch(/network/);
    expect((await facilitator.verify(await lockPayload(), requirements({asset: Keypair.generate().publicKey.toBase58()}))).invalidReason).toMatch(/payment token/);
  });

  it('refuses requirements naming another program', async () => {
    const r = await facilitator.verify(await lockPayload(), requirements({extra: {...requirements().extra, programId: new PublicKey(Keypair.generate().publicKey).toBase58()}}));
    expect(r.invalidReason).toMatch(/not Fidora/);
  });
});

describe('fidora-escrow: the worker legs (deliver, decline)', () => {
  const who = {signer: workerWallet.publicKey, jobId: 5, clientId: CLIENT, workerId: WORKER};

  it('accepts accept_job + submit_result whose hash is the payload\'s', async () => {
    const resultHash = sha256('{"summary":"..."}');
    const tx = sign(workerWallet, [await ixJob(program as never, 'acceptJob', who), await ixJob(program as never, 'submitResult', who, resultHash)]);
    const p = await lockPayload();
    Object.assign(p.payload, {deliverTransaction: txToBase64(tx), resultHash: hex(resultHash)});
    expect(phaseOf(p.payload as never)).toBe('deliver');
    await expect(facilitator.check(p, requirements())).resolves.toMatchObject({payer: workerWallet.publicKey.toBase58()});
  });

  it('refuses a delivery whose on-chain hash is not the hash of the body sent', async () => {
    const tx = sign(workerWallet, [await ixJob(program as never, 'acceptJob', who), await ixJob(program as never, 'submitResult', who, sha256('another body'))]);
    const p = await lockPayload();
    Object.assign(p.payload, {deliverTransaction: txToBase64(tx), resultHash: hex(sha256('the body sent'))});
    await expect(facilitator.check(p, requirements())).rejects.toThrow(/result_hash differs/);
  });

  it('refuses a "decline" that is really an approve', async () => {
    const tx = sign(workerWallet, [await ixJob(program as never, 'approve', who, null)]);
    const p = await lockPayload();
    Object.assign(p.payload, {declineTransaction: txToBase64(tx)});
    await expect(facilitator.check(p, requirements())).rejects.toThrow(/exactly one decline_job/);
  });
});

describe('fidora-escrow: the client may only send the lock', () => {
  const who = {signer: workerWallet.publicKey, jobId: 5, clientId: CLIENT, workerId: WORKER};
  // /verify only ever sees the client's own payload (x402 calls it once,
  // before the first settle). A client that slips a worker leg into it would
  // have the before-handler settle relay that instead of its lock.
  it('refuses a client payload that carries a delivery', async () => {
    const tx = sign(workerWallet, [await ixJob(program as never, 'acceptJob', who), await ixJob(program as never, 'submitResult', who, sha256('x'))]);
    const p = await lockPayload();
    Object.assign(p.payload, {deliverTransaction: txToBase64(tx), resultHash: hex(sha256('x'))});
    simulated = 0;
    const r = await facilitator.verify(p, requirements());
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toMatch(/only the lock/);
    expect(simulated).toBe(0);
  });

  it('refuses a client payload that carries a decline', async () => {
    const tx = sign(workerWallet, [await ixJob(program as never, 'declineJob', who)]);
    const p = await lockPayload();
    Object.assign(p.payload, {declineTransaction: txToBase64(tx)});
    const r = await facilitator.verify(p, requirements());
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toMatch(/only the lock/);
  });

  it('the worker refuses to settle a lock whose payload already carries a worker leg', async () => {
    const server = new FidoraEscrowServer({cluster, program: program as never, workerWallet, workerAgentId: WORKER});
    const p = await lockPayload();
    Object.assign(p.payload, {resultHash: hex(sha256('x'))});
    await expect(server.enrichSettlementPayload({paymentPayload: p as never, requirements: requirements() as never, phase: 'before-handler'})).rejects.toThrow(/only the lock/);
  });
});

describe('fidora-escrow server', () => {
  const server = new FidoraEscrowServer({cluster, program: program as never, workerWallet, workerAgentId: WORKER});

  it('parses "$0.02" as 20000 base units of the payment token', async () => {
    expect(await server.parsePrice('$0.02', NETWORK as never)).toEqual({amount: '20000', asset: MINT, extra: {}});
  });

  it('refuses a price for another network', async () => {
    await expect(server.parsePrice('$0.02', 'solana:other' as never)).rejects.toThrow(/this worker is on/);
  });

  it('only settles a cancel when the money was actually locked', () => {
    expect(server.settleOnCancel({settledPhases: [], requirements: requirements()})).toBeUndefined();
    expect(server.settleOnCancel({settledPhases: ['before-handler'], requirements: requirements()})).toEqual(requirements());
  });
});
