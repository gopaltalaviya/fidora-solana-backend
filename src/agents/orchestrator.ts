/**
 * The orchestrator: one goal in, agents hired over x402, every payment held
 * in Fidora's escrow until a judge says the work earned it.
 *
 *   plan      Pactora's planner prompt, over the capabilities agents offer
 *   discover  every registered agent on chain → its card (card_uri) →
 *             capability match, hireable (wallet, not frozen, staked)
 *   trust     the on-chain trust check; a `block` is left out before the
 *             model chooses, AND refused again inside x402 itself
 *             (onBeforePaymentCreation) — code, not the model, says no
 *   select    Pactora's selector prompt over protocol facts only
 *   pay       x402 `fidora-escrow`: the money is locked, the worker works,
 *             delivery is recorded with the hash of the body it sent. Before
 *             signing, the quote must be for the agent chosen, at no more
 *             than it advertised (quoteRefusal). Before judging, the body
 *             received must be the body hashed on chain (deliveryRefusal);
 *             a mismatch is disputed without asking the model. The job is
 *             the one this client's lock wrote, never one a header names
 *   judge     the tool-less judge; accept → `approve` (the worker is paid),
 *             reject → `dispute` (the arbiter rules)
 *   failure   a handler failure is refunded inside the x402 request; the
 *             orchestrator checks the refund on chain, and cancels the job
 *             itself if the money is still locked
 */
import {z} from 'zod';
import type {Keypair} from '@solana/web3.js';
import {wrapFetchWithPayment, x402Client, x402HTTPClient} from '@x402/fetch';
import {
  type Cluster,
  type FidoraProgram,
  allAgents,
  fetchAgent,
  fetchJob,
  hex,
  ixJob,
  pda,
  sendAndConfirm,
  sha256,
  signedTx,
  stateOf,
} from '../chain/fidora.js';
import type {Brain} from '../models/brain.js';
import {Judge} from '../models/judge.js';
import {PLANNER_SYSTEM, SELECTOR_SYSTEM, SYNTHESIS_SYSTEM, wrapUntrusted} from '../models/prompts.js';
import {FidoraEscrowClient} from '../x402/escrow.js';
import {type TrustReading, readTrustAll} from './trust.js';
import type {AgentCard} from './worker.js';

// ── Pactora's schemas, unchanged ─────────────────────────────────────────
export const Plan = z.object({
  subtasks: z
    .array(
      z.object({
        capability: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe('lowercase kebab-case'),
        input: z.record(z.string(), z.unknown()).describe('everything the worker needs to start'),
        dependsOn: z.number().int().min(0).optional().describe('index of an earlier subtask whose result this one needs'),
      }),
    )
    .max(4),
  reasoning: z.string().min(1).max(600),
});
export type Plan = z.infer<typeof Plan>;
export const Selection = z.object({
  agentId: z.number().int().nullable().describe('null if no candidate is worth hiring'),
  reason: z.string().min(1).max(300),
});
export const Synthesis = z.object({answer: z.string().min(1).max(2_000), confidence: z.number().min(0).max(1)});

const PLACEHOLDER = /^\s*(?:<[^<>]*>|\{\{[^{}]*\}\}|\[[^[\]]*\])\s*$/;
const REFERS_TO_RESULT = /\b(?:output|result|subtask|step|previous)\b/i;
const STEP_INDEX = /^\s*\{\{\s*\d+\s*\}\}\s*$/;
function withoutPlaceholders(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => !(typeof v === 'string' && ((PLACEHOLDER.test(v) && REFERS_TO_RESULT.test(v)) || STEP_INDEX.test(v)))),
  );
}

export type StepStatus = 'settled' | 'disputed' | 'refunded' | 'no-candidate' | 'blocked' | 'budget-exceeded' | 'failed';

export interface StepOutcome {
  capability: string;
  status: StepStatus;
  detail: string;
  agentId?: string;
  jobId?: number;
  result?: unknown;
  txs: string[];
}

export type OrchestratorEvent =
  | {kind: 'planned'; subtasks: number; reasoning: string}
  | {kind: 'discovered'; capability: string; candidates: number}
  | {kind: 'excluded'; capability: string; agentId: string; verdict: string; reason: string}
  | {kind: 'selected'; capability: string; agentId: string; price: string; reason: string}
  | {kind: 'paid'; capability: string; jobId: number; lockTx: string; deliverTx: string}
  | {kind: 'judged'; jobId: number; accept: boolean; quality: number; injectionAttempted: boolean}
  | {kind: 'settled'; jobId: number; tx: string}
  | {kind: 'disputed'; jobId: number; reason: string; tx: string}
  | {kind: 'refunded'; capability: string; jobId: number; detail: string}
  | {kind: 'skipped'; capability: string; status: StepStatus; detail: string};

