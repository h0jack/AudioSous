/**
 * The model provider abstraction. The orchestrator speaks only these types; a provider translates them to and
 * from its own API (tools, content blocks, stop reasons). Nothing here is vendor-specific.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object schema). */
  parameters: Record<string, unknown>;
}

export type AgentContent =
  | { type: "text"; text: string }
  | { type: "tool-call"; callId: string; name: string; arguments: unknown }
  | { type: "tool-result"; callId: string; content: string; isError: boolean };

export interface AgentMessage {
  role: "user" | "assistant";
  content: AgentContent[];
  /**
   * The provider's own form of an assistant message (for example, content blocks with reasoning that must be sent
   * back unchanged inside the same request loop). Opaque to the orchestrator; only the provider that produced it
   * reads it.
   */
  providerData?: unknown;
}

export interface AgentRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface AgentResponse {
  content: Array<Extract<AgentContent, { type: "text" | "tool-call" }>>;
  stop: "end" | "tool" | "max-tokens" | "refusal" | "other";
  providerData?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ProviderInfo {
  /** "anthropic", "openai", "local", … */
  provider: string;
  model: string;
  /** Shown in the privacy disclosure. */
  label: string;
  /** True when requests leave this computer. */
  remote: boolean;
}

export interface AgentModel {
  info: ProviderInfo;
  complete(request: AgentRequest): Promise<AgentResponse>;
}

/** A provider failure the panel can show as is. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "not-configured" | "auth" | "rate-limit" | "unavailable" | "refused" | "invalid" | "cancelled",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
