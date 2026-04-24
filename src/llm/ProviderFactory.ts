import { GeminiProvider } from './GeminiProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { ClaudeProvider } from './ClaudeProvider.js';
import type { LLMProvider } from '../types/index.js';
import { Logger } from '../utils/logger.js';

export function getLLMProvider(): LLMProvider & { name: string; model: string } {
  const providerType = process.env.LLM_PROVIDER || 'gemini';
  const model = process.env.LLM_MODEL || (providerType === 'gemini' ? 'gemini-2.5-pro' : (providerType === 'openai' ? 'gpt-4o' : 'claude-3-opus-20240229'));
  const apiKey = process.env[providerType === 'gemini' ? 'GEMINI_API_KEY' : (providerType === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY')];

  if (!apiKey) {
    Logger.error(`No API key found for ${providerType}. Please set ${providerType.toUpperCase()}_API_KEY.`);
  }

  let provider: LLMProvider;

  switch (providerType) {
    case 'openai':
      provider = new OpenAIProvider(apiKey || '', model);
      break;
    case 'anthropic':
      provider = new ClaudeProvider(apiKey || '', model);
      break;
    default:
      provider = new GeminiProvider({ apiKey: apiKey || '', model: model as any });
      break;
  }

  return Object.assign(provider, { name: providerType, model });
}
