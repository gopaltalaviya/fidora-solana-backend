/**
 * `fidora-escrow`: a refundable x402 scheme, settled through the Fidora program.
 *
 * x402 v2's `escrow` payment flow (settle before the handler AND after it,
 * with a `cancel` leg when the handler fails) mapped onto the program:
 *
 *   before-handler  the client's signed `create_job` — its money moves into
 *                   escrow, under its on-chain caps, before any work is done
 *   handler         the worker does the work
 *   after-handler   the worker's signed `accept_job` + `submit_result`, with
 *                   result_hash = sha256 of the exact response body sent back
 *   cancel          (handler failed or threw) the worker's signed
 *                   `decline_job` — the client is refunded in full, at once
 *
 * Out of band, as in x402's auth-capture custom-escrow example: the client
 * judges the result and calls `approve` (the worker is paid) or `dispute`
 * (the arbiter rules); if it stays silent, anyone may `auto_approve` after
 * the review window. The worker's bond backs delivery; reputation is written
 * by settlement.
 *
 * Every transaction is signed by an agent wallet and pays its own fee, so the
 * facilitator holds no keys and no money: it verifies and relays.
 */
import {randomBytes} from 'node:crypto';
import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentPayloadResult,
  PaymentRequirements,
  Price,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
} from '@x402/core/types';
import type {SchemeNetworkClient, SchemeNetworkFacilitator, SchemeNetworkServer} from '@x402/core/types';
import type {Keypair, Transaction} from '@solana/web3.js';
import {
  PROGRAM_ID,
  type Cluster,
  type FidoraProgram,
  coder,
  errorName,
  hex,
  ixCreateJob,
  ixJob,
  nextJobId,
  pda,
  sendAndConfirm,
  sha256,
  signedTx,
  txFromBase64,
  txToBase64,
} from '../chain/fidora.js';

export const FIDORA_ESCROW = 'fidora-escrow';
/** The asset transfer method: settled by the Fidora program. */
export const ATM = 'fidora-program';
export const DECIMALS = 6;
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

export interface EscrowExtra {
  programId: string;
  workerAgentId: string;
  acceptWindow: number;
  workWindow: number;
  paymentFlow: 'escrow';
}

/**
 * What the client puts in `payload`, and what the worker adds per settle phase.
 * x402 requires settlement enrichment to be additive (no client field may be
 * overwritten), so each phase has its own key and the facilitator reads the
 * phase from which one is present.
 */
export interface EscrowPayload {
  /** The client's signed create_job (base64): the lock. */
  transaction: string;
  jobId: number;
  clientAgentId: string;
  specHash: string;
  /** after-handler: the worker's signed accept_job + submit_result. */
  deliverTransaction?: string;
  /** after-handler: sha256 of the response body, hex. */
  resultHash?: string;
  /** cancel: the worker's signed decline_job. */
  declineTransaction?: string;
}

export type EscrowPhase = 'lock' | 'deliver' | 'decline';
/** The keys only the worker may add. A client payload carrying any of them is refused. */
const WORKER_KEYS = ['deliverTransaction', 'resultHash', 'declineTransaction'] as const;
export const clientOnly = (p: EscrowPayload): boolean => WORKER_KEYS.every((k) => p[k] === undefined);
const ONLY_THE_LOCK = "the client's payload may carry only the lock (create_job); delivery and decline are the worker's";
export const phaseOf = (p: EscrowPayload): EscrowPhase =>
  p.declineTransaction ? 'decline' : p.deliverTransaction ? 'deliver' : 'lock';

