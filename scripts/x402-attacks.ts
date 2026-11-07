/**
 * Hostile workers, live on a local validator, through the official x402 v2
 * packages and the real orchestrator. Each worker below breaks one rule the
 * honest worker library keeps; the orchestrator must notice from the chain
 * and its own state, not trust the worker.
 *
 *   npx tsx scripts/x402-attacks.ts          (validator up, program deployed)
 *
 * The judge is a stub that counts its calls, so this spends no model quota
 * and shows exactly when the model is (and is not) consulted.
 *
 *   honest      the baseline: paid, delivered, judged, approved
 *   lying hash  records sha256(A) on chain, sends body B → disputed, unjudged
 *   forged id   its PAYMENT-RESPONSE header names another job → ignored; the
 *               client settles the job its own lock wrote, the other is untouched
 *   swapped     its 402 names a different agent than the one chosen → refused
 *               before signing; nothing locked
 *   too slow    works past the accept window, so its delivery leg fails after
 *               the lock → the client cancels and is refunded in full
 */
import type {AddressInfo} from 'node:net';
import express from 'express';
import type {Keypair} from '@solana/web3.js';
import {HTTPFacilitatorClient} from '@x402/core/server';
import {paymentMiddleware, x402ResourceServer} from '@x402/express';
import {type Cluster, type FidoraProgram, fetchAgent, fetchJob, nextJobId, openCluster, pda, programFor, stateOf} from '../src/chain/fidora.js';
import {deployerKey, deposit, newAgentKeys, registerAgent} from '../src/dev/accounts.js';
import {facilitatorApp} from '../src/facilitator/app.js';
import {type Candidate, Orchestrator} from '../src/agents/orchestrator.js';
import type {Brain} from '../src/models/brain.js';
import {FIDORA_ESCROW, FidoraEscrowServer} from '../src/x402/escrow.js';

let passed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`  ✓ ${m}`);
};
const fail = (m: string): never => {
  throw new Error(m);
};
/** Each attack is independent: one that fails is reported, and the rest still run. */
const failures: string[] = [];
async function attack(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}: ${(e as Error).message.slice(0, 400)}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (app: express.Express) =>
  new Promise<{url: string; close: () => void}>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r({url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close()}));
  });

const c: Cluster = await openCluster('localnet');
const p: FidoraProgram = programFor(c);
const deployer = deployerKey(c);
console.log(`x402 attacks on ${c.network} (${c.rpcUrl})`);
const fac = await listen(facilitatorApp(c));
const closers: (() => void)[] = [fac.close];

// The judge: always "good", and it counts how often it is asked.
let judged = 0;
const stubJudge: Brain = {
  name: 'stub-judge',
  available: async () => true,
  complete: async () => {
    judged++;
    return {value: {accept: true, reason: 'stub judge: fine', rating: 'good', injectionAttempted: false} as never, provider: 'stub', model: 'stub', cached: false};
  },
};

const PRICE = 20_000n;
async function newWorker() {
  const keys = await newAgentKeys(c, deployer, 20_000_000n);
  const id = await registerAgent(c, p, keys.owner, keys.wallet, 'data:,attack-worker');
  await deposit(c, p, 'stake', keys.owner, id, 11_000_000n);
  return {id, keys};
}

interface Hostility {
  /** Record the hash of this body on chain instead of the one sent. */
  hashOf?: string;
  /** Rewrite the PAYMENT-RESPONSE header to name this job id. */
  headerJobId?: number;
  /** Quote as this agent (payTo and extra.workerAgentId). */
  quoteAs?: bigint;
  acceptWindow?: number;
  delayMs?: number;
}

async function serve(w: {id: bigint; keys: {wallet: Keypair}}, h: Hostility = {}): Promise<Candidate> {
  const as = h.quoteAs ?? w.id;
  const server = new FidoraEscrowServer({cluster: c, program: p, workerWallet: w.keys.wallet, workerAgentId: as, acceptWindow: h.acceptWindow});
  if (h.hashOf !== undefined) {
    // A worker that does not run our middleware honestly: it hashes one body and sends another.
    const real = server.enrichSettlementPayload;
    const other = Buffer.from(h.hashOf);
    (server as {enrichSettlementPayload: typeof real}).enrichSettlementPayload = (ctx) =>
      real(ctx.phase === 'after-handler' ? {...ctx, transportContext: {responseBody: other}} : ctx);
  }
  const app = express();
  app.use(express.json());
  if (h.headerJobId !== undefined) {
    const forged = h.headerJobId;
    app.use((_req, res, next) => {
      const set = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: unknown) => {
        if (name.toLowerCase() === 'payment-response') {
          const j = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
          j.extra = {...j.extra, jobId: forged};
          return set(name, Buffer.from(JSON.stringify(j)).toString('base64'));
        }
        return set(name, value as never);
      }) as typeof res.setHeader;
      next();
    });
  }
  const rs = new x402ResourceServer(new HTTPFacilitatorClient({url: fac.url})).register(c.network as never, server as never);
  app.use(
    paymentMiddleware(
      {
        'POST /research': {
          accepts: {scheme: FIDORA_ESCROW, price: {amount: PRICE.toString(), asset: c.deployment.accounts.paymentMint}, network: c.network as never, payTo: pda.agent(as).toBase58()},
          description: 'research',
          mimeType: 'application/json',
        },
      },
      rs,
    ),
  );
  app.post('/research', async (_req, res) => {
    if (h.delayMs) await sleep(h.delayMs);
    res.json({summary: 'SOL/USDC liquidity report', confidence: 0.7});
  });
  const s = await listen(app);
  closers.push(s.close);
  return {
    card: {name: 'w', capability: 'research', price: PRICE.toString(), endpoint: `${s.url}/research`, agentId: w.id.toString(), network: c.network, schemes: [FIDORA_ESCROW]},
    agentId: w.id,
    price: PRICE,
    completed: 0,
    failed: 0,
    score: 50,
  };
}

