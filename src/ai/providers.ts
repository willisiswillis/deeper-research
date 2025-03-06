import { createOpenAI, type OpenAIProviderSettings } from '@ai-sdk/openai';
import { createAnthropic, type AnthropicProviderSettings } from '@ai-sdk/anthropic';
import { getEncoding } from 'js-tiktoken';
import { RecursiveCharacterTextSplitter } from './text-splitter';

/**
 * Extended OpenAI settings interface to add support for custom base URL (useful for proxies or custom API endpoints)
 */
interface CustomOpenAIProviderSettings extends OpenAIProviderSettings {
  baseURL?: string;
}

// ================ OpenAI Client Setup (UNCHANGED) ==================

// Fallback environment variable check for OpenAI API key
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = process.env.OPENAI_KEY || process.env.openai_api_key;
}

// Create OpenAI provider instance
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1',
} as CustomOpenAIProviderSettings);

// Determine the OpenAI model to use (from environment variables or default)
const customModel = process.env.OPENAI_MODEL || 'o3-mini';

/**
 * Export configured instance of the OpenAI model (e.g. 'o3-mini').
 */
export const o3MiniModel = openai(customModel, {
  reasoningEffort: customModel.startsWith('o') ? 'medium' : undefined,
  structuredOutputs: true,
});


// Confirm presence of Anthropic API key from environment variables
if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY and OPENAI_API_KEY environment variable.');
}

// Instantiate the Anthropic provider with provided API key and default URL
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  baseURL: 'https://api.anthropic.com/v1/',
} as AnthropicProviderSettings);

/**
 * Constants for Claude 3.7 Sonnet model: used explicitly throughout the project
 */
const CLAUDE_MODEL_ID = 'claude-3-7-sonnet-20250219';

/**
 * Exported Claude 3.7 model initialized via the Anthropic SDK provider
 */
export const claude37Model = anthropic(CLAUDE_MODEL_ID, {
  sendReasoning: true, // allows internal model reasoning output—useful for complex tasks
});

// =================== Prompt trimming functions ===================
const MinChunkSize = 140; // Minimum acceptable length for a trimmed chunk
const encoder = getEncoding('o200k_base'); // Token encoder matched to Claude's large 200k-context model

/**
 * Helper function to trim prompts to safely fit within the specified token context limit.
 * Uses tokenization (js-tiktoken) to precisely measure and trim prompt.
 *
 * @param prompt - The original prompt to trim.
 * @param contextSize - Maximum allowed token context size. Defaults to environment variable CONTEXT_SIZE or 128_000 tokens.
 * @returns Prompt trimmed within specified token limits.
 */
export function trimPrompt(prompt: string, contextSize = process.env.ANTHROPIC_API_KEY ? 200000 : 128000): string {
  // Returns empty string on empty input
  if (!prompt) return '';

  // Calculates encoded token length
  const length = encoder.encode(prompt).length;

  // Quick return if prompt is already within allowed context size
  if (length <= contextSize) return prompt;

  // Calculates how many tokens we exceed the context size limit by
  const overflowTokens = length - contextSize;

  // Estimates how many characters to remove based on token overflow (assuming ~3 chars per token on average)
  const targetChunkSize = prompt.length - overflowTokens * 3;

  // Edge-case handling—ensures minimal chunk size
  if (targetChunkSize < MinChunkSize) {
    return prompt.slice(0, MinChunkSize);
  }

  // Splits text recursively at optimal boundaries using a helper utility (ensures not cutting mid-sentence)
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: targetChunkSize, chunkOverlap: 0 });
  const trimmedPrompt = splitter.splitText(prompt)[0] ?? '';

  // In rare cases, the splitter may not shorten the prompt sufficiently.
  // Recursively trim further if prompt hasn't reduced.
  if (trimmedPrompt.length === prompt.length) {
    return trimPrompt(prompt.slice(0, targetChunkSize), contextSize);
  }

  // Final check and recursive call to ensure token limit compliance
  return trimPrompt(trimmedPrompt, contextSize);
}