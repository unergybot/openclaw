import { Type } from "@sinclair/typebox";
/**
 * BestBox Enterprise Agent Tool
 *
 * Routes enterprise queries from OpenClaw to BestBox's LangGraph Agent API.
 * OpenClaw acts as the control plane; BestBox provides domain agents.
 *
 * Performance Optimizations:
 * - force_domain: Skips BestBox router LLM when domain is known (saves 200-500ms)
 * - query_type: Classifies query type at OpenClaw level for faster routing
 * - Direct endpoint: Uses /v1/troubleshooting/query for structured queries (saves 1-3s)
 * - Streaming: Optional SSE streaming for perceived latency improvement
 */
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

interface BestBoxConfig {
  apiUrl: string;
  timeout: number;
  domains: string[];
  enableStreaming?: boolean; // Enable SSE streaming (perceived latency improvement)
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// Query classification patterns for mold domain
const MOLD_QUERY_PATTERNS = {
  // Count/aggregation queries (use STRUCTURED mode, bypass agent)
  count: [/有多少/, /统计/, /多少个/, /有哪些/, /列出所有/, /总共/, /数量/, /count/i, /how many/i],
  // Semantic/how-to queries (use SEMANTIC mode)
  semantic: [
    /怎么/,
    /如何/,
    /原因/,
    /解决/,
    /方案/,
    /为什么/,
    /导致/,
    /how to/i,
    /why/i,
    /solution/i,
  ],
};

// Mold-related keywords for domain detection
const MOLD_KEYWORDS = [
  "披锋",
  "拉白",
  "火花纹",
  "模具",
  "表面污染",
  "毛边",
  "飞边",
  "flash",
  "mold",
  "defect",
  "T0",
  "T1",
  "T2",
  "trial",
  "HIPS",
  "ABS",
  "PC",
  "PP",
  "材料",
  "注塑",
  "成型",
];

/**
 * Classify query type for mold domain queries.
 * Returns: 'count' | 'semantic' | 'hybrid' | null
 */
function classifyMoldQuery(query: string): "count" | "semantic" | "hybrid" | null {
  const isMoldRelated = MOLD_KEYWORDS.some((kw) => query.toLowerCase().includes(kw.toLowerCase()));

  if (!isMoldRelated) {
    return null;
  }

  const isCountQuery = MOLD_QUERY_PATTERNS.count.some((pattern) => pattern.test(query));
  const isSemanticQuery = MOLD_QUERY_PATTERNS.semantic.some((pattern) => pattern.test(query));

  if (isCountQuery && !isSemanticQuery) {
    return "count";
  } else if (isSemanticQuery && !isCountQuery) {
    return "semantic";
  } else if (isCountQuery && isSemanticQuery) {
    return "hybrid";
  }

  // Default to semantic for mold queries without clear pattern
  return "semantic";
}

/**
 * Detect if query is mold-related for automatic domain routing.
 */
function isMoldQuery(query: string): boolean {
  return MOLD_KEYWORDS.some((kw) => query.toLowerCase().includes(kw.toLowerCase()));
}

/**
 * Parse SSE stream from BestBox and collect full response.
 * BestBox uses OpenAI-compatible SSE format.
 */
async function parseSSEStream(response: Response): Promise<{
  content: string;
  agent?: string;
}> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let content = "";
  let agent: string | undefined;
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(data);

          // Handle OpenAI chat completion chunk format
          if (chunk.choices?.[0]?.delta?.content) {
            content += chunk.choices[0].delta.content;
          }

          // Handle Responses API format
          if (chunk.type === "response.output_text.delta" && chunk.delta) {
            content += chunk.delta;
          }

          // Capture agent info from final event
          if (chunk.type === "response.completed" && chunk.response?.agent) {
            agent = chunk.response.agent;
          }
        } catch {
          // Ignore parse errors for malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content, agent };
}

const BestBoxToolSchema = Type.Object({
  query: Type.String({
    description: "The user's enterprise query to route to BestBox agents",
  }),
  domain: Type.Optional(
    Type.String({
      description:
        "Force a specific domain: erp, crm, itops, oa, mold. If omitted, BestBox router classifies automatically.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description: "Additional context from conversation history",
    }),
  ),
  sessionId: Type.Optional(
    Type.String({
      description: "OpenClaw session ID to link with BestBox session for unified memory",
    }),
  ),
  imageUrl: Type.Optional(
    Type.String({
      description: "URL of image for VLM defect analysis (mold domain)",
    }),
  ),
});