export interface OrchestratorOptions {
  cluster: Cluster;
  program: FidoraProgram;
  brain: Brain;
  agentId: bigint;
  wallet: Keypair;
  /** client-side x402 ceiling per payment, base units (on top of the on-chain caps) */
  maxPerPayment: bigint;
  log?: (e: OrchestratorEvent) => void;
}

export interface Candidate {
  card: AgentCard;
  agentId: bigint;
  price: bigint;
  completed: number;
  failed: number;
  score: number;
}

const fmt = (base: bigint) => `${(Number(base) / 1e6).toString()} USDC`;

/**
 * Whether to sign this 402 quote; null means sign. Code, not the model:
 * whatever chose the worker — the selector, or a prompt injected into it —
 * the quote must be for the agent chosen, at no more than it advertised,
 * and that agent must have a trust reading that is not a block. No reading
 * at all (not a registered agent) is refused too: fail closed.
 */
export function quoteRefusal(
  q: {workerAgentId: string; amount: string},
  chosen: {agentId: bigint; price: bigint},
  trust: TrustReading | undefined,
): string | null {
  if (q.workerAgentId !== chosen.agentId.toString()) {
    return `QUOTE_MISMATCH: the 402 names agent ${q.workerAgentId}; the orchestrator chose agent ${chosen.agentId}`;
  }
  if (!/^\d+$/.test(q.amount)) return `QUOTE_MISMATCH: the 402 asks "${q.amount}", not a whole number of base units`;
  if (BigInt(q.amount) > chosen.price) {
    return `QUOTE_MISMATCH: the 402 asks ${q.amount}; agent ${chosen.agentId} advertised ${chosen.price}`;
  }
  if (!trust) return `COUNTERPARTY_BLOCKED: agent ${q.workerAgentId} has no trust reading (not a registered agent)`;
  if (trust.action === 'block') return `COUNTERPARTY_BLOCKED: agent ${q.workerAgentId} is ${trust.verdict} — ${trust.reasons[0] ?? trust.verdict}`;
  return null;
}

/**
 * Whether the response may be judged; null means judge it. The worker owns
 * its HTTP server and need not run our middleware, so the client checks for
 * itself that the bytes it received are the bytes whose sha256 the worker
 * recorded on chain — otherwise the judge would rate one answer while the
 * arbiter can only ever see the hash of another.
 */
export function deliveryRefusal(state: string, resultHash: Uint8Array | number[] | null | undefined, body: Uint8Array): string | null {
  if (state !== 'submitted') return `NOT_DELIVERED: job is ${state}, not submitted`;
  if (!resultHash) return 'NOT_DELIVERED: the job has no result hash';
  const onChain = hex(Uint8Array.from(resultHash));
  const received = hex(sha256(body));
  if (onChain !== received) return `RESULT_MISMATCH: sha256 of the body received is ${received}; the worker recorded ${onChain}`;
  return null;
}


export class Orchestrator {
  private readonly judge: Judge;
  private trust = new Map<string, TrustReading>();

  constructor(private readonly o: OrchestratorOptions) {
    this.judge = new Judge(o.brain);
  }

  private emit(e: OrchestratorEvent) {
    this.o.log?.(e);
  }