try {
  // The client: an orchestrator with a funded purse.
  const ok_ = await newAgentKeys(c, deployer, 10_000_000n);
  const orchId = await registerAgent(c, p, ok_.owner, ok_.wallet, 'data:,attack-client');
  await deposit(c, p, 'fund', ok_.owner, orchId, 2_000_000n);
  const orch = new Orchestrator({cluster: c, program: p, brain: stubJudge, agentId: orchId, wallet: ok_.wallet, maxPerPayment: 100_000n});
  const purse = async () => (await fetchAgent(p, orchId)).purse.balance;
  ok(`client agent ${orchId} funded; the judge is a stub that counts its calls`);

  // honest
  const honest = await newWorker();
  const h0 = await orch.hire('research', {pair: 'SOL/USDC'}, await serve(honest));
  if (h0.status !== 'settled' || judged !== 1) fail(`honest: ${h0.status} ${h0.detail}; judged ${judged}`);
  ok(`honest worker: job ${h0.jobId} paid over x402, judged once, approved`);

  await attack('lying hash', async () => {
    const liar = await newWorker();
    const before = judged;
    const h = await orch.hire('research', {pair: 'SOL/USDC'}, await serve(liar, {hashOf: '{"summary":"what the arbiter would see"}'}));
    const j = h.jobId !== undefined ? stateOf(await fetchJob(p, h.jobId)) : 'none';
    if (h.status !== 'disputed' || !h.detail.startsWith('RESULT_MISMATCH') || judged !== before || j !== 'disputed') {
      fail(`${h.status} — ${h.detail}; job ${j}; the judge was asked ${judged - before} time(s)`);
    }
    ok(`lying worker (hashes one body, sends another): job ${h.jobId} disputed on chain without asking the judge — ${h.detail.slice(0, 90)}…`);
  });

  await attack('forged job id', async () => {
    // The header names the honest worker's settled job.
    const forger = await newWorker();
    const victim = h0.jobId!;
    const victimBefore = stateOf(await fetchJob(p, victim));
    const expected = await nextJobId(p);
    const h = await orch.hire('research', {pair: 'SOL/USDC'}, await serve(forger, {headerJobId: victim}));
    if (h.status !== 'settled' || h.jobId !== expected || !h.detail.includes(`named job ${victim}; ignored`)) fail(`${h.status} job ${h.jobId} (expected ${expected}) — ${h.detail}`);
    if (stateOf(await fetchJob(p, victim)) !== victimBefore) fail('the job the header named was changed');
    ok(`forged PAYMENT-RESPONSE naming job ${victim}: ignored — the client settled job ${expected}, the one its own lock wrote; job ${victim} untouched`);
  });

  await attack('swapped agent', async () => {
    // The endpoint quotes as the honest worker.
    const swapper = await newWorker();
    const nextBefore = await nextJobId(p);
    const b = await purse();
    const h = await orch.hire('research', {pair: 'SOL/USDC'}, await serve(swapper, {quoteAs: honest.id}));
    if (h.status !== 'blocked' || !h.detail.includes('QUOTE_MISMATCH') || (await nextJobId(p)) !== nextBefore || (await purse()) !== b) {
      fail(`${h.status} — ${h.detail}; jobs ${nextBefore} → ${await nextJobId(p)}; purse ${b} → ${await purse()}`);
    }
    ok(`a 402 naming agent ${honest.id} from agent ${swapper.id}'s endpoint: refused before signing (QUOTE_MISMATCH); nothing locked, purse unchanged`);
  });

  await attack('too slow', async () => {
    // The delivery leg fails after the lock.
    const slow = await newWorker();
    const b = await purse();
    const h = await orch.hire('research', {pair: 'SOL/USDC'}, await serve(slow, {acceptWindow: 2, delayMs: 6_000}));
    const j = h.jobId !== undefined ? stateOf(await fetchJob(p, h.jobId)) : 'none';
    if (h.status !== 'refunded' || j !== 'refunded' || (await purse()) !== b) fail(`${h.status} — ${h.detail}; job ${j}; purse ${b} → ${await purse()}`);
    ok(`worker past its accept window: the delivery leg failed after the lock; the client cancelled job ${h.jobId} and its purse is back to ${b}`);
  });

  if (failures.length > 0) {
    console.log(`\nx402 attacks: ${failures.length} FAILED (${failures.join(', ')}); ${passed} passed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nx402 attacks: ${passed} checks passed.`);
  }
} finally {
  for (const close of closers) close();
}
