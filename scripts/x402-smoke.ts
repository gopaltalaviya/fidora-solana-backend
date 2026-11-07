/**
 * The fidora-escrow x402 scheme, live on a local validator, through the
 * official x402 v2 packages end to end: @x402/express on the worker,
 * @x402/fetch on the client, @x402/core's facilitator.
 *
 *   npx tsx scripts/x402-smoke.ts            (validator up, program deployed)
 *
 * Checks, against the chain: a paid call returns the resource and leaves
 * the job Submitted with result_hash = sha256(response body); approve pays
 * the worker; a call whose handler fails returns an error and the job is
 * Refunded with the client's purse back where it was.
 */
import type {AddressInfo} from 'node:net';
import express from 'express';
import {HTTPFacilitatorClient} from '@x402/core/server';
import {paymentMiddleware, x402ResourceServer} from '@x402/express';
import {wrapFetchWithPayment, x402Client, x402HTTPClient} from '@x402/fetch';
import {fetchAgent, fetchJob, hex, ixJob, openCluster, pda, programFor, sha256, stateOf, sendAndConfirm, signedTx} from '../src/chain/fidora.js';
import {deployerKey, deposit, newAgentKeys, registerAgent} from '../src/dev/accounts.js';
import {facilitatorApp} from '../src/facilitator/app.js';
import {FidoraEscrowClient, FidoraEscrowServer, FIDORA_ESCROW} from '../src/x402/escrow.js';

const ok = (m: string) => console.log(`  ✓ ${m}`);
const listen = (app: express.Express) =>
  new Promise<{url: string; close: () => void}>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r({url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close()}));
  });

const c = await openCluster('localnet');
const p = programFor(c);
const deployer = deployerKey(c);
console.log(`x402 smoke on ${c.network} (${c.rpcUrl})`);

// Agents: an orchestrator (client) and a research worker, different owners.
const ck = await newAgentKeys(c, deployer, 10_000_000n);
const wk = await newAgentKeys(c, deployer, 20_000_000n);
const clientId = await registerAgent(c, p, ck.owner, ck.wallet, 'data:,smoke-client');
const workerId = await registerAgent(c, p, wk.owner, wk.wallet, 'data:,smoke-worker');
await deposit(c, p, 'fund', ck.owner, clientId, 2_000_000n);
await deposit(c, p, 'stake', wk.owner, workerId, 11_000_000n);
ok(`agents ${clientId} (client) and ${workerId} (worker) on chain; client funded, worker staked`);

// Facilitator.
const fac = await listen(facilitatorApp(c, {log: (m) => console.log(`    [facilitator] ${m}`)}));

// Worker: an x402-protected POST /research.
const worker = express();
worker.use(express.json());
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({url: fac.url})).register(
  c.network as never,
  new FidoraEscrowServer({cluster: c, program: p, workerWallet: wk.wallet, workerAgentId: workerId}) as never,
);
worker.use(
  paymentMiddleware(
    {
      'POST /research': {
        accepts: {scheme: FIDORA_ESCROW, price: '$0.02', network: c.network as never, payTo: pda.agent(workerId).toBase58()},
        description: 'Market research on a token pair',
        mimeType: 'application/json',
      },
    },
    resourceServer,
  ),
);
worker.post('/research', (req, res) => {
  if (req.body?.fail) return void res.status(500).json({error: 'the model is down'});
  res.json({summary: `Liquidity report for ${req.body?.pair ?? 'SOL/USDC'}`, confidence: 0.8});
});
const w = await listen(worker);

// Client.
const client = new x402Client().register(c.network as never, new FidoraEscrowClient({cluster: c, program: p, wallet: ck.wallet, clientAgentId: clientId}) as never);
// The test token is not one of x402's default assets: allow it explicitly, with
// a client-side ceiling per payment (0.1 USDC) — on top of the on-chain caps.
client.setSpendControls({
  allowedAssets: [{network: c.network as never, asset: c.deployment.accounts.paymentMint, maxAmountPerPayment: '100000'}],
});
const paidFetch = wrapFetchWithPayment(fetch, client);
const http = new x402HTTPClient(client);
const post = (body: unknown) => paidFetch(`${w.url}/research`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});

try {
  // 1. unpaid → 402 with a fidora-escrow quote
  const unpaid = await fetch(`${w.url}/research`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  if (unpaid.status !== 402) throw new Error(`unpaid call: ${unpaid.status}`);
  ok('an unpaid call is answered 402 with a fidora-escrow quote');

  // 2. paid → resource; job Submitted with the body's hash
  const before = (await fetchAgent(p, clientId)).purse.balance;
  const res = await post({pair: 'SOL/USDC'});
  const text = await res.text();
  if (res.status !== 200) {
    const headers = [...res.headers.entries()].map(([k, v]) => {
      const decoded = /^payment-|^x-payment/i.test(k) ? Buffer.from(v, 'base64').toString('utf8').slice(0, 900) : v;
      return `${k}: ${decoded}`;
    });
    throw new Error(`paid call: ${res.status} ${text}\n${headers.join('\n')}`);
  }
  const settle = http.getPaymentSettleResponse((n) => res.headers.get(n));
  const jobId = Number((settle?.extra as {jobId?: number})?.jobId);
  const job = await fetchJob(p, jobId);
  if (stateOf(job) !== 'submitted') throw new Error(`job ${jobId} is ${stateOf(job)}`);
  if (hex(job.resultHash) !== hex(sha256(text))) throw new Error('result_hash is not sha256 of the body received');
  const after = (await fetchAgent(p, clientId)).purse.balance;
  if (before - after !== 20_000n) throw new Error(`client paid ${before - after}`);
  ok(`paid call answered 200; 0.02 USDC locked in escrow; job ${jobId} Submitted with result_hash = sha256(body) — ${settle?.transaction}`);

  // 3. the client's judge approves → the worker is paid
  const wBefore = (await fetchAgent(p, workerId)).purse.balance;
  const tx = await signedTx(c, ck.wallet, [await ixJob(p, 'approve', {signer: ck.wallet.publicKey, jobId, clientId, workerId}, sha256('judge: accept'))]);
  const sig = await sendAndConfirm(c, tx);
  const wAfter = (await fetchAgent(p, workerId)).purse.balance;
  if (stateOf(await fetchJob(p, jobId)) !== 'settled' || wAfter - wBefore !== 19_800n) throw new Error(`approve: worker +${wAfter - wBefore}`);
  ok(`approve: the worker is paid 0.0198 USDC (fee 0.0002) — ${sig}`);

  // 4. a call whose handler fails → refunded in the same request
  const b2 = (await fetchAgent(p, clientId)).purse.balance;
  const failed = await post({fail: true});
  await failed.text();
  if (failed.status < 400) throw new Error(`failing call answered ${failed.status}`);
  const failedJobId = (await (p.account as any).config.fetch(pda.config())).nextJobId.toNumber() - 1;
  const fj = await fetchJob(p, failedJobId);
  const a2 = (await fetchAgent(p, clientId)).purse.balance;
  if (stateOf(fj) !== 'refunded' || a2 !== b2) throw new Error(`failed call: job ${failedJobId} ${stateOf(fj)}, client ${b2} → ${a2}`);
  ok(`a call whose handler fails answers ${failed.status}; job ${failedJobId} was declined by the worker and the client refunded in full`);
  console.log('\nx402 smoke passed.');
} finally {
  w.close();
  fac.close();
}