  /** Every hireable agent with a reachable card, from the chain. */
  async discover(): Promise<Candidate[]> {
    const {cluster, program} = this.o;
    const cfg = await (program.account as any).config.fetch(pda.config());
    const minStake = BigInt(cfg.params.minStake.toString());
    const out: Candidate[] = [];
    for (const a of await allAgents(program)) {
      if (a.id === this.o.agentId || !a.wallet || a.frozen) continue;
      if (a.stake.available - a.stake.locked < minStake) continue;
      if (!/^https?:\/\//.test(a.cardUri)) continue;
      let card: AgentCard;
      try {
        const r = await fetch(a.cardUri, {signal: AbortSignal.timeout(3_000)});
        if (!r.ok) continue;
        card = (await r.json()) as AgentCard;
      } catch {
        continue;
      }
      // The card is the agent's claim; the chain is the fact. They must agree.
      if (card.agentId !== a.id.toString() || card.network !== cluster.network) continue;
      const finished = Number(a.workerRecord.completed + a.workerRecord.failed);
      const score = a.workerRecord.reviews > 0n ? Number(a.workerRecord.reviewScoreSum / a.workerRecord.reviews) : 50;
      out.push({card, agentId: a.id, price: BigInt(card.price), completed: Number(a.workerRecord.completed), failed: finished - Number(a.workerRecord.completed), score});
    }
    return out;
  }

  /** The x402 client this orchestrator pays with: escrow scheme, spend ceiling, trust veto. */
  private x402(chosen: Candidate, onLock: (jobId: number) => void) {
    const {cluster, program, wallet, agentId, maxPerPayment} = this.o;
    const client = new x402Client().register(
      cluster.network as never,
      new FidoraEscrowClient({cluster, program, wallet, clientAgentId: agentId, onLock}) as never,
    );
    client.setSpendControls({
      allowedAssets: [{network: cluster.network as never, asset: cluster.deployment.accounts.paymentMint, maxAmountPerPayment: maxPerPayment.toString()}],
    });
    // The veto, inside x402, before anything is signed: whatever chose this
    // worker — the model, or a prompt injected into it — a blocked
    // counterparty is not paid.
    client.onBeforePaymentCreation(async (ctx) => {
      const req = ctx.selectedRequirements;
      const workerId = String((req.extra as {workerAgentId?: string}).workerAgentId ?? '');
      const t = (await readTrustAll(cluster, program)).get(workerId);
      const reason = quoteRefusal({workerAgentId: workerId, amount: String(req.amount)}, chosen, t);
      if (reason) return {abort: true as const, reason};
    });
    return {client, paidFetch: wrapFetchWithPayment(fetch, client), http: new x402HTTPClient(client)};
  }

  async plan(goal: string, offered: string[]): Promise<Plan> {
    const menu =
      offered.length === 0
        ? ''
        : [
            '',
            '',
            'The ONLY capabilities any agent offers are:',
            ...offered.map((c) => `  - ${c}`),
            '',
            'Use these exact strings. A capability outside this list matches no',
            'agent, so that subtask buys nothing and wastes the budget. If the',
            'goal cannot be served by these, return an empty list and say why.',
          ].join('\n');
    const {value} = await this.o.brain.complete({
      schema: Plan,
      schemaName: 'Plan',
      system: PLANNER_SYSTEM,
      prompt: `The goal:\n${goal}${menu}\n\nPlan the work.`,
      maxTokens: 1_500,
      effort: 'medium',
    });
    return value;
  }

  private async select(capability: string, candidates: Candidate[]): Promise<Candidate | null> {
    const facts = candidates.map((c) => ({
      agentId: Number(c.agentId),
      price: c.price.toString(),
      priceDisplay: fmt(c.price),
      score: c.score,
      completed: c.completed,
      failed: c.failed,
      capabilities: [c.card.capability],
    }));
    const {value} = await this.o.brain.complete({
      schema: Selection,
      schemaName: 'Selection',
      system: SELECTOR_SYSTEM,
      prompt: [`Subtask capability: ${capability}`, '', 'Candidates:', JSON.stringify(facts, null, 2), '', 'Which one, if any?'].join('\n'),
      maxTokens: 500,
      effort: 'low',
    });
    const chosen = candidates.find((c) => Number(c.agentId) === value.agentId) ?? null;
    if (chosen) this.emit({kind: 'selected', capability, agentId: chosen.agentId.toString(), price: fmt(chosen.price), reason: value.reason});
    return chosen;
  }

  /**
   * The job this client's lock wrote, or null. A job id is taken from
   * `next_job_id` when the lock is built, so if another client's lock landed
   * first the id names THEIR job: it is never this client's to judge or cancel.
   */
  private async ownJob(jobId: number) {
    const job = await fetchJob(this.o.program, jobId).catch(() => null);
    return job && job.client.toString() === this.o.agentId.toString() ? job : null;
  }

  /** Cancel a job this client locked that was never delivered: the money comes back now. */
  private async reclaim(jobId: number, workerId: bigint): Promise<{tx?: string; error?: string}> {
    const {cluster, program, wallet, agentId} = this.o;
    try {
      const ix = await ixJob(program, 'cancel', {signer: wallet.publicKey, jobId, clientId: agentId, workerId});
      return {tx: await sendAndConfirm(cluster, await signedTx(cluster, wallet, [ix]))};
    } catch (e) {
      return {error: (e as Error).message.slice(0, 300)};
    }
  }

  /** Hire one worker for one subtask, through x402, and settle it by the judge's verdict. */
  async hire(capability: string, task: Record<string, unknown>, chosen: Candidate): Promise<StepOutcome> {
    const {cluster, program, wallet, agentId} = this.o;
    // The job to settle is the one this client's own lock writes.
    let jobId: number | undefined;
    const {paidFetch, http} = this.x402(chosen, (id) => (jobId = id));
    const ids = {clientId: agentId, workerId: chosen.agentId};
    const base = {capability, agentId: chosen.agentId.toString()};
    let res: Response;
    try {
      res = await paidFetch(chosen.card.endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(task)});
    } catch (e) {
      const msg = (e as Error).message;
      const status: StepStatus =
        msg.includes('COUNTERPARTY_BLOCKED') || msg.includes('QUOTE_MISMATCH') ? 'blocked' : msg.includes('spendControls') ? 'budget-exceeded' : 'failed';
      const txs: string[] = [];
      let detail = msg;
      // Signed, and maybe relayed, before the request failed: if it is locked, take it back.
      const locked = jobId !== undefined ? await this.ownJob(jobId) : null;
      if (jobId !== undefined && locked && stateOf(locked) === 'created') {
        const r = await this.reclaim(jobId, chosen.agentId);
        if (r.tx) txs.push(r.tx);
        detail += r.tx ? `; job ${jobId} was locked, and the client cancelled it` : `; job ${jobId} is locked and cancelling failed: ${r.error}`;
      }
      this.emit({kind: 'skipped', capability, status, detail});
      return {...base, status, detail, txs};
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const body = new TextDecoder().decode(bytes);
    let settle: ReturnType<typeof http.getPaymentSettleResponse> | undefined;
    try {
      settle = http.getPaymentSettleResponse((n) => res.headers.get(n));
    } catch {
      settle = undefined;
    }
    if (jobId === undefined) {
      const detail = `HTTP ${res.status} with no escrow lock signed: nothing was paid, and nothing is judged`;
      this.emit({kind: 'skipped', capability, status: 'failed', detail});
      return {...base, status: 'failed', detail, txs: []};
    }
    const claimed = Number((settle?.extra as {jobId?: unknown} | undefined)?.jobId);
    const note = Number.isFinite(claimed) && claimed !== jobId ? ` (the response header named job ${claimed}; ignored: this client locked job ${jobId})` : '';
    const job = await this.ownJob(jobId);
    const state = job ? stateOf(job) : 'not on chain for this client';

    if (!res.ok) {
      // x402's cancel leg ran (refunded), or a leg after the lock failed and
      // the money is still locked (created): then the client cancels.
      const txs = settle?.transaction ? [settle.transaction] : [];
      let status: StepStatus = state === 'refunded' ? 'refunded' : 'failed';
      let detail = `HTTP ${res.status}; job ${jobId} is ${state} on chain${note}`;
      if (state === 'created') {
        const r = await this.reclaim(jobId, chosen.agentId);
        if (r.tx) {
          status = 'refunded';
          txs.push(r.tx);
          detail = `HTTP ${res.status}; job ${jobId} was locked but never delivered, so the client cancelled it and is refunded${note}`;
        } else {
          detail += `; cancelling it failed: ${r.error}`;
        }
      }
      if (status === 'refunded') this.emit({kind: 'refunded', capability, jobId, detail});
      return {...base, status, detail, jobId, txs};
    }

    const refusal = deliveryRefusal(state, job?.resultHash as number[] | null | undefined, bytes);
    if (refusal) {
      if (state === 'submitted') {
        // Delivered on chain, but not what was received: dispute it, no model needed.
        try {
          const ix = await ixJob(program, 'dispute', {signer: wallet.publicKey, jobId, ...ids}, sha256(refusal));
          const tx = await sendAndConfirm(cluster, await signedTx(cluster, wallet, [ix]));
          this.emit({kind: 'disputed', jobId, reason: refusal, tx});
          return {...base, status: 'disputed', detail: refusal + note, jobId, txs: [tx]};
        } catch (e) {
          return {...base, status: 'failed', detail: `${refusal}; disputing failed: ${(e as Error).message.slice(0, 300)}`, jobId, txs: []};
        }
      }
      if (state === 'created') {
        const r = await this.reclaim(jobId, chosen.agentId);
        if (r.tx) this.emit({kind: 'refunded', capability, jobId, detail: refusal});
        const detail = r.tx ? `${refusal}; the client cancelled job ${jobId}` : `${refusal}; cancelling failed: ${r.error}`;
        return {...base, status: r.tx ? 'refunded' : 'failed', detail, jobId, txs: r.tx ? [r.tx] : []};
      }
      return {...base, status: 'failed', detail: refusal + note, jobId, txs: []};
    }

    const lock = (await cluster.connection.getSignaturesForAddress(pda.job(jobId), {limit: 5}, 'confirmed')).map((s) => s.signature);
    this.emit({kind: 'paid', capability, jobId, lockTx: lock[lock.length - 1] ?? '', deliverTx: settle?.transaction ?? ''});
    let result: unknown;
    try {
      result = JSON.parse(body);
    } catch {
      result = body;
    }

    const verdict = await this.judge.evaluate({capability, task, result});
    this.emit({kind: 'judged', jobId, accept: verdict.accept, quality: verdict.quality, injectionAttempted: verdict.injectionAttempted});
    const reviewHash = sha256(JSON.stringify({accept: verdict.accept, rating: verdict.rating, reason: verdict.reason}));
    const method = verdict.accept ? 'approve' : 'dispute';
    let tx: string;
    try {
      tx = await sendAndConfirm(cluster, await signedTx(cluster, wallet, [await ixJob(program, method, {signer: wallet.publicKey, jobId, ...ids}, reviewHash)]));
    } catch (e) {
      const detail = `the judge said ${verdict.accept ? 'accept' : 'reject'}, but ${method} failed: ${(e as Error).message.slice(0, 300)}; job ${jobId} stays submitted`;
      return {...base, status: 'failed', detail, jobId, result, txs: []};
    }
    if (verdict.accept) {
      this.emit({kind: 'settled', jobId, tx});
      return {...base, status: 'settled', detail: verdict.reason + note, jobId, result, txs: [tx]};
    }
    this.emit({kind: 'disputed', jobId, reason: verdict.reason, tx});
    return {...base, status: 'disputed', detail: verdict.reason + note, jobId, result, txs: [tx]};
  }

  async run(goal: string): Promise<{plan: Plan | null; steps: StepOutcome[]; answer: string | null}> {
    const candidates = await this.discover();
    this.trust = await readTrustAll(this.o.cluster, this.o.program);
    const offered = [...new Set(candidates.map((c) => c.card.capability))].sort();
    const plan = await this.plan(goal, offered);
    this.emit({kind: 'planned', subtasks: plan.subtasks.length, reasoning: plan.reasoning});
    const me = await fetchAgent(this.o.program, this.o.agentId);

    const steps: StepOutcome[] = [];
    for (const [i, sub] of plan.subtasks.entries()) {
      const dep = sub.dependsOn !== undefined && sub.dependsOn < i ? steps[sub.dependsOn] : undefined;
      const task = dep?.result !== undefined ? {...withoutPlaceholders(sub.input), previousResult: dep.result} : sub.input;
      const pool = candidates.filter((c) => c.card.capability === sub.capability);
      this.emit({kind: 'discovered', capability: sub.capability, candidates: pool.length});
      const allowed = pool.filter((c) => {
        const t = this.trust.get(c.agentId.toString());
        if (t?.action === 'block') {
          this.emit({kind: 'excluded', capability: sub.capability, agentId: c.agentId.toString(), verdict: t.verdict, reason: t.reasons[0] ?? t.verdict});
          return false;
        }
        return c.price <= me.purse.perTaskCap;
      });
      if (allowed.length === 0) {
        const status: StepStatus = pool.length > 0 ? 'blocked' : 'no-candidate';
        const detail = pool.length > 0 ? 'every candidate is blocked or above the per-task cap' : `no agent offers ${sub.capability}`;
        this.emit({kind: 'skipped', capability: sub.capability, status, detail});
        steps.push({capability: sub.capability, status, detail, txs: []});
        continue;
      }
      const chosen = await this.select(sub.capability, allowed);
      if (!chosen) {
        steps.push({capability: sub.capability, status: 'no-candidate', detail: 'the selector hired nobody', txs: []});
        continue;
      }
      steps.push(await this.hire(sub.capability, task, chosen));
    }

    const settled = steps.filter((s) => s.status === 'settled');
    let answer: string | null = null;
    if (settled.length > 0) {
      const {value} = await this.o.brain
        .complete({
          schema: Synthesis,
          schemaName: 'Synthesis',
          system: SYNTHESIS_SYSTEM,
          prompt: [`The goal:\n${goal}`, '', 'What the agents you hired returned:', ...settled.map((s) => `\n${s.capability}:\n${wrapUntrusted(s.result)}`), '', 'Answer the goal.'].join('\n'),
          maxTokens: 2_000,
          effort: 'medium',
        })
        .catch(() => ({value: null}));
      answer = value?.answer ?? null;
    }
    return {plan, steps, answer};
  }
}
