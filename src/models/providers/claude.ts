import Anthropic from '@anthropic-ai/sdk';
import {z} from 'zod';
import {
  BrainInvalidOutput,
  BrainUnavailable,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
} from '../brain.js';

/**
 * Claude, via the official Anthropic SDK.
 *
 * Used for the orchestrator, where the work is genuinely hard: decompose a
 * vague goal into subtasks, choose between candidate agents on price and
 * reputation, judge whether a returned result actually answers the question.
 * That is the part a judge watches, and the part where a weaker model shows.
 *
 * Structured output uses `output_config.format` with a raw JSON schema rather
 * than the SDK's `zodOutputFormat` helper. Two reasons, and the second is the
 * one that matters:
 *
 *   1. The helper is typed against zod v4 while this workspace is on v3, so
 *      it does not typecheck — and forcing a zod major upgrade across every
 *      package to satisfy one call site is the wrong trade.
 *   2. It puts Claude on the SAME code path as Gemini, Groq and Ollama: one
 *      JSON schema, one validation step, one place for a bug to live. A
 *      provider-specific shortcut here would mean the fallback chain is only
 *      really exercised on three of four providers.
 */
export class ClaudeBrain implements Brain {
  readonly name = 'claude';
  private readonly client: Anthropic | null;

  constructor(
    private readonly model = 'claude-opus-5',
    apiKey = process.env['ANTHROPIC_API_KEY'],
  ) {
    this.client = apiKey ? new Anthropic({apiKey}) : null;
  }

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    if (!this.client) {
      throw new BrainUnavailable('claude', 'not_configured', 'ANTHROPIC_API_KEY is not set');
    }

    try {
      const jsonSchema = z.toJSONSchema(req.schema, {target: 'draft-7'}) as Record<string, unknown>;

      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens ?? 4_000,
          system: req.system,
          messages: [{role: 'user', content: req.prompt}],
          // Adaptive is the only supported mode on Opus 5; budget_tokens is
          // rejected with a 400 there.
          thinking: {type: 'adaptive'},
          output_config: {
            format: {type: 'json_schema', schema: jsonSchema},
            effort: req.effort ?? 'medium',
          },
        },
        req.timeoutMs !== undefined ? {timeout: req.timeoutMs} : undefined,
      );

      // A safety refusal is a 200 with stop_reason 'refusal', not an
      // exception. Reading content without checking would yield undefined and
      // fail somewhere far less obvious.
      if (response.stop_reason === 'refusal') {
        throw new BrainUnavailable(
          'claude',
          'outage',
          `declined the request (${response.stop_details?.category ?? 'unspecified'})`,
        );
      }

      // Cut off mid-answer is the provider failing to answer, as with Gemini:
      // the next provider in the chain may well finish. Parsing the fragment
      // threw a bare SyntaxError that the chain could not tell from a bug.
      if (response.stop_reason === 'max_tokens') {
        throw new BrainUnavailable('claude', 'outage', 'reply cut off at the output token limit');
      }

      const text = response.content
        .filter((b): b is Extract<typeof b, {type: 'text'}> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text) throw new BrainInvalidOutput('claude', 'response contained no text');

      // Validate rather than trust. `json_schema` constrains generation, but
      // the result still crosses a network boundary into a worker whose
      // output is checked on-chain — so it is checked here too.
      const parsed = req.schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new BrainInvalidOutput(
          'claude',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }

      return {
        value: parsed.data,
        provider: 'claude',
        model: this.model,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        },
        cached: false,
      };
    } catch (err) {
      if (err instanceof BrainUnavailable || err instanceof BrainInvalidOutput) throw err;

      // Typed SDK errors, not string matching on messages.
      if (err instanceof Anthropic.RateLimitError) {
        throw new BrainUnavailable('claude', 'rate_limit', err.message);
      }
      if (err instanceof Anthropic.AuthenticationError) {
        throw new BrainUnavailable('claude', 'auth', err.message);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new BrainUnavailable('claude', 'timeout', err.message);
      }
      const status = (err as {status?: number}).status;
      if (typeof status === 'number' && status >= 500) {
        throw new BrainUnavailable('claude', 'outage', (err as Error).message);
      }
      throw err;
    }
  }

  async available(): Promise<boolean> {
    return this.client !== null;
  }
}