function extraOf(req: {extra?: Record<string, unknown>}): EscrowExtra {
  const e = req.extra ?? {};
  if (e['programId'] !== PROGRAM_ID.toBase58()) throw new Error(`requirements name program ${String(e['programId'])}, not Fidora ${PROGRAM_ID.toBase58()}`);
  const workerAgentId = String(e['workerAgentId'] ?? '');
  if (!/^[1-9]\d*$/.test(workerAgentId)) throw new Error('requirements.extra.workerAgentId is missing');
  return {
    programId: String(e['programId']),
    workerAgentId,
    acceptWindow: Number(e['acceptWindow'] ?? 300),
    workWindow: Number(e['workWindow'] ?? 1800),
    paymentFlow: 'escrow',
  };
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Every Fidora instruction in `tx`, decoded; anything else but compute-budget is refused. */
export function decodeFidora(tx: Transaction): {name: string; data: Record<string, any>; keys: string[]}[] {
  const out: {name: string; data: Record<string, any>; keys: string[]}[] = [];
  for (const ix of tx.instructions) {
    const prog = ix.programId.toBase58();
    if (prog === COMPUTE_BUDGET) continue;
    if (prog !== PROGRAM_ID.toBase58()) throw new Error(`instruction for ${prog}: only Fidora instructions are accepted`);
    const d = coder.instruction.decode(Buffer.from(ix.data));
    if (!d) throw new Error('an instruction does not decode against the Fidora IDL');
    const data = Object.fromEntries(Object.entries(d.data as Record<string, unknown>).map(([k, v]) => [snake(k), v]));
    out.push({name: snake(d.name), data, keys: ix.keys.map((k) => k.pubkey.toBase58())});
  }
  return out;
}

const bytes = (v: unknown) => hex(Uint8Array.from(v as number[]));

// ═════════════════════════════ client ═════════════════════════════

export class FidoraEscrowClient implements SchemeNetworkClient {
  readonly scheme = FIDORA_ESCROW;

  constructor(
    private readonly opts: {
      cluster: Cluster;
      program: FidoraProgram;
      wallet: Keypair;
      clientAgentId: bigint;
      /** Told the job id this client's lock writes: the job to judge is the one it signed, never one a response header names. */
      onLock?: (jobId: number) => void;
    },
  ) {}

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const {cluster, program, wallet, clientAgentId} = this.opts;
    if (req.network !== cluster.network) throw new Error(`requirements are for ${req.network}; this client pays on ${cluster.network}`);
    if (req.asset !== cluster.deployment.accounts.paymentMint) throw new Error(`requirements ask for ${req.asset}, not Fidora's payment token`);
    const extra = extraOf(req);
    if (req.payTo !== pda.agent(BigInt(extra.workerAgentId)).toBase58()) throw new Error('payTo is not the worker agent named in extra');
    const jobId = await nextJobId(program);
    const specHash = sha256(`${req.payTo}:${req.amount}:${randomBytes(16).toString('hex')}`);
    const ix = await ixCreateJob(program, {
      wallet: wallet.publicKey,
      clientId: clientAgentId,
      workerId: BigInt(extra.workerAgentId),
      jobId,
      amount: BigInt(req.amount),
      specHash,
      acceptWindow: extra.acceptWindow,
      workWindow: extra.workWindow,
    });
    const tx = await signedTx(cluster, wallet, [ix]);
    const payload: EscrowPayload = {
      transaction: txToBase64(tx),
      jobId,
      clientAgentId: clientAgentId.toString(),
      specHash: hex(specHash),
    };
    this.opts.onLock?.(jobId);
    return {x402Version, payload: payload as never};
  }
}

// ═════════════════════════════ resource server (the worker) ═════════════════════════════

export class FidoraEscrowServer implements SchemeNetworkServer {
  readonly scheme = FIDORA_ESCROW;
  readonly defaultAssetTransferMethod = ATM;
  readonly paymentFlows = {[ATM]: {supported: ['escrow'] as const, default: 'escrow' as const}};

  constructor(
    private readonly opts: {
      cluster: Cluster;
      program: FidoraProgram;
      /** The worker agent's wallet: signs delivery and declines. */
      workerWallet: Keypair;
      workerAgentId: bigint;
      acceptWindow?: number;
      workWindow?: number;
    },
  ) {}

