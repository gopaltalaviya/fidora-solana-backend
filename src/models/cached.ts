import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {
  BrainUnavailable,
  cacheKey,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
} from './brain.js';

interface CacheEntry {
  value: unknown;
  provider: string;
  model: string;
  /** How long the original call took, replayed so the demo keeps its rhythm. */
  latencyMs: number;
  recordedAt: string;
  /** Kept for a human reading the file; never used for lookup. */
  promptPreview: string;
  /**
   * The whole prompt, for diffing against a miss. A changed prompt means a
   * changed key, and a preview is too short to show which line moved.
   */
  fullPrompt?: string;
}

/**
 * Replay recorded completions instead of calling a provider.
 *
 * Two jobs, and the second is the important one:
 *
 * 1. **Development costs nothing.** Iterating on the orchestrator's logic,
 *    the MCP wiring or the UI does not spend tokens. Only the live path
 *    spends, and only when asked.
 *
 * 2. **The demo cannot hard-fail.** Every provider being rate-limited,
 *    offline, or simply unreachable from a conference wifi is a real
 *    possibility on submission day. A recorded run is not a fake: it is the
 *    output the real models actually produced, replayed with its original
 *    timing so the demo still looks like thinking rather than a lookup.
 *
 * The recording is honest about itself — every replayed result carries
 * `cached: true`, and the demo says so on screen rather than pretending.
 */
export class CachedBrain implements Brain {
  readonly name = 'cached';
  private cache: Record<string, CacheEntry>;

  constructor(
    private readonly path: string,
    private readonly opts: {
      replayTiming?: boolean;
      /** The longest one replayed call may wait. Default 8 s; 0 replays instantly. */
      maxReplayMs?: number | undefined;
    } = {},
  ) {
    this.cache = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as typeof this.cache) : {};
  }

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    const key = await cacheKey(req);
    const entry = this.cache[key];

    if (!entry) {
      throw new BrainUnavailable(
        'cached',
        'not_configured',
        `no recording for this request (key ${key}). Run once with AGENT_MODE=live to record it.`,
      );
    }

    // Replay the original latency so a cached demo has the same rhythm as a
    // live one. A demo that answers instantly reads as a lookup table.
    const wait = Math.min(entry.latencyMs, this.opts.maxReplayMs ?? 8_000);
    if (this.opts.replayTiming !== false && wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    // Validate on the way out, not just on the way in: a schema can change
    // after a recording was made, and silently replaying stale shapes would
    // be worse than failing.
    const parsed = req.schema.safeParse(entry.value);
    if (!parsed.success) {
      throw new BrainUnavailable(
        'cached',
        'not_configured',
        `recording no longer matches ${req.schemaName} — re-record with AGENT_MODE=live`,
      );
    }

    return {
      value: parsed.data,
      provider: `cached(${entry.provider})`,
      model: entry.model,
      cached: true,
    };
  }

  async available(): Promise<boolean> {
    return Object.keys(this.cache).length > 0;
  }

  get size(): number {
    return Object.keys(this.cache).length;
  }
}

/**
 * Wrap a live brain and record what it produces.
 *
 * Used for the single seeding run: everything after it can replay for free.
 */
export class RecordingBrain implements Brain {
  readonly name: string;

  constructor(
    private readonly inner: Brain,
    private readonly path: string,
  ) {
    this.name = `recording(${inner.name})`;
  }

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    const started = Date.now();
    const result = await this.inner.complete(req);
    const key = await cacheKey(req);

    // Read the file again at write time rather than holding a copy from
    // construction. Several recorders share one file — the demo gives each
    // worker its own — and rewriting from a private snapshot erased whatever
    // the others had recorded since. The read and the write are synchronous
    // with no await between them, so within one process nothing can land in
    // the gap.
    const cache: Record<string, CacheEntry> = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, CacheEntry>)
      : {};

    cache[key] = {
      value: result.value,
      provider: result.provider,
      model: result.model,
      latencyMs: Date.now() - started,
      recordedAt: new Date().toISOString(),
      promptPreview: req.prompt.slice(0, 120),
      fullPrompt: req.prompt,
    };

    mkdirSync(dirname(this.path), {recursive: true});
    writeFileSync(this.path, JSON.stringify(cache, null, 2) + '\n');
    return result;
  }

  available(): Promise<boolean> {
    return this.inner.available();
  }
}
