/**
 * Core types for the Financial Agent.
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LLMAttachment {
  type: 'file';
  name?: string;
  mimeType: string;
  path: string;
  /** Optional inline data if we don't want to use File API */
  data?: string; 
}

export interface LLMMessage {
  role: MessageRole;
  content: string;
  reasoningContent?: string;
  toolCalls?: LLMToolCall[];
  toolCallId?: string;
  toolName?: string;
  attachments?: LLMAttachment[];
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments: Record<string, any>;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

export interface LLMResponse {
  content?: string;
  /** Chain of thought or thinking process provided by some models */
  reasoningContent?: string;
  toolCalls?: LLMToolCall[];
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
  usage?: LLMUsage;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: {
    type: 'json_object' | 'text';
    schema?: JSONSchemaProperty;
  };
}

export interface LLMProvider {
  chat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    options?: LLMOptions
  ): Promise<LLMResponse>;

  streamChat?(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    options?: LLMOptions
  ): Promise<LLMResponse>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
  execute(params: Record<string, any>): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolCallLog {
  iteration: number;
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments: any;
  params: Record<string, any>;
  result: ToolResult;
  timestamp: Date;
}

export interface AgentResult {
  answer: string;
  reasoning: string[];
  toolCallsLog: ToolCallLog[];
  iterations: number;
  usage: LLMUsage;
  messages: LLMMessage[];
}

export interface FinancialAnswer {
  answer: string;
  confidence: number;
  supportingData: string[];
  calculationsVerified: boolean;
  rawAgentResult: AgentResult;
}

export interface ConsensusResult {
  agreed: boolean;
  confidence: 'high' | 'medium' | 'low';
  answer: string;
  providerAnswer: FinancialAnswer;
  verifierAnswer: FinancialAnswer;
  discrepancy?: string;
  totalUsage: LLMUsage;
  totalCostUSD: number;
  durationMs: number;
}

export interface ConversionResult {
  text: string;
  originalFormat: string;
  sheetNames?: string[];
  pageCount?: number;
  warnings: string[];
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export type StreamingEvent = 
  | { type: 'status', message: string }
  | { type: 'thought', content: string }
  | { type: 'tool_call', name: string, args: any }
  | { type: 'observation', content: string }
  | { type: 'error', message: string }
  | { type: 'final_answer', content: string };
