/**
 * A Fidora worker: one capability, sold over HTTP x402.
 *
 *   GET  /agent.json      its card — the agent's on-chain card_uri points here
 *   POST /<capability>    x402-protected: pay with fidora-escrow, get the work
 *
 * The work is produced to a schema by the worker's model (the earlier edition's
 * worker prompt, unchanged). If the model cannot produce it, the handler answers
 * 500 — and x402's cancel leg has the worker decline on chain, so the
 * payer is refunded in the same request. The worker never holds the
 * client's money: it is in the program's escrow until the client approves.
 */
import type {AddressInfo} from 'node:net';
import express from 'express';
import type {z} from 'zod';
import {HTTPFacilitatorClient} from '@x402/core/server';
import {paymentMiddleware, x402ResourceServer} from '@x402/express';
import type {Keypair} from '@solana/web3.js';
import {type Cluster, type FidoraProgram, pda} from '../chain/fidora.js';
import type {Brain} from '../models/brain.js';
import {WORKER_SYSTEM, wrapUntrusted} from '../models/prompts.js';
import {FIDORA_ESCROW, FidoraEscrowServer} from '../x402/escrow.js';

export interface AgentCard {
  name: string;
  capability: string;
  /** base units of the payment token */
  price: string;
  endpoint: string;
  agentId: string;
  network: string;
  schemes: string[];
}

export interface WorkerOptions<T> {
  cluster: Cluster;
  program: FidoraProgram;
  facilitatorUrl: string;
  agentId: bigint;
  wallet: Keypair;
  name: string;
  capability: string;
  role: string;
  output: z.ZodType<T>;
  /** base units */
  price: bigint;
  brain: Brain;
  log?: (m: string) => void;
}

export interface RunningWorker {
  url: string;
  card: AgentCard;
  close(): void;
}

export async function startWorker<T>(o: WorkerOptions<T>, port = 0): Promise<RunningWorker> {
  const log = o.log ?? (() => {});
  const app = express();
  app.use(express.json({limit: '64kb'}));

  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const card: AgentCard = {
    name: o.name,
    capability: o.capability,
    price: o.price.toString(),
    endpoint: `${url}/${o.capability}`,
    agentId: o.agentId.toString(),
    network: o.cluster.network,
    schemes: [FIDORA_ESCROW],
  };
  app.get('/agent.json', (_req, res) => res.json(card));

  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({url: o.facilitatorUrl})).register(
    o.cluster.network as never,
    new FidoraEscrowServer({cluster: o.cluster, program: o.program, workerWallet: o.wallet, workerAgentId: o.agentId}) as never,
  );
  app.use(
    paymentMiddleware(
      {
        [`POST /${o.capability}`]: {
          accepts: {
            scheme: FIDORA_ESCROW,
            price: {amount: o.price.toString(), asset: o.cluster.deployment.accounts.paymentMint},
            network: o.cluster.network as never,
            payTo: pda.agent(o.agentId).toBase58(),
          },
          description: `${o.name}: ${o.role}`,
          mimeType: 'application/json',
        },
      },
      resourceServer,
    ),
  );

  app.post(`/${o.capability}`, async (req, res) => {
    const task = req.body ?? {};
    log(`paid — working`);
    try {
      const prompt = [`You are: ${o.role}`, '', 'The task:', wrapUntrusted(task), '', 'Produce the result.'].join('\n');
      const {value, provider} = await o.brain.complete({
        schema: o.output,
        schemaName: 'Result',
        system: WORKER_SYSTEM,
        prompt,
        maxTokens: 2_000,
        effort: 'low',
      });
      log(`delivered via ${provider}`);
      res.json(value);
    } catch (e) {
      // 500 → x402 cancel → decline_job on chain → the client is refunded.
      log(`could not deliver: ${(e as Error).message}`);
      res.status(500).json({error: 'the worker could not produce this result; the payment is refunded'});
    }
  });

  return {url, card, close: () => server.close()};
}
