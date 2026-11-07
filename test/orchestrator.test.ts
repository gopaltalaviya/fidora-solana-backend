/**
 * The orchestrator's two code-level gates, as pure rules:
 *  - what it will sign (the 402 quote must be for the agent it chose, at no
 *    more than that agent advertised, and the agent must have a trust
 *    reading that is not a block), and
 *  - what it will judge (the body it received must be the body whose hash
 *    the worker recorded on chain, on a job that is Submitted).
 * The live run of both is scripts/x402-attacks.ts.
 */
import {describe, expect, it} from 'vitest';
import {sha256} from '../src/chain/fidora.js';
import {deliveryRefusal, quoteRefusal} from '../src/agents/orchestrator.js';
import type {TrustReading} from '../src/agents/trust.js';

const reading = (action: TrustReading['action'], verdict: TrustReading['verdict'] = action === 'block' ? 'self-funded' : 'new'): TrustReading => ({
  agentId: '4',
  verdict,
  action,
  reasons: [`because ${verdict}`],
  metrics: {settled: 0, failed: 0, clientOwners: 0, topOwnerSettled: 0, selfFunded: 0},
});
const chosen = {agentId: 4n, price: 20_000n};

describe('quoteRefusal: what the orchestrator will sign', () => {
  it('signs a quote for the chosen agent at its advertised price', () => {
    expect(quoteRefusal({workerAgentId: '4', amount: '20000'}, chosen, reading('warn'))).toBeNull();
    expect(quoteRefusal({workerAgentId: '4', amount: '19999'}, chosen, reading('allow', 'trusted'))).toBeNull();
  });

  it('refuses a 402 that names another agent than the one chosen', () => {
    expect(quoteRefusal({workerAgentId: '5', amount: '20000'}, chosen, reading('allow', 'trusted'))).toMatch(/^QUOTE_MISMATCH: .*agent 5.*chose agent 4/);
  });

  it('refuses a quote above the price the chosen agent advertised', () => {
    expect(quoteRefusal({workerAgentId: '4', amount: '20001'}, chosen, reading('allow', 'trusted'))).toMatch(/^QUOTE_MISMATCH: .*20001.*20000/);
  });

  it('refuses a blocked counterparty, and one with no trust reading at all (fail closed)', () => {
    expect(quoteRefusal({workerAgentId: '4', amount: '20000'}, chosen, reading('block'))).toMatch(/^COUNTERPARTY_BLOCKED: agent 4 is self-funded/);
    expect(quoteRefusal({workerAgentId: '4', amount: '20000'}, chosen, undefined)).toMatch(/^COUNTERPARTY_BLOCKED: agent 4 has no trust reading/);
  });
});

describe('deliveryRefusal: what the orchestrator will judge', () => {
  const body = new TextEncoder().encode('{"summary":"ok"}');

  it('judges a Submitted job whose on-chain hash is sha256 of the body received', () => {
    expect(deliveryRefusal('submitted', sha256(body), body)).toBeNull();
    expect(deliveryRefusal('submitted', [...sha256(body)], body)).toBeNull();
  });

  it('refuses a body other than the one whose hash went on chain', () => {
    expect(deliveryRefusal('submitted', sha256('another body'), body)).toMatch(/^RESULT_MISMATCH/);
  });

  it('compares bytes, not decoded text', () => {
    const latin = Uint8Array.from([0x7b, 0xe9, 0x7d]); // not valid UTF-8
    expect(deliveryRefusal('submitted', sha256(new TextEncoder().encode(new TextDecoder().decode(latin))), latin)).toMatch(/^RESULT_MISMATCH/);
    expect(deliveryRefusal('submitted', sha256(latin), latin)).toBeNull();
  });

  it('refuses a job that is not Submitted, or has no result hash', () => {
    expect(deliveryRefusal('created', null, body)).toMatch(/^NOT_DELIVERED: job is created/);
    expect(deliveryRefusal('settled', sha256(body), body)).toMatch(/^NOT_DELIVERED: job is settled/);
    expect(deliveryRefusal('submitted', null, body)).toMatch(/^NOT_DELIVERED/);
  });
});
