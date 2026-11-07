import {JsonHttpBrain} from './json-provider.js';
import type {CompletionRequest} from '../brain.js';

/**
 * Google Gemini, free tier.
 *
 * The most generous free allowance of the three (~1,500 requests/day, about
 * 500 demo runs), and it accepts a response schema natively rather
 * than being asked nicely for JSON.
 */
const DEFAULT_MODEL = 'gemini-3.8-flash';

export class GeminiBrain extends JsonHttpBrain {
  readonly name: string;
  protected readonly model: string;

  constructor(
    // gemini-2.5-flash answered 404 "no longer available to new users" on
    // 2026-09-30, naming this as its replacement. GEMINI_MODEL overrides it.
    model = process.env['GEMINI_MODEL'] || DEFAULT_MODEL,
    private readonly apiKey = process.env['GEMINI_API_KEY'],
  ) {
    super();
    this.model = model;
    // The default model is plain "gemini"; another is named for its model, so
    // a chain of several reads (and logs) unambiguously.
    this.name = model === DEFAULT_MODEL ? 'gemini' : `gemini:${model}`;
  }

  protected endpoint(): string | null {
    return this.apiKey
      ? `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`
      : null;
  }

  protected buildRequest(req: CompletionRequest<unknown>, jsonSchema: object) {
    return {
      // In a header, never the query string. A URL is what ends up in error
      // messages, proxy logs and traces; a key in one is a key in all of them.
      url: this.endpoint()!,
      headers: {'x-goog-api-key': this.apiKey!},
      body: {
        systemInstruction: {parts: [{text: req.system}]},
        contents: [{role: 'user', parts: [{text: req.prompt}]}],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema,
          // Gemini 3.x spends part of this on THINKING before it writes a word,
          // so a caller's small budget (a worker's triage asks for 400) ran
          // out mid-answer: `{"` and stop. Headroom costs nothing — billing is
          // for tokens produced, not the cap.
          maxOutputTokens: Math.max(req.maxTokens ?? 2_000, 8_192),
        },
      },
    };
  }

  protected override isTruncated(payload: unknown): boolean {
    const p = payload as {candidates?: {finishReason?: string}[]};
    return p.candidates?.[0]?.finishReason === 'MAX_TOKENS';
  }

  protected extractText(payload: unknown): string | null {
    const p = payload as {candidates?: {content?: {parts?: {text?: string}[]}}[]};
    return p.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') || null;
  }
}
