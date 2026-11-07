import {z} from 'zod';
import {
  BrainInvalidOutput,
  BrainUnavailable,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
} from '../brain.js';

/**
 * Shared base for providers reached over plain HTTP with a JSON-mode API.
 *
 * Gemini, Groq and Ollama all express "give me JSON matching this schema" in
 * slightly different shapes. The differences are small enough that one base
 * with a per-provider request builder is less code — and far less drift —
 * than three near-identical adapters.
 *
 * Every response is validated against the caller's zod schema before it is
 * returned. A provider advertising JSON mode is not a guarantee, and an
 * unvalidated result reaching a worker becomes a failed job and a reputation
 * hit on-chain.
 */
export abstract class JsonHttpBrain implements Brain {
  abstract readonly name: string;
  protected abstract readonly model: string;

  protected abstract endpoint(): string | null;
  protected abstract buildRequest(
    req: CompletionRequest<unknown>,
    jsonSchema: object,
  ): {url: string; headers: Record<string, string>; body: unknown};
  protected abstract extractText(payload: unknown): string | null;

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    if (!this.endpoint()) {
      throw new BrainUnavailable(this.name, 'not_configured', 'no API key or endpoint configured');
    }

    const jsonSchema = z.toJSONSchema(req.schema, {target: 'draft-7'}) as object;
    const {url, headers, body} = this.buildRequest(req, jsonSchema);

    // Transient answers are retried before the provider is declared down.
    // Gemini says "high demand … usually temporary" with a 503, and a hosted
    // run failed at the plan because the first one ended it. A client error or
    // a rejected key is not retried: neither fixes itself.
    let res!: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {'content-type': 'application/json', ...headers},
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
        });
      } catch (err) {
        // A dropped connection is retried; a request that already waited out
        // its timeout is not — four of those would stall a run for minutes.
        if ((err as Error).name !== 'TimeoutError' && attempt < RETRY_DELAYS_MS.length) {
          await this.sleep(this.retryDelay(attempt, null));
          continue;
        }
        throw new BrainUnavailable(this.name, 'timeout', (err as Error).message);
      }
      if (!TRANSIENT.has(res.status) || attempt >= RETRY_DELAYS_MS.length) break;
      await res.body?.cancel().catch(() => undefined);
      await this.sleep(this.retryDelay(attempt, res.headers.get('retry-after')));
    }

    if (res.status === 429) throw new BrainUnavailable(this.name, 'rate_limit', 'rate limited');
    if (res.status === 401 || res.status === 403) {
      throw new BrainUnavailable(this.name, 'auth', `rejected the key (${res.status})`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new BrainUnavailable(this.name, 'outage', `${res.status} ${detail.slice(0, 200)}`);
    }

    const payload = await res.json();
    // A reply cut off at the token limit is the provider failing to answer, not
    // a bad answer: the next provider in the chain may well finish.
    if (this.isTruncated(payload)) {
      throw new BrainUnavailable(this.name, 'outage', 'reply cut off at the output token limit');
    }
    const text = this.extractText(payload);
    if (!text) throw new BrainInvalidOutput(this.name, 'response contained no text');

    let raw: unknown;
    try {
      raw = JSON.parse(stripFences(text));
    } catch {
      // Not retryable elsewhere: a model ignoring JSON mode is a prompt
      // problem, and the next provider would likely do the same.
      throw new BrainInvalidOutput(this.name, `not valid JSON: ${text.slice(0, 160)}`);
    }

    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new BrainInvalidOutput(
        this.name,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }

    return {value: parsed.data, provider: this.name, model: this.model, cached: false};
  }

  async available(): Promise<boolean> {
    return this.endpoint() !== null;
  }

  /** The wait before retry `attempt`: the server's retry-after if sane, else backoff with jitter. */
  protected retryDelay(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    const base = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1)!;
    return base + Math.floor(Math.random() * 250);
  }

  /** Whether the provider stopped at its output limit. Per provider; off by default. */
  protected isTruncated(_payload: unknown): boolean {
    return false;
  }

  /** Overridden in tests so they do not wait. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/** Statuses that mean "try again shortly": rate limited, overloaded, a gateway blip. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
/**
 * Two retries — about 7 s — before the fallback chain moves on. Short on
 * purpose: when one model is overloaded the next one in the chain (another
 * model, another vendor) is the better bet than waiting longer.
 */
const RETRY_DELAYS_MS = [2_000, 5_000];
const MAX_RETRY_WAIT_MS = 20_000;

/**
 * The JSON in a model's reply. Asked for JSON only, some models still wrap it:
 * in a code fence, behind "Here is the JSON requested:", or with a closing
 * line after it. Plain JSON is returned as is; otherwise the first fenced
 * block; otherwise the outermost {...}. Whatever comes back is still parsed
 * and validated against the schema by the caller — this only finds it.
 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const fence = String.fromCharCode(96).repeat(3);
  const fenced = new RegExp(fence + '(?:json)?\\s*\\n([\\s\\S]*?)\\n\\s*' + fence).exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : trimmed;
}
