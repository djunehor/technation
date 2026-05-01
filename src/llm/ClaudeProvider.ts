import Anthropic from '@anthropic-ai/sdk';
import type { 
  LLMProvider, 
  LLMMessage, 
  LLMResponse, 
  ToolDefinition 
} from '../types/index.js';
import { Logger } from '../utils/logger.js';

export class ClaudeProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly supportsAttachments = false;
  private client: Anthropic;

  constructor(apiKey: string, private model: string = 'claude-3-opus-20240229') {
    this.client = new Anthropic({ apiKey });
  }

  async chat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<LLMResponse> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        messages: messages
          .filter(msg => msg.role !== 'system')
          .map(msg => ({
            role: msg.role === 'tool' ? 'user' : (msg.role as 'user' | 'assistant'),
            content: msg.role === 'tool' 
              ? [{ type: 'tool_result', tool_use_id: msg.toolCallId!, content: msg.content }]
              : msg.toolCalls 
                ? [
                    { type: 'text', text: msg.content },
                    ...msg.toolCalls.map(tc => ({
                      type: 'tool_use' as const,
                      id: tc.id,
                      name: tc.name,
                      input: tc.arguments
                    }))
                  ]
                : msg.content
          })) as any,
        system: messages.find(msg => msg.role === 'system')?.content,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as any
        })),
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0,
      });

      const content = response.content.find((c): c is Anthropic.Messages.TextBlock => c.type === 'text');
      const toolCalls = response.content
        .filter((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use')
        .map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          name: tc.name,
          arguments: tc.input as Record<string, any>
        }));

      return {
        content: content?.type === 'text' ? content.text : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: this.mapFinishReason(response.stop_reason || ''),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheHitTokens: (response.usage as any).cache_read_input_tokens || 0,
          cacheMissTokens: response.usage.input_tokens - ((response.usage as any).cache_read_input_tokens || 0),
        }
      };
    } catch (error) {
      Logger.error(`Claude Error (${this.model}):`, error);
      throw error;
    }
  }

  private mapFinishReason(reason: string): 'stop' | 'tool_use' | 'max_tokens' | 'error' {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'tool_use': return 'tool_use';
      case 'max_tokens': return 'max_tokens';
      default: return 'error';
    }
  }
}
