import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type AgentContent, type AgentModel, type AgentRequest, type AgentResponse } from "../model";

/**
 * The Anthropic provider: the official SDK behind the neutral `AgentModel`. In the desktop app the SDK's `fetch` is
 * routed through the Tauri shell, which adds the API key and only talks to the Messages endpoint, so the key never
 * enters the webview or a prompt. Tests pass their own `fetch`.
 */

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_EFFORTS = ["low", "medium", "high"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

export interface AnthropicOptions {
  model?: string;
  /** Thinking depth and spend. Medium keeps a diagnostic turn to a few seconds. */
  effort?: AnthropicEffort;
  /** A fetch that reaches the API. The desktop's adds the key in the shell. */
  fetch?: typeof fetch;
  /** Only when the key is held by the caller (scripts). Never set in the desktop webview. */
  apiKey?: string;
  maxRetries?: number;
}

type Block = Anthropic.Beta.Messages.BetaContentBlock;
type BlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

export function anthropicModel(options: AnthropicOptions = {}): AgentModel {
  const model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
  const client = new Anthropic({
    // In the desktop the shell replaces this placeholder with the stored key; the real key is never in JavaScript.
    apiKey: options.apiKey ?? "key-held-by-the-desktop-shell",
    maxRetries: options.maxRetries ?? 1,
    timeout: 120_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    // The webview never holds a key: the custom fetch goes through the native shell, which adds it.
    dangerouslyAllowBrowser: true,
  });
  return {
    info: { provider: "anthropic", model, label: `Anthropic (${model})`, remote: true },
    async complete(request: AgentRequest): Promise<AgentResponse> {
      try {
        const response = await client.beta.messages.create(
          {
            model,
            max_tokens: request.maxTokens,
            system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
            tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema })),
            tool_choice: { type: "auto" },
            thinking: { type: "adaptive" },
            output_config: { effort: options.effort ?? "medium" },
            // On a policy decline the API re-runs the same request on a fallback model inside the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            messages: request.messages.map(toParam),
          },
          request.signal ? { signal: request.signal } : undefined,
        );
        return fromResponse(response);
      } catch (caught) {
        throw providerError(caught);
      }
    },
  };
}

function toParam(message: AgentRequest["messages"][number]): Anthropic.Beta.Messages.BetaMessageParam {
  if (message.role === "assistant") {
    // Replayed unchanged (thinking and fallback blocks included) inside the same request loop.
    if (Array.isArray(message.providerData)) return { role: "assistant", content: (message.providerData as Block[]).map(blockToParam) };
    return { role: "assistant", content: message.content.map(contentToParam) };
  }
  return { role: "user", content: message.content.map(contentToParam) };
}

function contentToParam(content: AgentContent): BlockParam {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "tool-call":
      return { type: "tool_use", id: content.callId, name: content.name, input: (content.arguments ?? {}) as Record<string, unknown> };
    case "tool-result":
      return { type: "tool_result", tool_use_id: content.callId, content: content.content, is_error: content.isError };
  }
}

/** A response block as a request block, unchanged in content. */
function blockToParam(block: Block): BlockParam {
  return block as unknown as BlockParam;
}

function fromResponse(response: Anthropic.Beta.Messages.BetaMessage): AgentResponse {
  const content: AgentResponse["content"] = [];
  for (const block of response.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") content.push({ type: "tool-call", callId: block.id, name: block.name, arguments: block.input });
  }
  const stop = response.stop_reason === "end_turn" ? "end" : response.stop_reason === "tool_use" ? "tool" : response.stop_reason === "max_tokens" ? "max-tokens" : response.stop_reason === "refusal" ? "refusal" : "other";
  return { content, stop, providerData: response.content, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
}

function providerError(caught: unknown): ProviderError {
  if (caught instanceof ProviderError) return caught;
  if (caught instanceof Anthropic.APIUserAbortError) return new ProviderError("Cancelled.", "cancelled");
  if (caught instanceof Anthropic.AuthenticationError || caught instanceof Anthropic.PermissionDeniedError) return new ProviderError("The AI provider rejected the API key. Check it in Assistant settings.", "auth");
  if (caught instanceof Anthropic.RateLimitError) return new ProviderError("The AI provider is rate-limiting requests. Try again in a moment.", "rate-limit");
  if (caught instanceof Anthropic.BadRequestError || caught instanceof Anthropic.NotFoundError) return new ProviderError(`The AI provider refused the request: ${caught.message}`, "invalid");
  if (caught instanceof Anthropic.APIConnectionError) return new ProviderError("Could not reach the AI provider. Check the connection; mixing works without it.", "unavailable");
  if (caught instanceof Anthropic.APIError) return new ProviderError(`The AI provider failed (${caught.status ?? "no status"}). Mixing works without it.`, "unavailable");
  if (caught instanceof Error && caught.name === "AbortError") return new ProviderError("Cancelled.", "cancelled");
  return new ProviderError(caught instanceof Error ? caught.message : "The AI provider failed.", "unavailable");
}
