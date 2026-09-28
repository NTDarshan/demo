// AI settings. Server-side only, like the Supabase service key: the OpenAI key is read from
// the environment inside route handlers and never reaches the browser bundle.
//
//   OPENAI_API_KEY   required for any AI feature; without it the features are hidden
//   OPENAI_MODEL     optional, defaults to gpt-4.1-mini

import { ChatOpenAI } from "@langchain/openai";

export const DEFAULT_MODEL = "gpt-4.1-mini";

export type AiConfig = { apiKey: string; model: string };

export function aiConfig(): AiConfig | null {
  if (typeof window !== "undefined") {
    throw new Error("aiConfig() was called in the browser. The OpenAI key is server-side only.");
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey.length < 20) return null;
  return { apiKey, model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL };
}

export function aiEnabled(): boolean {
  return aiConfig() !== null;
}

/**
 * The chat model used by every AI feature. Temperature 0 because these are finance answers:
 * the same case should get the same diagnosis. Timeout and retries keep a slow API from
 * hanging a request.
 */
export function chatModel(config: AiConfig): ChatOpenAI {
  return new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.model,
    temperature: 0,
    timeout: 45_000,
    maxRetries: 2,
  });
}
