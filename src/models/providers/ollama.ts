import {JsonHttpBrain} from './json-provider.js';
import type {CompletionRequest} from '../brain.js';

/**
 * Ollama, running locally.
 *
 * Last in the chain precisely because it cannot be rate limited, cannot be
 * metered, and does not need the network. If conference wifi is hostile and
 * every hosted provider is unreachable, this still answers. Quality is lower
 * than the hosted free tiers, which is why it is last rather than first.
 */
export class OllamaBrain extends JsonHttpBrain {
  readonly name = 'ollama';
  protected readonly model: string;

  constructor(
    model = process.env['OLLAMA_MODEL'] || 'qwen2.5:7b',
    private readonly host = process.env['OLLAMA_HOST'] || 'http://127.0.0.1:11434',
  ) {
    super();
    this.model = model;
  }

  protected endpoint(): string | null {
    return `${this.host}/api/chat`;
  }

  protected buildRequest(req: CompletionRequest<unknown>, jsonSchema: object) {
    return {
      url: this.endpoint()!,
      headers: {},
      body: {
        model: this.model,
        stream: false,
        format: jsonSchema,
        options: {num_predict: req.maxTokens ?? 2_000},
        messages: [
          {role: 'system', content: req.system},
          {role: 'user', content: req.prompt},
        ],
      },
    };
  }

  protected extractText(payload: unknown): string | null {
    return (payload as {message?: {content?: string}}).message?.content ?? null;
  }

  /**
   * Unlike the hosted providers, reachability is worth actually checking:
   * "is the key set" tells you nothing about whether Ollama is running.
   */
  override async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/api/tags`, {signal: AbortSignal.timeout(1_500)});
      return res.ok;
    } catch {
      return false;
    }
  }
}
