import fs from 'fs';
import { GoogleGenAI, type Content, type Tool, type FunctionDeclaration, type Schema } from '@google/genai';
import { withRetry } from '../utils/retry.js';
import { Logger } from '../utils/logger.js';
import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMOptions,
  LLMToolCall,
  ToolDefinition,
  JSONSchemaProperty,
} from '../types/index.js';

export type GeminiModel =
  | 'gemini-3-flash-preview'
  | 'gemini-3.1-flash-lite-preview'
  | 'gemini-3.1-pro-preview'
  | 'gemini-3-pro-preview';

export interface GeminiProviderOptions {
  model?: GeminiModel;
  apiKey?: string;
}

const MAX_REQUEST_CHARS = 1000000; // 1M chars safety limit

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly client: GoogleGenAI;
  constructor(options: GeminiProviderOptions = {}) {
    const apiKey = options.apiKey || process.env['GEMINI_API_KEY'];
    const vertexProject = process.env['VERTEX_PROJECT_ID'];
    const vertexLocation = process.env['VERTEX_LOCATION'] ?? 'global';

    if (vertexProject) {
      this.client = new GoogleGenAI({
        project: vertexProject,
        location: vertexLocation,
        vertexai: true,
        httpOptions: vertexLocation === 'global' ? { baseUrl: 'https://aiplatform.googleapis.com/' } : undefined
      });
    } else if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
    } else {
      throw new Error('Either GEMINI_API_KEY or VERTEX_PROJECT_ID is required to initialize GeminiProvider.');
    }

    this.model = options.model ?? 'gemini-3-flash-preview';
  }

  async chat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    options: LLMOptions = {},
  ): Promise<LLMResponse> {
    const { systemInstruction, history, lastUserMessage } = this.buildContents(messages);

    const geminiTools: Tool[] = tools.length > 0
      ? [{ functionDeclarations: tools.map(this.toolToFunctionDeclaration.bind(this)) }]
      : [];

    // Safety truncation
    let finalUserMessage = lastUserMessage;
    const firstPart = Array.isArray(finalUserMessage) ? (finalUserMessage[0] as any).text : finalUserMessage;
    
    if (typeof firstPart === 'string' && firstPart.length > MAX_REQUEST_CHARS) {
      Logger.warn(`Trimming extremely large user message from ${firstPart.length} to ${MAX_REQUEST_CHARS} chars.`);
      const trimmed = firstPart.substring(0, MAX_REQUEST_CHARS) + "\n\n[TRUNCATED DUE TO SIZE]";
      if (Array.isArray(finalUserMessage)) {
        (finalUserMessage[0] as any).text = trimmed;
      } else {
        finalUserMessage = trimmed;
      }
    }

    const msgLen = typeof firstPart === 'string' ? firstPart.length : 0;
    Logger.info(`Gemini Request: model=${this.model}, systemInstrLen=${systemInstruction.length}, historyLen=${history.length}, lastMsgLen=${msgLen}, parts=${Array.isArray(finalUserMessage) ? finalUserMessage.length : 1}`);

    const chat = this.client.chats.create({
      model: this.model,
      config: {
        systemInstruction,
        temperature: options.temperature ?? 0.1,
        maxOutputTokens: options.maxTokens ?? 8192,
        tools: geminiTools,
      },
      history,
    });

    try {
      const response = await withRetry(
        () => chat.sendMessage({ message: finalUserMessage as any }),
        { maxAttempts: 5, delay: 2000 }
      );

      // Extract text content
      const textParts = response.candidates?.[0]?.content?.parts
        ?.filter((p: any) => p.text)
        .map((p: any) => p.text ?? '')
        .join('') ?? '';

      const functionCallParts = response.candidates?.[0]?.content?.parts?.filter(
        (p: any) => p.functionCall,
      ) ?? [];

      if (!textParts && functionCallParts.length === 0) {
        Logger.debug("Empty response from Gemini:", JSON.stringify(response, null, 2));
      }

      const toolCalls: LLMToolCall[] = functionCallParts.map((p, idx: number) => ({
        id: `gemini-call-${Date.now()}-${idx}`,
        type: 'function',
        name: p.functionCall!.name ?? '',
        arguments: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      }));

      const finishReason = this.mapFinishReason(
        response.candidates?.[0]?.finishReason ?? 'STOP',
      );

      const usage = {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      };

      if (response.usageMetadata) {
        Logger.info(`Gemini Usage: Prompt=${response.usageMetadata.promptTokenCount}, Candidates=${response.usageMetadata.candidatesTokenCount}, Total=${response.usageMetadata.totalTokenCount}`);
      }

      return {
        content: textParts || undefined,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason,
        usage,
      } as LLMResponse;
    } catch (e: any) {
      Logger.error(`Gemini Chat Error: ${e.message}`, e);
      if (e.message.includes('INVALID_ARGUMENT')) {
        const preview = Array.isArray(finalUserMessage) 
          ? JSON.stringify(finalUserMessage).substring(0, 500)
          : finalUserMessage.substring(0, 500);
        Logger.error(`Request Detail: lastUserMessage preview: ${preview}...`);
      }
      throw e;
    }
  }

  async streamChat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    options: LLMOptions = {},
  ): Promise<LLMResponse> {
    const { systemInstruction, history, lastUserMessage } = this.buildContents(messages);

    const geminiTools: Tool[] = tools.length > 0
      ? [{ functionDeclarations: tools.map(this.toolToFunctionDeclaration.bind(this)) }]
      : [];

    const model = (this.client as any).getGenerativeModel({ model: this.model });
    
    const result = await model.generateContentStream({
      systemInstruction: systemInstruction ? { role: 'system', parts: [{ text: systemInstruction }] } : undefined,
      contents: [...history, { role: 'user', parts: [{ text: lastUserMessage }] }],
      config: {
        temperature: options.temperature ?? 0.1,
        maxOutputTokens: options.maxTokens ?? 8192,
        tools: geminiTools,
      }
    });

    let fullText = '';
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      fullText += chunkText;
      onChunk(chunkText);
    }

    const response = await result.response;
    const usage = {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };

    return {
      content: fullText || undefined,
      finishReason: 'stop',
      usage,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private buildContents(messages: LLMMessage[]): {
    systemInstruction: string;
    history: Content[];
    lastUserMessage: string;
  } {
    let systemInstruction = '';
    const history: Content[] = [];
    let lastUserMessage = '';

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;

      if (msg.role === 'system') {
        systemInstruction = msg.content;
        continue;
      }

      if (i === messages.length - 1 && msg.role === 'user') {
        // The last user message goes into sendMessage, not history
        lastUserMessage = msg.content;
        continue;
      }

      if (msg.role === 'user') {
        const parts: any[] = [{ text: msg.content }];
        if (msg.attachments) {
          for (const attachment of msg.attachments) {
            if (attachment.data) {
              parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
            } else if (fs.existsSync(attachment.path)) {
              const data = fs.readFileSync(attachment.path).toString('base64');
              parts.push({ inlineData: { mimeType: attachment.mimeType, data } });
            }
          }
        }
        history.push({ role: 'user', parts });
      } else if (msg.role === 'assistant') {
        const parts: Content['parts'] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
          }
        }
        history.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        // Tool results go as function response parts on the user turn
        history.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.toolName ?? 'unknown',
              response: { output: msg.content },
            },
          }],
        });
      }
    }

    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user' && lastMsg.attachments && lastMsg.attachments.length > 0) {
      const parts: any[] = [{ text: lastUserMessage || 'Analyzing documents...' }];
      for (const attachment of lastMsg.attachments) {
        if (attachment.data) {
          parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
        } else if (fs.existsSync(attachment.path)) {
          const data = fs.readFileSync(attachment.path).toString('base64');
          parts.push({ inlineData: { mimeType: attachment.mimeType, data } });
        }
      }
      return { systemInstruction, history, lastUserMessage: parts as any };
    }

    return { systemInstruction, history, lastUserMessage: lastUserMessage || 'Analyzing...' };
  }

  private toolToFunctionDeclaration(tool: ToolDefinition): FunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'OBJECT' as Schema['type'],
        properties: Object.fromEntries(
          Object.entries(tool.parameters.properties).map(([key, prop]) => [
            key,
            jsonSchemaPropToGeminiSchema(prop),
          ]),
        ),
        required: tool.parameters.required ?? [],
      },
    };
  }

  private mapFinishReason(reason: string): LLMResponse['finishReason'] {
    switch (reason.toUpperCase()) {
      case 'STOP':
      case 'MAX_TOKENS':
        return reason.toUpperCase() === 'MAX_TOKENS' ? 'max_tokens' : 'stop';
      case 'TOOL_USE':
      case 'FUNCTION_CALL':
        return 'tool_use';
      default:
        return 'stop';
    }
  }
}

function jsonSchemaPropToGeminiSchema(prop: JSONSchemaProperty): Schema {
  const typeMap: Record<string, string> = {
    string: 'STRING',
    number: 'NUMBER',
    boolean: 'BOOLEAN',
    array: 'ARRAY',
    object: 'OBJECT',
  };

  const schema: Schema = {
    type: (typeMap[prop.type] ?? 'STRING') as Schema['type'],
    description: prop.description,
  };

  if (prop.enum) schema.enum = prop.enum;
  if (prop.type === 'array' && prop.items) {
    schema.items = jsonSchemaPropToGeminiSchema(prop.items);
  }

  return schema;
}
