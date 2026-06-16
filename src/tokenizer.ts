/**
 * Exact token counting via tiktoken BPE, replacing the char/4 heuristic for the prefix breakdown
 * and reasoning estimate. Copilot's `models.json` declares each model's tokenizer; across the whole
 * catalog there are only two, both standard tiktoken encodings:
 *   - `o200k_base`  (GPT-5.x, Opus, Gemini, …)
 *   - `cl100k_base` (older models)
 *
 * tiktoken is OpenAI's tokenizer: exact for OpenAI models, and a close public proxy for
 * Anthropic/Gemini (which use their own internally, but Copilot declares o200k_base for them). Far
 * better than char/4 either way. We use `gpt-tokenizer` (pure CommonJS) so esbuild inlines the
 * encodings into the bundle. Encoding is synchronous and fast for the sizes we handle; any failure
 * falls back to char/4.
 */
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';

type Encoder = (text: string) => number[];

const ENCODERS: Record<string, Encoder> = {
  o200k_base: encodeO200k,
  cl100k_base: encodeCl100k,
};

/** Default tokenizer when a model doesn't declare one (the current-generation default). */
const DEFAULT_TOKENIZER = 'o200k_base';
const CHARS_PER_TOKEN = 4;

/**
 * Count tokens in `text` using the given model tokenizer (from `models.json`). Exact via tiktoken;
 * falls back to char/4 if encoding fails. Never throws.
 */
export function countTokens(text: string, tokenizer?: string): number {
  if (!text) {
    return 0;
  }
  const encode = (tokenizer && ENCODERS[tokenizer]) || ENCODERS[DEFAULT_TOKENIZER];
  try {
    return encode(text).length;
  } catch {
    return Math.round(text.length / CHARS_PER_TOKEN);
  }
}