export function createBestBoxTool(api: OpenClawPluginApi) {
  return {
    name: "bestbox",
    description: `Route enterprise queries to BestBox domain agents. Domains: ERP (inventory, financials), CRM (leads, quotes), IT Ops (tickets, diagnostics), OA (leave, meetings), Mold (defect analysis, troubleshooting, 披锋/flash detection). Use this tool for enterprise systems, business operations, or workplace workflows.`,
    parameters: BestBoxToolSchema,
    async execute(
      _toolCallId: string,
      params: {
        query: string;
        domain?: string;
        context?: string;
        sessionId?: string;
        imageUrl?: string;
      },
    ) {
      const cfg = api.pluginConfig as BestBoxConfig | undefined;
      const apiUrl = cfg?.apiUrl ?? "http://localhost:8000";
      const timeout = cfg?.timeout ?? 60000;
      const enabledDomains = cfg?.domains ?? ["erp", "crm", "itops", "oa", "mold"];
      const enableStreaming = cfg?.enableStreaming ?? false;

      const textResult = (text: string, details?: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text }],
        details: details ?? {},
      });

      // Helper to return response with images as media attachments
      const mediaResult = (
        text: string,
        imageUrls: string[],
        details?: Record<string, unknown>,
      ) => ({
        content: [
          { type: "text" as const, text },
          ...imageUrls.map((url) => ({ type: "image" as const, url })),
        ],
        details: details ?? {},
      });

      // Extract image URLs from BestBox response text
      // BestBox returns image URLs in formats like:
      // - http://localhost:8000/api/troubleshooting/image/xxx.jpg
      // - {"images": ["url1", "url2"]}
      const extractImageUrls = (responseText: string): string[] => {
        const urls: string[] = [];

        // Try to find JSON blocks with images array
        const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            const jsonData = JSON.parse(jsonMatch[1]);
            if (jsonData.results && Array.isArray(jsonData.results)) {
              for (const result of jsonData.results) {
                if (result.images && Array.isArray(result.images)) {
                  for (const img of result.images) {
                    if (typeof img === "string") {
                      urls.push(img.startsWith("http") ? img : `${apiUrl}${img}`);
                    } else if (img.url) {
                      urls.push(img.url.startsWith("http") ? img.url : `${apiUrl}${img.url}`);
                    }
                  }
                }
              }
            }
          } catch {
            // Ignore JSON parse errors
          }
        }

        // Also extract standalone image URLs from text
        const imageUrlPattern =
          /(?:http[s]?:\/\/[^\s]+\/api\/troubleshooting\/image\/[^\s"']+\.(?:jpg|jpeg|png|webp))/gi;
        const matchedUrls = responseText.match(imageUrlPattern);
        if (matchedUrls) {
          for (const url of matchedUrls) {
            if (!urls.includes(url)) {
              urls.push(url);
            }
          }
        }

        return urls;
      };

      // Validate domain if specified
      if (params.domain && !enabledDomains.includes(params.domain)) {
        return textResult(
          `Domain "${params.domain}" is not enabled. Available: ${enabledDomains.join(", ")}`,
        );
      }

      // Auto-detect mold domain if not specified
      const effectiveDomain = params.domain ?? (isMoldQuery(params.query) ? "mold" : undefined);

      // Classify query type for mold domain (performance optimization)
      const queryType = effectiveDomain === "mold" ? classifyMoldQuery(params.query) : null;

      // OPTIMIZATION: Use direct troubleshooting endpoint for count queries
      // This bypasses the agent entirely, saving 1-3 seconds
      if (effectiveDomain === "mold" && queryType === "count") {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          const directResponse = await fetch(`${apiUrl}/v1/troubleshooting/query`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: params.query,
              mode: "STRUCTURED",
              top_k: 20,
              return_sql: false,
            }),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (directResponse.ok) {
            const data = (await directResponse.json()) as {
              total_found: number;
              results: Array<{ type?: string; problem?: string; [key: string]: unknown }>;
              latency_ms: number;
            };

            // Format count query response
            let responseText = `找到 ${data.total_found} 条相关记录。`;
            if (data.results.length > 0) {
              const sampleResults = data.results.slice(0, 5);
              responseText += "\n\n示例结果:";
              sampleResults.forEach((r, i) => {
                const problem = r.problem ?? JSON.stringify(r);
                responseText += `\n${i + 1}. ${problem.slice(0, 100)}${problem.length > 100 ? "..." : ""}`;
              });
              if (data.results.length > 5) {
                responseText += `\n...还有 ${data.results.length - 5} 条更多结果`;
              }
            }

            return textResult(responseText, {
              agent: "direct_query",
              query_type: "count",
              total_found: data.total_found,
              latency_ms: data.latency_ms,
            });
          }
          // If direct endpoint fails, fall through to agent API
        } catch {
          // Fall through to agent API on error
        }
      }

      // Build messages for BestBox API
      const messages: ChatMessage[] = [];
      if (params.context) {
        messages.push({ role: "system", content: params.context });
      }
      messages.push({ role: "user", content: params.query });

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(`${apiUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(params.sessionId && { "X-OpenClaw-Session": params.sessionId }),
          },
          body: JSON.stringify({
            messages,
            model: "bestbox-enterprise",
            stream: enableStreaming,
            // Pass optimization metadata
            metadata: {
              ...(effectiveDomain && { force_domain: effectiveDomain }),
              ...(queryType && { query_type: queryType }),
            },
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          return textResult(`BestBox API error (${response.status}): ${errorText}`);
        }

        // Handle streaming response
        if (
          enableStreaming &&
          response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          const streamResult = await parseSSEStream(response);
          if (streamResult.content) {
            return textResult(streamResult.content, { agent: streamResult.agent, streamed: true });
          }
          return textResult("BestBox streaming returned no content.");
        }

        // Handle non-streaming response
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          response?: string;
          agent?: string;
        };

        // Handle OpenAI-compatible format
        if (data.choices?.[0]?.message?.content) {
          const content = data.choices[0].message.content;
          const imageUrls = extractImageUrls(content);
          if (imageUrls.length > 0) {
            return mediaResult(content, imageUrls, { agent: data.agent, images: imageUrls.length });
          }
          return textResult(content, { agent: data.agent });
        }

        // Handle BestBox native format
        if (data.response) {
          const agentInfo = data.agent ? ` [${data.agent}]` : "";
          const fullResponse = `${data.response}${agentInfo}`;
          const imageUrls = extractImageUrls(data.response);
          if (imageUrls.length > 0) {
            return mediaResult(fullResponse, imageUrls, {
              agent: data.agent,
              images: imageUrls.length,
            });
          }
          return textResult(fullResponse, { agent: data.agent });
        }

        return textResult("BestBox returned an empty response.");
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return textResult(
            `BestBox request timed out after ${timeout}ms. Check if the Agent API is running at ${apiUrl}`,
          );
        }
        return textResult(
          `BestBox connection error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
