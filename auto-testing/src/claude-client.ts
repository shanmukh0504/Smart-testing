/**
 * Claude AI client using the Anthropic SDK.
 * Requires ANTHROPIC_API_KEY environment variable.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface ChatOptions {
  system: string;
  message: string;
  maxTokens?: number;
}

export interface ClaudeClient {
  chat(options: ChatOptions): Promise<string>;
}

export class APIClaudeClient implements ClaudeClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model || "claude-sonnet-4-20250514";
  }

  async chat(options: ChatOptions): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens || 8192,
      system: options.system,
      messages: [{ role: "user", content: options.message }],
    });
    const block = response.content.find((c) => c.type === "text");
    return block && "text" in block ? block.text : "";
  }
}

/**
 * Create the Claude API client.
 * Requires a valid ANTHROPIC_API_KEY.
 */
export function createClaudeClient(
  apiKey?: string,
  model?: string
): ClaudeClient {
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required. Set it in your .env file.");
  }
  console.log("[AI] Using Anthropic SDK (API key)");
  return new APIClaudeClient(apiKey, model);
}
