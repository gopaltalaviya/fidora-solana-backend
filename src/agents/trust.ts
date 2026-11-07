/**
 * Whether an agent's reputation deserves belief — read from the chain alone.
 *
 * The verdict rules are Pactora's (packages/db/src/trust.ts), unchanged: the
 * score counts settled jobs, and only the escrow writes one, so every review
 * cost a payment; that stops free reviews, not an owner paying itself
 * through agents it funded. So this asks what the score cannot: how many
 * DIFFERENT owners paid this worker, how much of its record the top one
 * wrote, and whether a client was funded from the worker's side before it
 * paid. On Solana the evidence is the program's own events — `Funded`
 * (who put money into which agent) and `JobSettled`/`DirectPaid` (who paid
 * whom) — so no database or indexer is needed to reach the verdict.
 */
import type {Cluster, FidoraProgram} from '../chain/fidora.js';
import {PROGRAM_ID, coder, allAgents} from '../chain/fidora.js';
import anchor from '@anchor-lang/core';

export const MIN_HISTORY = 3;
export const SELF_FUNDED_SHARE = 0.2;
export const MAX_FAIL_RATE = 0.3;
export const MIN_CLIENT_OWNERS = 3;
export const MAX_TOP_OWNER_SHARE = 0.5;

export type Verdict = 'trusted' | 'new' | 'concentrated' | 'self-funded' | 'failing';
export type TrustAction = 'allow' | 'warn' | 'block';

export interface TrustMetrics {
  settled: number;
  failed: number;
  clientOwners: number;
  topOwnerSettled: number;
  selfFunded: number;
}

export interface TrustReading {
  agentId: string;
  verdict: Verdict;
  action: TrustAction;
  reasons: string[];
  metrics: TrustMetrics;
}

export function actionOf(verdict: Verdict): TrustAction {
  if (verdict === 'trusted') return 'allow';
  if (verdict === 'new' || verdict === 'concentrated') return 'warn';
  return 'block';
}

/** The verdict and its reasons, from the numbers alone (Pactora's rules, in Pactora's order). */
export function verdictOf(m: TrustMetrics): {verdict: Verdict; reasons: string[]} {
  const finished = m.settled + m.failed;
  const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(1, d))}%`;
  if (m.selfFunded > 0 && m.selfFunded / Math.max(1, m.settled) >= SELF_FUNDED_SHARE) {
    return {
      verdict: 'self-funded',
      reasons: [
        `${m.selfFunded} of ${m.settled} paid jobs (${pct(m.selfFunded, m.settled)}) were paid by a client that had been funded from this worker's side`,
      ],
    };
  }
  if (finished < MIN_HISTORY) {
    return {verdict: 'new', reasons: [`${finished} finished job(s); at least ${MIN_HISTORY} are needed to judge`]};
  }
  if (m.failed / finished > MAX_FAIL_RATE) {
    return {verdict: 'failing', reasons: [`${m.failed} of ${finished} finished jobs (${pct(m.failed, finished)}) failed or were lost in a dispute`]};
  }
  const reasons: string[] = [];
  if (m.clientOwners < MIN_CLIENT_OWNERS) reasons.push(`paid by only ${m.clientOwners} distinct owner(s); ${MIN_CLIENT_OWNERS} or more are needed`);
  if (m.settled > 0 && m.topOwnerSettled / m.settled > MAX_TOP_OWNER_SHARE) {
    reasons.push(`one owner paid for ${m.topOwnerSettled} of ${m.settled} jobs (${pct(m.topOwnerSettled, m.settled)})`);
  }
  if (reasons.length > 0) return {verdict: 'concentrated', reasons};
  return {
    verdict: 'trusted',
    reasons: [`${m.settled} paid jobs from ${m.clientOwners} distinct owners; none self-funded; ${pct(m.failed, finished)} failed`],
  };
}

interface FundedEv {
  agentId: bigint;
  from: string;
  slot: number;
}
interface PaidEv {
  jobId: bigint;
  client: bigint;
  worker: bigint;
  slot: number;
}

/** How many program transactions one trust read examines. */
export const MAX_TRANSACTIONS = 5_000;

/**
 * Read every Fidora event since the deployment's start slot, oldest first.
 * Bounded by `maxTransactions` (newest kept) so a busy cluster cannot stall a
 * run — and `complete` says whether the bound was hit first. Anyone can push
 * old evidence out of a bounded window by flooding cheap program
 * transactions, so a partial read must never be taken for a clean record.
 */