  getAssetDecimals(asset: string): number | undefined {
    return asset === this.opts.cluster.deployment.accounts.paymentMint ? DECIMALS : undefined;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (network !== this.opts.cluster.network) throw new Error(`price for ${network}; this worker is on ${this.opts.cluster.network}`);
    const mint = this.opts.cluster.deployment.accounts.paymentMint;
    if (typeof price === 'object' && price !== null && 'amount' in price) {
      return {amount: String(price.amount), asset: price.asset ?? mint, extra: {}};
    }
    const m = String(price).trim().match(/^\$?(\d+(?:\.\d{1,6})?)$/);
    if (!m) throw new Error(`price ${String(price)}: use "$0.02" or {amount, asset}`);
    const [whole, frac = ''] = m[1]!.split('.');
    return {amount: (BigInt(whole!) * 10n ** BigInt(DECIMALS) + BigInt(frac.padEnd(DECIMALS, '0'))).toString(), asset: mint, extra: {}};
  }

  async enhancePaymentRequirements(req: PaymentRequirements, kind: SupportedKind): Promise<PaymentRequirements> {
    const extra: EscrowExtra = {
      programId: PROGRAM_ID.toBase58(),
      workerAgentId: this.opts.workerAgentId.toString(),
      acceptWindow: this.opts.acceptWindow ?? 300,
      workWindow: this.opts.workWindow ?? 1800,
      paymentFlow: 'escrow',
    };
    return {...req, payTo: pda.agent(this.opts.workerAgentId).toBase58(), extra: {...kind.extra, ...req.extra, ...extra}};
  }

  /** Per phase, the transaction the facilitator should relay. */
  readonly enrichSettlementPayload = async (ctx: {
    paymentPayload: {payload: Record<string, unknown>};
    requirements: {extra: Record<string, unknown>};
    phase: 'before-handler' | 'after-handler' | 'cancel';
    transportContext?: unknown;
  }): Promise<Record<string, unknown> | void> => {
    const p = ctx.paymentPayload.payload as unknown as EscrowPayload;
    if (ctx.phase === 'before-handler') {
      if (!clientOnly(p)) throw new Error(ONLY_THE_LOCK);
      return;
    }
    const {cluster, program, workerWallet, workerAgentId} = this.opts;
    const who = {signer: workerWallet.publicKey, jobId: p.jobId, clientId: BigInt(p.clientAgentId), workerId: workerAgentId};
    if (ctx.phase === 'after-handler') {
      const body = (ctx.transportContext as {responseBody?: Buffer} | undefined)?.responseBody ?? Buffer.alloc(0);
      const resultHash = sha256(body);
      const tx = await signedTx(cluster, workerWallet, [
        await ixJob(program, 'acceptJob', who),
        await ixJob(program, 'submitResult', who, resultHash),
      ]);
      return {deliverTransaction: txToBase64(tx), resultHash: hex(resultHash)};
    }
    const tx = await signedTx(cluster, workerWallet, [await ixJob(program, 'declineJob', who)]);
    return {declineTransaction: txToBase64(tx)};
  };

  /** The handler failed after the money was locked: settle a decline, which refunds the client. */
  settleOnCancel(ctx: {settledPhases: readonly string[]; requirements: unknown}): PaymentRequirements | void {
    if (!ctx.settledPhases.includes('before-handler')) return;
    return ctx.requirements as PaymentRequirements;
  }
}

// ═════════════════════════════ facilitator ═════════════════════════════

