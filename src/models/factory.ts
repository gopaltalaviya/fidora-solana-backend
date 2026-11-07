import {join} from 'node:path';
import type {Brain} from './brain.js';
import {CachedBrain, RecordingBrain} from './cached.js';
import {FallbackBrain, type FallbackOptions} from './fallback.js';
import {ClaudeBrain} from './providers/claude.js';
import {GeminiBrain} from './providers/gemini.js';
import {GroqBrain} from './providers/groq.js';
import {OllamaBrain} from './providers/ollama.js';

export {ClaudeBrain, GeminiBrain, GroqBrain, OllamaBrain};

/**
 * Brain assembly, kept out of `index.ts`.
 *
 * `run.ts` needs `buildBrain`, and `index.ts` re-exports `run.ts` — importing
 * it from the barrel would make that a cycle. It survives in ESM, but a cycle
 * that only works because the call happens late is not something to leave for
 * the next person to discover.
 */

export type AgentMode = 'cached' | 'live' | 'record';
export type Role = 'orchestrator' | 'worker';

export interface BuildBrainOptions extends FallbackOptions {
  role: Role;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
}

/**
 * Assemble the brain for a role from configuration.
 *
 * Two independent axes, kept separate on purpose:
 *
 * - **`AGENT_MODE`** decides whether tokens are spent at all.
 *   `cached` replays a recording (free, and the default while developing),
 *   `live` calls providers, `record` calls them and saves the result so
 *   every later run can be free.
 *
 * - **`BRAIN_CHAIN`** decides the provider ORDER. That is a deliberate choice
 *   about cost and quality, so it is configured rather than guessed. Moving
 *   ALONG the chain is automatic, because a rate limit at 11pm on submission
 *   day has nobody available to flip a flag.
 *
 * The orchestrator and the workers get different defaults because they do
 * different work: the orchestrator decomposes a vague goal, picks between
 * candidates and judges results — the part a judge watches, and where a
 * weaker model shows. Workers do schema-constrained extraction, which the
 * free tiers handle well and ~100x cheaper.
 */
export function buildBrain(opts: BuildBrainOptions): Brain {
  const env = opts.env ?? process.env;
  const mode = (env['AGENT_MODE'] || 'cached') as AgentMode;
  const cacheDir = opts.cacheDir ?? (env['AGENT_CACHE_DIR'] || join(process.cwd(), '.agent-cache'));
  const cachePath = join(cacheDir, `${opts.role}.json`);

  if (mode === 'cached') return new CachedBrain(cachePath, {maxReplayMs: replayCap(env)});

  const chain = resolveChain(opts.role, env).map((name) => makeBrain(name, opts.role, env));
  const live: Brain = chain.length === 1 ? chain[0]! : new FallbackBrain(chain, opts);

  // Cached is always the last resort, even in live mode: if every provider is
  // unreachable, a recorded answer beats a dead demo.
  const withBackstop = new FallbackBrain(
    [live, new CachedBrain(cachePath, {maxReplayMs: replayCap(env)})],
    opts,
  );

  return mode === 'record' ? new RecordingBrain(withBackstop, cachePath) : withBackstop;
}

/**
 * How long one replayed call may wait, from `AGENT_REPLAY_MAX_MS`.
 *
 * A replay re-enacts each call's recorded latency (up to 8 s) so a cached
 * demo has the rhythm of a live one. That is right for the video and wrong
 * for a rehearsal that only needs to prove the chain side still works; this
 * shortens it without touching the recording. Unset keeps the 8 s default.
 */
function replayCap(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env['AGENT_REPLAY_MAX_MS'];
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw))
    throw new Error(`AGENT_REPLAY_MAX_MS must be a whole number of milliseconds, not "${raw}"`);
  return Number(raw);
}

function resolveChain(role: Role, env: NodeJS.ProcessEnv): string[] {
  const configured = env[role === 'orchestrator' ? 'BRAIN_CHAIN_ORCHESTRATOR' : 'BRAIN_CHAIN'];
  if (configured)
    return configured
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  // Defaults: judgement on Claude, extraction on whatever is free.
  return role === 'orchestrator'
    ? ['claude', 'gemini', 'groq', 'ollama']
    : ['gemini', 'groq', 'ollama', 'claude'];
}

function makeBrain(name: string, role: Role, env: NodeJS.ProcessEnv): Brain {
  // `gemini:<model>` — another Gemini model, as a provider of its own. One
  // model can be overloaded ("503 high demand") while others on the same key
  // answer, so a chain may fall back across models, not only across vendors.
  const [provider, model] = name.split(/:(.*)/s) as [string, string | undefined];
  if (provider === 'gemini' && model) return new GeminiBrain(model, env['GEMINI_API_KEY']);
  switch (name) {
    case 'claude':
      // Haiku for workers is a deliberate cost choice, recorded in the
      // decisions log rather than made silently here.
      return new ClaudeBrain(
        role === 'orchestrator'
          ? (env['CLAUDE_MODEL'] || 'claude-opus-5')
          : (env['CLAUDE_WORKER_MODEL'] || 'claude-haiku-4-5'),
        env['ANTHROPIC_API_KEY'],
      );
    case 'gemini':
      return new GeminiBrain(undefined, env['GEMINI_API_KEY']);
    case 'groq':
      return new GroqBrain(undefined, env['GROQ_API_KEY']);
    case 'ollama':
      return new OllamaBrain();
    default:
      throw new Error(
        `unknown brain "${name}" in BRAIN_CHAIN — expected one of claude, gemini (or gemini:<model>), groq, ollama`,
      );
  }
}

/** Human-readable startup banner: which providers are actually reachable. */
export async function describeBrain(brain: Brain): Promise<string> {
  if (brain instanceof FallbackBrain) {
    const status = await brain.status();
    return status.map((s) => `${s.available ? '✓' : '✗'} ${s.provider}`).join('  ');
  }
  return `${(await brain.available()) ? '✓' : '✗'} ${brain.name}`;
}
