import type {ZodType} from 'zod';

/**
 * A `Brain` turns a prompt into a schema-valid object. That is the whole
 * contract.
 *
 * Every provider is reduced to this, which is what makes them
 * interchangeable. The interface deliberately does NOT expose messages,
 * tools, streaming or provider options: a Fidora worker only ever needs
 * "given this task, produce something matching this schema", and a narrow
 * interface is what lets a rate-limited provider be swapped mid-run without
 * any caller knowing.
 *
 * Schema validity is the point. A worker's result is checked against the
 * job's `outputSchema` before it is accepted on-chain, so a result that
 * cannot satisfy its schema is a failed job and a reputation hit. Making the
 * model produce valid output *by construction* is cheaper than disputing it
 * afterwards.
 */
export interface Brain {
  /** Stable identifier, recorded on every result so a run is explainable. */
  readonly name: string;

  complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>>;

  /** Cheap liveness probe used by the fallback chain. */
  available(): Promise<boolean>;
}

export interface CompletionRequest<T> {
  /** The shape the answer must take. */
  schema: ZodType<T>;
  /** A name for the schema — used as part of the cache key. */
  schemaName: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Hint only. Providers that cannot express it ignore it. */
  effort?: 'low' | 'medium' | 'high';
  /**
   * Give up on this call after this long. A caller with a protocol deadline
   * (a worker has 45 s to accept) sets it so a hanging model falls through to
   * the next in the chain in time. Providers default to 60 s.
   */
  timeoutMs?: number;
}

export interface CompletionResult<T> {
  value: T;
  /** Which brain actually produced this, after any fallback. */
  provider: string;
  model: string;
  usage?: {inputTokens?: number; outputTokens?: number};
  /** True when replayed from cache rather than generated. */
  cached: boolean;
}

/**
 * Thrown when a provider is unavailable *for reasons that another provider
 * might not share* — rate limits, outages, timeouts, auth.
 *
 * The distinction matters: a fallback chain should move on from "I am rate
 * limited", but NOT from "the model produced something that fails the
 * schema". The second is a prompt or schema problem, and every provider will
 * reproduce it. Falling through on it would burn the whole chain and hide
 * the real fault.
 */
export class BrainUnavailable extends Error {
  constructor(
    readonly provider: string,
    readonly reason: 'rate_limit' | 'auth' | 'timeout' | 'outage' | 'not_configured',
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'BrainUnavailable';
  }
}

/** The model produced output that does not satisfy the schema. Not retryable elsewhere. */
export class BrainInvalidOutput extends Error {
  constructor(
    readonly provider: string,
    readonly issues: string,
  ) {
    super(`${provider} returned output failing its schema: ${issues}`);
    this.name = 'BrainInvalidOutput';
  }
}

/** Stable cache key for a request. Excludes anything that varies per run. */
export async function cacheKey(req: CompletionRequest<unknown>): Promise<string> {
  const {createHash} = await import('node:crypto');
  return createHash('sha256')
    .update([req.schemaName, req.system, req.prompt].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

/** The phrase every model-failure message starts with — the site recognises it. */
export const MODEL_UNAVAILABLE = 'AI model unavailable';

/**
 * One sentence, in words, for a model that could not answer — or null when
 * the error is not about the model at all.
 *
 * The raw text is a provider's JSON nested inside a fallback chain's summary,
 * which no reader can act on, and which made "the free AI quota is used up"
 * read like "the product is broken". The order matters: a chain that failed
 * on a quota anywhere is reported as the quota, the one cause that clears by
 * itself and the one an operator can fix with billing.
 */
export function explainModelFailure(err: unknown): string | null {
  if (err instanceof BrainInvalidOutput) return null;
  const reason = err instanceof BrainUnavailable ? err.reason : undefined;
  const text = err instanceof Error ? err.message : String(err);
  const isModel =
    err instanceof BrainUnavailable ||
    /RESOURCE_EXHAUSTED|rate.?limit|high demand|every provider failed/i.test(text);
  if (!isModel) return null;

  const say = (why: string) => `${MODEL_UNAVAILABLE}: ${why}`;
  if (reason === 'not_configured') return say('no AI model is configured on this deployment');
  if (reason === 'auth' || /\(auth:/.test(text)) return say('the provider rejected its key');
  if (reason === 'rate_limit' || /rate_limit|rate limited|\b429\b|RESOURCE_EXHAUSTED|quota/i.test(text))
    return say('its free request quota is used up for now');
  if (reason === 'timeout' || /\(timeout:|timed? ?out/i.test(text)) return say('it did not answer in time');
  return say('the provider is overloaded right now');
}