export class FidoraEscrowFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = FIDORA_ESCROW;
  readonly caipFamily = 'solana:*';

  constructor(private readonly opts: {cluster: Cluster}) {}

  getExtra(): Record<string, unknown> {
    return {programId: PROGRAM_ID.toBase58(), paymentFlow: 'escrow'};
  }

  /** The facilitator signs nothing: every transaction comes signed by an agent wallet. */
  getSigners(): string[] {
    return [];
  }

  /** Check that `payload` is exactly what `req` asks for, then simulate it. */
  async check(payload: PaymentPayload, req: PaymentRequirements): Promise<{tx: Transaction; payer: string}> {
    const c = this.opts.cluster;
    if (req.network !== c.network) throw new Error(`network ${req.network}: this facilitator settles ${c.network}`);
    if (req.asset !== c.deployment.accounts.paymentMint) throw new Error('asset is not Fidora\'s payment token');
    const extra = extraOf(req);
    const p = payload.payload as unknown as EscrowPayload;
    const phase = phaseOf(p);
    const tx = txFromBase64(phase === 'decline' ? p.declineTransaction! : phase === 'deliver' ? p.deliverTransaction! : p.transaction);
    if (!tx.verifySignatures()) throw new Error('a required signature is missing or invalid');
    const ixs = decodeFidora(tx);
    const job = pda.job(p.jobId).toBase58();
    const worker = pda.agent(BigInt(extra.workerAgentId)).toBase58();
    if (req.payTo !== worker) throw new Error('payTo is not the worker agent named in extra');
    if (phase === 'lock') {
      const [cj] = ixs;
      if (ixs.length !== 1 || cj!.name !== 'create_job') throw new Error('lock must be exactly one create_job');
      if (cj!.keys[3] !== worker) throw new Error('create_job hires another worker than payTo');
      if (cj!.keys[4] !== job) throw new Error('create_job writes another job than payload.jobId');
      if (cj!.keys[2] !== pda.agent(BigInt(p.clientAgentId)).toBase58()) throw new Error('create_job is for another client agent');
      if (String(cj!.data['amount']) !== req.amount) throw new Error(`create_job pays ${String(cj!.data['amount'])}, the quote is ${req.amount}`);
      if (bytes(cj!.data['spec_hash']) !== p.specHash) throw new Error('spec_hash differs from payload.specHash');
      // The worker sized these to the work; shorter ones make its accept_job
      // fail after the work is done.
      if (String(cj!.data['accept_window']) !== String(extra.acceptWindow)) throw new Error(`create_job sets accept_window ${String(cj!.data['accept_window'])}, the quote is ${extra.acceptWindow}`);
      if (String(cj!.data['work_window']) !== String(extra.workWindow)) throw new Error(`create_job sets work_window ${String(cj!.data['work_window'])}, the quote is ${extra.workWindow}`);
    } else if (phase === 'deliver') {
      const names = ixs.map((i) => i.name).join(',');
      if (names !== 'accept_job,submit_result') throw new Error(`deliver must be accept_job + submit_result, got ${names}`);
      for (const i of ixs) if (i.keys[2] !== job || i.keys[4] !== worker) throw new Error('deliver names another job or worker');
      if (bytes(ixs[1]!.data['result_hash']) !== p.resultHash) throw new Error('result_hash differs from payload.resultHash');
    } else {
      if (ixs.length !== 1 || ixs[0]!.name !== 'decline_job') throw new Error('decline must be exactly one decline_job');
      if (ixs[0]!.keys[2] !== job || ixs[0]!.keys[4] !== worker) throw new Error('decline names another job or worker');
    }
    // The program has the last word: caps, balance, hireability, deadlines.
    const sim = await c.connection.simulateTransaction(tx);
    if (sim.value.err) {
      const name = errorName({logs: sim.value.logs ?? []} as never);
      throw new Error(name ?? `simulation failed: ${JSON.stringify(sim.value.err)}`);
    }
    return {tx, payer: tx.feePayer!.toBase58()};
  }

  /**
   * x402 calls /verify once, on the client's own payload, before the first
   * settle. Only a lock is acceptable there: a client that slipped in a
   * worker leg would have the before-handler settle relay that instead.
   */
  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    try {
      if (!clientOnly(payload.payload as unknown as EscrowPayload)) throw new Error(ONLY_THE_LOCK);
      const {payer} = await this.check(payload, req);
      return {isValid: true, payer};
    } catch (e) {
      return {isValid: false, invalidReason: (e as Error).message};
    }
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const network = this.opts.cluster.network as Network;
    const p = payload.payload as unknown as EscrowPayload;
    try {
      const {tx, payer} = await this.check(payload, req);
      const sig = await sendAndConfirm(this.opts.cluster, tx);
      return {success: true, transaction: sig, network, payer, extra: {phase: phaseOf(p), jobId: p.jobId}};
    } catch (e) {
      return {success: false, transaction: '', network, errorReason: errorName(e) ?? (e as Error).message};
    }
  }
}
