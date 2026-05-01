import OpenAI from 'openai';
import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMOptions,
  ToolDefinition
} from '../types/index.js';
import { withRetry } from '../utils/retry.js';
import { Logger } from '../utils/logger.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly supportsAttachments = false;
  private client: OpenAI;

  constructor(apiKey: string, private model: string = 'gpt-4o') {
    this.client = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }

  async chat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    options: LLMOptions = {},
  ): Promise<LLMResponse> {
    const isKimi = this.model.toLowerCase().includes('moonshot') || this.model.toLowerCase().includes('kimi');

    // Kimi/Moonshot requires temperature: 1
    const temperature = isKimi ? 1 : (options.temperature ?? 0.1);

    const isDeepSeek = this.model.toLowerCase().includes('deepseek') || (process.env.OPENAI_BASE_URL?.includes('deepseek') ?? false);

    // DeepSeek and some other providers require "json" in the prompt when using response_format: { type: 'json_object' }
    let processedMessages = messages.map(msg => ({
      role: msg.role === 'tool' ? 'tool' : msg.role,
      content: msg.content,
      tool_call_id: msg.toolCallId,
      ...(msg.reasoningContent ? { reasoning_content: msg.reasoningContent } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...((msg.role === 'assistant' && msg.toolCalls) ? {
        tool_calls: msg.toolCalls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }))
      } : {})
    }));

    if (options.responseFormat?.type === 'json_object' && isDeepSeek) {
      const lastMsg = processedMessages[processedMessages.length - 1];
      if (lastMsg && typeof lastMsg.content === 'string') {
        let jsonInstruction = '\n\nIMPORTANT: You must respond in valid JSON format.';
        if (options.responseFormat.schema) {
          jsonInstruction += ` Follow this JSON schema:\n${JSON.stringify(options.responseFormat.schema, null, 2)}`;
        }
        if (!lastMsg.content.toLowerCase().includes('json')) {
          lastMsg.content += jsonInstruction;
        } else if (options.responseFormat.schema) {
          lastMsg.content += `\n\nSchema for JSON response:\n${JSON.stringify(options.responseFormat.schema, null, 2)}`;
        }
      }
    }

    try {
      const response = await withRetry(
        () => this.client.chat.completions.create({
          model: this.model,
          messages: processedMessages as any,
          tools: tools.length > 0 ? tools.map(t => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }
          })) : undefined,
          temperature,
          max_tokens: options.maxTokens,
          response_format: options.responseFormat?.type === 'json_object' 
            ? (options.responseFormat.schema && !isDeepSeek 
                ? { type: 'json_schema', json_schema: { name: 'response', schema: options.responseFormat.schema as any, strict: true } } 
                : { type: 'json_object' })
            : undefined,
        } as any),
        { maxAttempts: 5, delay: 2000 }
      ) as any;

      const choice = response.choices[0];
      const message = choice.message;

      return {
        content: message.content || undefined,
        reasoningContent: (message as any).reasoning_content || undefined,
        toolCalls: message.tool_calls?.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          name: (tc as any).function.name,
          arguments: JSON.parse((tc as any).function.arguments)
        })),
        finishReason: this.mapFinishReason(choice.finish_reason),
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
          cacheHitTokens: (response.usage as any)?.prompt_tokens_details?.cached_tokens || 0,
          cacheMissTokens: (response.usage?.prompt_tokens || 0) - ((response.usage as any)?.prompt_tokens_details?.cached_tokens || 0),
        }
      };
    } catch (error) {
      Logger.error(`OpenAI Error (${this.model}):`, error);
      throw error;
    }
  }

  private mapFinishReason(reason: string): 'stop' | 'tool_use' | 'max_tokens' | 'error' {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_tokens';
      default: return 'error';
    }
  }
}
