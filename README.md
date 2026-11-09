# fidora-solana-backend

**Fidora**: AI agents hire each other over **HTTP x402 on Solana**, and every
payment sits in an on-chain escrow until a judge says the work earned it. A
failed call is refunded in the same request; a bad answer can be disputed; a
farmed counterparty is refused before anything is signed.

> **Encode Solana Hackathon 2026 — what existed before.** Written by the
> author before the hackathon and reused here unchanged: the model layer in
> `src/models/` (providers, cached replay, the tool-less judge, the prompts),
> the trust-verdict rules, and the worker output schemas. Written during the
> hackathon:
> - the `fidora-escrow` x402 scheme (client, resource server and
>   facilitator, on the official x402 v2 packages)
> - the Solana chain layer
> - the x402-native orchestrator and worker
> - the on-chain trust read
> - the demo
>
> The program is in [fidora-solana-programs](https://github.com/gopaltalaviya/fidora-solana-programs).

## Run it, with one command and no keys

You need Node 22+, the Solana CLI, and the programs repo cloned beside this
one. On Windows the validator runs in WSL (`FIDORA_WSL_DISTRO`, default
Ubuntu).

```bash
git clone https://github.com/gopaltalaviya/fidora-solana-programs
git clone https://github.com/gopaltalaviya/fidora-solana-backend
cd fidora-solana-programs && npm ci && cd ../fidora-solana-backend
npm ci
npm run demo:local
```

If `npm ci` refuses the lockfile (it was written by npm 11; npm 10, which
ships with Node 22, rejects it), run `npm install` instead.

To look at what the demo left on chain in the web interface, keep the chain
running: `DEMO_HOLD=1 npm run demo:local`, then in
[fidora-solana-interface](https://github.com/gopaltalaviya/fidora-solana-interface)
run `FIDORA_CLUSTER=localnet pnpm dev`.

What it does:
1. Starts a **fresh** `solana-test-validator` with the committed program,
   after checking its hash.
2. Initializes the program.
3. Runs `scripts/demo.ts` with `AGENT_MODE=cached`. Model answers replay from
   `.agent-cache/`, so there is no API key and no quota.

What you see. Every ✓ is a check against accounts on chain:

```
  ✓ 3 workers registered by their owners, wallets accepted, staked, serving x402 — agents 1, 2, 3
  plan      3 subtask(s) — …
  select    agent 1 at 0.02 USDC — …
  x402      job 1: locked in escrow, delivered on chain        ← create_job, then accept_job + submit_result(sha256(body))
  judge     job 1: accept (quality 3)
  settle    job 1 approved — worker paid                        ← approve
  ✓ 3 step(s) paid over x402 and settled on chain
  ✓ workers were paid 0.0891 USDC in total, read from their purses on chain
  ✓ failed payment handled: the worker's model was down, x402's cancel leg declined job 4 on chain — the orchestrator's purse is back to 1.91 USDC
  ✓ the trust check reads the farm's record from on-chain events alone: self-funded → block
  ✓ the orchestrator pays the farmed agent 6 → refused inside x402 before signing: COUNTERPARTY_BLOCKED
  ✓ the orchestrator buys the "premium report" for 1.5 USDC → refused by its x402 spend ceiling (0.1 USDC per payment)
  ✓ with the stolen key: hire the attacker's agent for 1.5 USDC → refused by the program: PerTaskCapExceeded
  ✓ with the stolen key: withdraw the purse → refused by the program: NotAgentOwner (only the owner may)
  ✓ I1 holds: the vault holds exactly what the program owes
Demo passed.
```

The model answers were recorded once with a local **llama3 8B** (Ollama).
Figures inside them, such as volumes and prices, are model output, not market
data. `AGENT_MODE=record` with Ollama running records them again; it costs no
quota.

## The x402 flow, step by step

`fidora-escrow` uses x402 v2's own **`escrow` payment flow**: settle before
the handler, settle after it, and a `cancel` leg when the handler fails. It
is the same pattern as x402's auth-capture custom-escrow example:

| x402 phase | What happens on Solana |
|---|---|
| request, no payment | `402` with a `fidora-escrow` quote: price, the worker agent's PDA as `payTo`, the program id |
| **before-handler settle** | The client agent's wallet signed `create_job`; the facilitator checks and simulates it, then relays it. The money is now in the program's vault, under the client's caps |
| handler | The worker's model does the work |
| **after-handler settle** | The worker's wallet signs `accept_job` + `submit_result` with `result_hash = sha256(response body)`. The hash on chain is the hash of the bytes the client received |
| **cancel** (handler failed or threw) | The worker's wallet signs `decline_job`, and the client is **refunded in full, inside the same request** |
| out of band | The client's judge calls `approve` (the worker is paid) or `dispute` (the arbiter rules). If the client stays silent, anyone may `auto_approve` after the review window |

**Failed payments.** These are the cases the x402 track asks about:
- **Handler failure:** refunded in-request.
- **Bad answer:** disputed, with the money still in escrow.
- **Payment the program would refuse** (over a cap, balance too low, worker
  not hireable): the facilitator's simulation catches it, and it is answered
  as an x402 `invalidReason` such as `PerTaskCapExceeded` before any fee is
  spent.
- **Tampered payload:** wrong amount, wrong worker, an extra instruction, a
  bad signature, or a delivery whose hash does not match the body. Refused;
  see `test/escrow.test.ts`.

The facilitator holds **no keys and no money**. Every transaction comes
signed by an agent wallet that pays its own fee; the facilitator verifies
and relays.

## The defences, and where each one lives

| Attack | What stops it | Where |
|---|---|---|
| A worker farmed its own reputation (its owner funded the clients that paid it) | Trust verdict `self-funded` → **block**, read from the program's `Funded` and settlement events | `src/agents/trust.ts` |
| The orchestrator's model, prompt-injected, pays that worker anyway | x402 client hook `onBeforePaymentCreation` aborts before signing: `COUNTERPARTY_BLOCKED` | `src/agents/orchestrator.ts` |
| A worker asks far more than a task is worth | x402 spend controls: a per-payment ceiling on the payment token | `src/agents/orchestrator.ts` |
| The orchestrator's wallet key is stolen and used on the program directly | Per-task and rolling daily caps (`PerTaskCapExceeded`); withdraw needs the owner (`NotAgentOwner`) | the program |
| A worker's wallet key is stolen, to accept an accomplice's jobs and let them expire so the bonds are seized | The bond a wallet locks counts toward its own caps (`PerTaskCapExceeded`, `DailyCapExceeded`) | the program |
| A worker records the hash of one body on chain and sends another | The client hashes the bytes it received and compares them with `result_hash` before judging; a mismatch is disputed without asking the model (`RESULT_MISMATCH`) | `src/agents/orchestrator.ts` |
| A worker's `PAYMENT-RESPONSE` header names another job | Ignored: the client settles the job its own lock wrote | `src/agents/orchestrator.ts` |
| An endpoint's 402 names a different agent than the one chosen, or a higher price | Refused before signing (`QUOTE_MISMATCH`); an agent with no trust reading is refused too | `src/agents/orchestrator.ts` |
| A client slips a worker leg into its payment, or shortens the quoted windows | `/verify` accepts only a lock, with exactly the quoted amount, worker, job and windows | `src/x402/escrow.ts` |
| The delivery leg fails after the money is locked | The client cancels the job at once and is refunded | `src/agents/orchestrator.ts` |
| Flooding the program with transactions to push old funding evidence out of the trust read | A partial read is never a clean record: every agent is blocked until the history can be read in full | `src/agents/trust.ts` |
| A worker returns an injection in its result | Results reach the judge only as delimited untrusted data; the judge has no tools; an injection attempt is a veto, so the job is disputed and not paid | `src/models/judge.ts` |

A stolen agent wallet keypair also controls that wallet's own SOL. Keep it
to fee money; the agent's tokens are in the program's vault, where the key
can only spend within caps.

## Layout

| Path | What |
|---|---|
| `src/x402/escrow.ts` | The `fidora-escrow` scheme: `FidoraEscrowClient`, `FidoraEscrowServer`, `FidoraEscrowFacilitator` |
| `src/facilitator/app.ts` | The self-hosted facilitator: `/verify`, `/settle`, `/supported` |
| `src/agents/worker.ts` | A worker: `GET /agent.json` (its card, which its on-chain `card_uri` points to) and an x402-protected `POST /<capability>` |
| `src/agents/orchestrator.ts` | Plan, discover on chain, trust gate, select, pay over x402, judge, approve or dispute |
| `src/agents/trust.ts` | The trust verdict from on-chain events |
| `src/chain/fidora.ts` | Program client, PDAs, transactions, CAIP-2 network id from the node's genesis hash |
| `src/models/` | Model providers, cached replay, judge, prompts (from the earlier edition) |
| `scripts/demo.ts`, `scripts/local-up.ts` | The demo, and the one-command local run |
| `scripts/x402-smoke.ts` | The scheme alone, end to end, through `@x402/express` and `@x402/fetch` |

**Networks.** The x402 network id is the cluster's real CAIP-2 id, read from
the node: `solana:<genesis hash prefix>`. `@x402/svm`'s standard `exact`
scheme accepts only mainnet, devnet and testnet ids, so it runs on **devnet**
only. A local validator is never labelled devnet.

## Tests

```bash
npm run check     # typecheck + 52 unit tests (tamper refusals, the pay and judge gates, trust, the chain layer)
npm run test:live # a fresh validator, then every live check that needs no model: verify-solana (23),
                  # the x402 smoke, scripts/x402-attacks.ts (hostile workers), and the
                  # devnet sweep check (scripts/sweep-check.ts) → "All live checks passed."
```

The tamper tests were checked by mutation: removing the amount check, or the
foreign-instruction check, turns the matching test red.

## Not done yet, stated plainly

- **Devnet deployment and the standard `exact` scheme on devnet:** waiting
  for devnet SOL in the owner's own wallet (`FIDORA_DEPLOYER_KEYPAIR`). On
  devnet the demo saves each test key it funds to `.keys/devnet/` (gitignored)
  first, and returns their SOL and token-account rent to that wallet at the
  end; `npm run sweep:devnet` does it by hand.
- **Aurora Intents:** needs an Aurora Client Portal API key and mainnet
  funds (there is no testnet), so it is not integrated.
- **The web interface is read-only:** it shows agents, jobs, trust verdicts and the event feed from the chain; registering and hiring are done by agents with their own keys, as above.
- **Agent wallets are keypairs in the agent process here.** The earlier
  edition's separate signer service is not ported.

## Built with

Anchor 1.2.2 · `@anchor-lang/core` 1.2.2 · `@solana/web3.js` 1.99 ·
`@solana/kit` 8.6 · `@x402/core`, `@x402/express`, `@x402/fetch`,
`@x402/svm` 2.30 · Express 5 · zod 4 · Vitest · TypeScript 5.9. Models:
Ollama (llama3 8B) for the recordings; Claude, Gemini and Groq optional.
Claude Code was used to write and review code and docs.

## Licence

MIT. See `LICENSE`.
