/*!
 * PatentLens - 专利审查文档智能梳理工具 (Tauri版)
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 *
 * 本软件仅供内部使用，未经授权不得对外传播、复制或分发。
 * This software is for internal use only. Unauthorized distribution
 * or reproduction is strictly prohibited.
 *
 * @author Alfred Shi
 * @version 260710
 */
export type AIProviderType = "zhipu" | "deepseek" | "openai";

export interface AIProviderConfig {
  type: AIProviderType;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatChunk {
  content: string;
  done: boolean;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  latency?: number;
}

const STORAGE_KEY = "history-helper-ai-config";

export function getDefaultBaseUrl(type: AIProviderType): string {
  switch (type) {
    case "openai":
      return "https://api.openai.com";
    case "zhipu":
      return "https://open.bigmodel.cn/api/paas";
    case "deepseek":
      return "https://api.deepseek.com";
  }
}

export function getDefaultModels(type: AIProviderType): string[] {
  switch (type) {
    case "openai":
      return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"];
    case "zhipu":
      return ["glm-5.1", "glm-5", "glm-4-plus", "glm-4-flash", "glm-4-air", "glm-4"];
    case "deepseek":
      return ["deepseek-v4-flash", "deepseek-v4-pro"];
  }
}

export function getProviderDisplayName(type: AIProviderType): string {
  switch (type) {
    case "openai":
      return "OpenAI";
    case "zhipu":
      return "智谱 (GLM)";
    case "deepseek":
      return "DeepSeek";
  }
}

function createDefaultConfig(type: AIProviderType): AIProviderConfig {
  return {
    type,
    name: getProviderDisplayName(type),
    apiKey: "",
    baseUrl: getDefaultBaseUrl(type),
    models: getDefaultModels(type),
    defaultModel: getDefaultModels(type)[0] || "",
  };
}

export function loadAIConfig(): Record<string, AIProviderConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {
    openai: createDefaultConfig("openai"),
    zhipu: createDefaultConfig("zhipu"),
    deepseek: createDefaultConfig("deepseek"),
  };
}

export function saveAIConfig(config: Record<string, AIProviderConfig>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function buildUrl(baseUrl: string): string {
  let base = baseUrl.replace(/\/+$/, "");
  if (!base.endsWith("/v1")) {
    base += "/v1";
  }
  return base;
}

export async function* streamChat(
  providerType: AIProviderType,
  apiKey: string,
  baseUrl: string,
  params: ChatParams,
  signal?: AbortSignal
): AsyncGenerator<ChatChunk> {
  const url = `${buildUrl(baseUrl)}/chat/completions`;

  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.1,
    max_tokens: params.maxTokens ?? 16384,
    stream: true,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API 请求失败 (${response.status}): ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取响应流");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        yield { content: "", done: true };
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content || "";
        if (content) {
          yield { content, done: false };
        }
      } catch {
        continue;
      }
    }
  }

  yield { content: "", done: true };
}

export async function testConnection(
  providerType: AIProviderType,
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<ConnectionTestResult> {
  const start = performance.now();
  try {
    const url = `${buildUrl(baseUrl)}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
        stream: false,
      }),
    });
    const latency = Math.round(performance.now() - start);
    if (response.ok) {
      return { success: true, message: `连接成功 (${latency}ms)`, latency };
    }
    const errorText = await response.text();
    return {
      success: false,
      message: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
      latency,
    };
  } catch (err) {
    const latency = Math.round(performance.now() - start);
    return {
      success: false,
      message: `网络错误: ${(err as Error).message}`,
      latency,
    };
  }
}
