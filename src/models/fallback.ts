import {
  BrainInvalidOutput,
  BrainUnavailable,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
} from './brain.js';

export interface FallbackOptions {
  logger?: {warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void};
  /** Called whenever the chain moves past a provider. Used for demo telemetry. */
  onFallback?: (from: string, to: string, reason: string) => void;
}

/**
 * Try each brain in order; move on only when a provider is unavailable.
 *
 * The chain's ORDER is configuration (`BRAIN_CHAIN`) — a deliberate choice
 * about cost and quality. Moving along it is automatic, because a rate limit
 * at 11pm on submission day has nobody available to flip a flag.
 *
 * Two rules keep that safe:
 *
 * 1. **Falling through is loud.** Every result names the provider that
 *    actually served it, and each step logs a warning. Silent degradation
 *    means you discover the primary has been broken for a week during the
 *    demo rather than before it.
 *
 * 2. **Only `BrainUnavailable` falls through.** A schema violation is a
 *    prompt or schema bug that every provider will reproduce, so continuing
 *    would burn the whole chain, spend three providers' quota and bury the
 *    real fault under "everything failed".
 */
export class FallbackBrain implements Brain {
  readonly name: string;

  constructor(
    private readonly chain: Brain[],
    private readonly opts: FallbackOptions = {},
  ) {
    if (chain.length === 0) throw new Error('FallbackBrain needs at least one brain');
    this.name = `fallback(${chain.map((b) => b.name).join('→')})`;
  }

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    const failures: string[] = [];

    for (let i = 0; i < this.chain.length; i++) {
      const brain = this.chain[i]!;
      try {
        const result = await brain.complete(req);
        if (i > 0) {
          this.opts.logger?.info({provider: brain.name, skipped: failures}, 'served by a fallback provider');
        }
        return result;
      } catch (err) {
        if (err instanceof BrainInvalidOutput) {
          // Every provider will reproduce this. Stop here so the real fault
          // is visible instead of being buried under three more failures.
          throw err;
        }
        if (err instanceof BrainUnavailable) {
          // The reason AND the provider's own words. `gemini(outage)` alone
          // cannot tell a retired model from a bad key from a 500, and the
          // fix for each is different.
          failures.push(`${brain.name}(${err.reason}: ${err.message})`);
          const next = this.chain[i + 1];
          this.opts.logger?.warn(
            {provider: brain.name, reason: err.reason, next: next?.name ?? 'none'},
            'provider unavailable, falling through',
          );
          this.opts.onFallback?.(brain.name, next?.name ?? 'none', err.reason);
          continue;
        }
        // An unrecognised error is not proof the next provider would fare
        // better, but it is also not proof it would not. Treat it as an
        // outage and keep the demo alive; the message is preserved either way.
        failures.push(`${brain.name}(${(err as Error).message})`);
        this.opts.logger?.warn(
          {provider: brain.name, err: (err as Error).message},
          'provider threw, falling through',
        );
        continue;
      }
    }

    throw new BrainUnavailable(this.name, 'outage', `every provider failed: ${failures.join(', ')}`);
  }

  async available(): Promise<boolean> {
    for (const brain of this.chain) if (await brain.available()) return true;
    return false;
  }

  /** Which providers are reachable right now. Printed at startup. */
  async status(): Promise<{provider: string; available: boolean}[]> {
    return Promise.all(this.chain.map(async (b) => ({provider: b.name, available: await b.available()})));
  }
}
