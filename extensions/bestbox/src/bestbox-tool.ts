/**
 * BestBox Enterprise Agent Tool
 *
 * Routes enterprise queries from OpenClaw to BestBox's LangGraph Agent API.
 * OpenClaw acts as the control plane; BestBox provides domain agents.
 */
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { Type } from "@sinclair/typebox";

interface BestBoxConfig {
  apiUrl: string;
  timeout: number;
  domains: string[];
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface BestBoxResponse {
  response: string;
  agent: string;
  trace?: Array<{ node: string; duration_ms: number }>;
}

export function createBestBoxTool(api: OpenClawPluginApi) {
  return {
    name: "bestbox",
    description: `Route enterprise queries to BestBox domain agents. Domains: ERP (invoices, inventory, financials), CRM (leads, opportunities, quotes), IT Ops (tickets, KB search, diagnostics), OA (leave, meetings, documents). Use this tool when the user asks about enterprise systems, business operations, or workplace workflows.`,
    inputSchema: Type.Object({
      query: Type.String({
        description: "The user's enterprise query to route to BestBox agents",
      }),
      domain: Type.Optional(
        Type.String({
          description:
            "Force a specific domain: erp, crm, itops, oa. If omitted, BestBox router classifies automatically.",
        })
      ),
      context: Type.Optional(
        Type.String({
          description: "Additional context from conversation history",
        })
      ),
    }),
    async handler(
      input: { query: string; domain?: string; context?: string },
      _ctx: unknown
    ): Promise<string> {
      const cfg = api.pluginConfig as BestBoxConfig | undefined;
      const apiUrl = cfg?.apiUrl ?? "http://localhost:8000";
      const timeout = cfg?.timeout ?? 60000;
      const enabledDomains = cfg?.domains ?? ["erp", "crm", "itops", "oa"];

      // Validate domain if specified
      if (input.domain && !enabledDomains.includes(input.domain)) {
        return `Domain "${input.domain}" is not enabled. Available: ${enabledDomains.join(", ")}`;
      }

      // Build messages for BestBox API
      const messages: ChatMessage[] = [];
      if (input.context) {
        messages.push({ role: "system", content: input.context });
      }
      messages.push({ role: "user", content: input.query });

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(`${apiUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages,
            model: "bestbox-enterprise",
            stream: false,
            // Pass domain hint if specified
            ...(input.domain && { metadata: { force_domain: input.domain } }),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          return `BestBox API error (${response.status}): ${errorText}`;
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          response?: string;
          agent?: string;
        };

        // Handle OpenAI-compatible format
        if (data.choices?.[0]?.message?.content) {
          return data.choices[0].message.content;
        }

        // Handle BestBox native format
        if (data.response) {
          const agentInfo = data.agent ? ` [${data.agent}]` : "";
          return `${data.response}${agentInfo}`;
        }

        return "BestBox returned an empty response.";
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return `BestBox request timed out after ${timeout}ms. Check if the Agent API is running at ${apiUrl}`;
        }
        return `BestBox connection error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