export async function readEvents(c: Cluster, maxTransactions = MAX_TRANSACTIONS) {
  const sigs: {signature: string; slot: number}[] = [];
  let before: string | undefined;
  let complete = false;
  for (;;) {
    const page = await c.connection.getSignaturesForAddress(PROGRAM_ID, {before, limit: 1_000}, 'confirmed');
    if (page.length === 0) {
      complete = true;
      break;
    }
    for (const s of page) if (!s.err && s.slot >= c.deployment.startSlot) sigs.push({signature: s.signature, slot: s.slot});
    before = page[page.length - 1]!.signature;
    if (page[page.length - 1]!.slot < c.deployment.startSlot || page.length < 1_000) {
      complete = true;
      break;
    }
    if (sigs.length >= maxTransactions) break;
  }
  sigs.sort((a, b) => a.slot - b.slot);
  const parser = new anchor.EventParser(PROGRAM_ID, coder);
  const funded: FundedEv[] = [];
  const created = new Map<string, {client: bigint; worker: bigint}>();
  const paid: PaidEv[] = [];
  for (let i = 0; i < sigs.length; i += 50) {
    const batch = sigs.slice(i, i + 50);
    const txs = await c.connection.getTransactions(
      batch.map((s) => s.signature),
      {commitment: 'confirmed', maxSupportedTransactionVersion: 0},
    );
    txs.forEach((t, j) => {
      const slot = batch[j]!.slot;
      for (const e of parser.parseLogs(t?.meta?.logMessages ?? [])) {
        // Event fields arrive as the IDL names them (snake_case); accept either form.
        const raw = e.data as Record<string, any>;
        const d = new Proxy(raw, {get: (o, k: string) => o[k] ?? o[k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)]});
        if (e.name === 'Funded' || e.name === 'funded') {
          if (Number(d.kind) === 0) funded.push({agentId: BigInt(d.agentId.toString()), from: d.from.toBase58(), slot});
        } else if (e.name === 'JobCreated' || e.name === 'jobCreated') {
          created.set(d.jobId.toString(), {client: BigInt(d.client.toString()), worker: BigInt(d.worker.toString())});
        } else if (e.name === 'DirectPaid' || e.name === 'directPaid') {
          paid.push({jobId: BigInt(d.jobId.toString()), client: BigInt(d.client.toString()), worker: BigInt(d.worker.toString()), slot});
        } else if (e.name === 'JobSettled' || e.name === 'jobSettled') {
          const k = d.jobId.toString();
          const cr = created.get(k);
          if (cr && !paid.some((p) => p.jobId.toString() === k)) paid.push({jobId: BigInt(k), client: cr.client, worker: cr.worker, slot});
        }
      }
    });
  }
  return {funded, paid, complete};
}

/** A reading made from a partial history: whatever the numbers say, the agent is not cleared. */
export function incompleteReading(r: TrustReading, maxTransactions: number): TrustReading {
  return {
    ...r,
    action: 'block',
    reasons: [
      `only the newest ${maxTransactions} program transactions could be read, so this record may be missing evidence (a self-funding client, say); no agent is cleared on partial evidence`,
      ...r.reasons,
    ],
  };
}

/** The trust reading of every agent, from one pass over the chain. */
export async function readTrustAll(c: Cluster, p: FidoraProgram): Promise<Map<string, TrustReading>> {
  const agents = await allAgents(p);
  const byId = new Map(agents.map((a) => [a.id.toString(), a]));
  const {funded, paid, complete} = await readEvents(c);
  const out = new Map<string, TrustReading>();
  for (const w of agents) {
    // The worker's side: its owner, and every wallet of an agent the same owner registered.
    const side = new Set<string>([w.owner.toBase58()]);
    for (const a of agents) if (a.owner.equals(w.owner) && a.wallet) side.add(a.wallet.toBase58());
    const mine = paid.filter((x) => x.worker === w.id);
    const owners = new Map<string, number>();
    let selfFunded = 0;
    for (const x of mine) {
      const client = byId.get(x.client.toString());
      const owner = client?.owner.toBase58() ?? `agent:${x.client}`;
      owners.set(owner, (owners.get(owner) ?? 0) + 1);
      if (funded.some((f) => f.agentId === x.client && side.has(f.from) && f.slot <= x.slot)) selfFunded++;
    }
    const failed = Number(w.workerRecord.failed + w.workerRecord.disputesLost);
    const metrics: TrustMetrics = {
      settled: mine.length,
      failed,
      clientOwners: owners.size,
      topOwnerSettled: Math.max(0, ...owners.values()),
      selfFunded,
    };
    const v = verdictOf(metrics);
    const reading: TrustReading = {agentId: w.id.toString(), ...v, action: actionOf(v.verdict), metrics};
    out.set(w.id.toString(), complete ? reading : incompleteReading(reading, MAX_TRANSACTIONS));
  }
  return out;
}
