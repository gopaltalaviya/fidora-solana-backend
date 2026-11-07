/**
 * Fidora's self-hosted x402 facilitator: POST /verify, POST /settle,
 * GET /supported — the shape of x402's own example facilitator
 * (examples/typescript/facilitator/basic), with Fidora's escrow scheme
 * registered on this cluster and, on devnet, the standard `exact` scheme.
 */
import express from 'express';
import {x402Facilitator} from '@x402/core/facilitator';
import type {PaymentPayload, PaymentRequirements} from '@x402/core/types';
import type {Cluster} from '../chain/fidora.js';
import {FidoraEscrowFacilitator, phaseOf} from '../x402/escrow.js';

export function facilitatorApp(cluster: Cluster, opts: {extra?: (f: x402Facilitator) => void; log?: (m: string) => void} = {}) {
  const log = opts.log ?? (() => {});
  const facilitator = new x402Facilitator();
  facilitator.register(cluster.network as never, new FidoraEscrowFacilitator({cluster}));
  opts.extra?.(facilitator);

  const app = express();
  app.use(express.json({limit: '64kb'}));
  const bad = (res: express.Response) => res.status(400).json({error: 'Missing paymentPayload or paymentRequirements'});

  app.post('/verify', async (req, res) => {
    const {paymentPayload, paymentRequirements} = req.body as {paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements};
    if (!paymentPayload || !paymentRequirements) return bad(res);
    try {
      const r = await facilitator.verify(paymentPayload, paymentRequirements);
      log(`verify ${paymentRequirements.scheme}: ${r.isValid ? 'valid' : `invalid — ${r.invalidReason}`}`);
      res.json(r);
    } catch (e) {
      res.status(500).json({error: (e as Error).message});
    }
  });

  app.post('/settle', async (req, res) => {
    const {paymentPayload, paymentRequirements} = req.body as {paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements};
    if (!paymentPayload || !paymentRequirements) return bad(res);
    try {
      const r = await facilitator.settle(paymentPayload, paymentRequirements);
      const phase = paymentRequirements.scheme === 'fidora-escrow' ? phaseOf(paymentPayload.payload as never) : '-';
      log(`settle ${paymentRequirements.scheme}/${phase}: ${r.success ? r.transaction : `failed — ${r.errorReason}`}`);
      res.json(r);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('Settlement aborted:')) {
        return res.json({success: false, errorReason: msg.replace('Settlement aborted: ', ''), network: paymentPayload.accepted?.network ?? 'unknown', transaction: ''});
      }
      res.status(500).json({error: msg});
    }
  });

  app.get('/supported', (_req, res) => res.json(facilitator.getSupported()));
  return app;
}
