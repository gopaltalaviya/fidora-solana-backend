import {JsonHttpBrain} from './json-provider.js';
import type {CompletionRequest} from '../brain.js';

/**
 * Groq, free tier.
 *
 * The fastest inference of the three — often sub-second — which matters in a
 * live demo, where a worker that answers quickly reads as competent. The
 * binding free-tier limit is tokens per day rather than requests, so worker
 * prompts are kept deliberately short.
 */
export class GroqBrain extends JsonHttpBrain {
  readonly name = 'groq';
  protected readonly model: string;

  constructor(
    model = process.env['GROQ_MODEL'] || 'openai/gpt-oss-120b',
    private readonly apiKey = process.env['GROQ_API_KEY'],
  ) {
    super();
    this.model = model;
  }

  protected endpoint(): string | null {
    return this.apiKey ? 'https://api.groq.com/openai/v1/chat/completions' : null;
  }

  protected buildRequest(req: CompletionRequest<unknown>, jsonSchema: object) {
    return {
      url: this.endpoint()!,
      headers: {authorization: `Bearer ${this.apiKey}`},
      body: {
        model: this.model,
        // A reasoning model spends tokens thinking before it answers, and they
        // count against max_tokens: a 400-token triage came back empty, live.
        max_tokens: reasons(this.model) ? Math.max(req.maxTokens ?? 2_000, 4_096) : (req.maxTokens ?? 2_000),
        ...(reasons(this.model) ? {reasoning_effort: req.effort ?? 'medium'} : {}),
        messages: [
          {role: 'system', content: req.system},
          {role: 'user', content: req.prompt},
        ],
        response_format: {
          type: 'json_schema',
          // Strict mode refuses a schema with any optional field; the answer
          // is validated against the schema either way.
          json_schema: {name: req.schemaName, schema: jsonSchema, strict: allRequired(jsonSchema)},
        },
      },
    };
  }

  protected extractText(payload: unknown): string | null {
    const p = payload as {choices?: {message?: {content?: string}}[]};
    return p.choices?.[0]?.message?.content ?? null;
  }
}

/** Does every object in the schema list all its properties as required? (Groq strict mode needs it.) */
function allRequired(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return true;
  const s = schema as {properties?: Record<string, unknown>; required?: string[]; items?: unknown};
  if (s.properties) {
    const keys = Object.keys(s.properties);
    const req = new Set(s.required ?? []);
    if (!keys.every((k) => req.has(k))) return false;
    if (!keys.every((k) => allRequired(s.properties![k]))) return false;
  }
  if (s.items && !allRequired(s.items)) return false;
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = (schema as Record<string, unknown>)[k];
    if (Array.isArray(list) && !list.every(allRequired)) return false;
  }
  return true;
}

/** Groq's reasoning models (gpt-oss, qwen3) think before they answer. */
function reasons(model: string): boolean {
  return /gpt-oss|qwen3/i.test(model);
}
