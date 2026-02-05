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

const BestBoxToolSchema = Type.Object({
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
});

export function createBestBoxTool(api: OpenClawPluginApi) {
  return {
    name: "bestbox",
    description: `Route enterprise queries to BestBox domain agents. Domains: ERP (invoices, inventory, financials), CRM (leads, opportunities, quotes), IT Ops (tickets, KB search, diagnostics), OA (leave, meetings, documents). Use this tool when the user asks about enterprise systems, business operations, or workplace workflows.`,
    parameters: BestBoxToolSchema,
    async execute(
      _toolCallId: string,
      params: { query: string; domain?: string; context?: string }
    ) {
      const cfg = api.pluginConfig as BestBoxConfig | undefined;
      const apiUrl = cfg?.apiUrl ?? "http://localhost:8000";
      const timeout = cfg?.timeout ?? 60000;
      const enabledDomains = cfg?.domains ?? ["erp", "crm", "itops", "oa"];

      const textResult = (text: string, details?: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text }],
        details: details ?? {},
      });

      // Validate domain if specified
      if (params.domain && !enabledDomains.includes(params.domain)) {
        return textResult(
          `Domain "${params.domain}" is not enabled. Available: ${enabledDomains.join(", ")}`
        );
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
          },
          body: JSON.stringify({
            messages,
            model: "bestbox-enterprise",
            stream: false,
            // Pass domain hint if specified
            ...(params.domain && { metadata: { force_domain: params.domain } }),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          return textResult(`BestBox API error (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          response?: string;
          agent?: string;
        };

        // Handle OpenAI-compatible format
        if (data.choices?.[0]?.message?.content) {
          return textResult(data.choices[0].message.content, { agent: data.agent });
        }

        // Handle BestBox native format
        if (data.response) {
          const agentInfo = data.agent ? ` [${data.agent}]` : "";
          return textResult(`${data.response}${agentInfo}`, { agent: data.agent });
        }

        return textResult("BestBox returned an empty response.");
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return textResult(
            `BestBox request timed out after ${timeout}ms. Check if the Agent API is running at ${apiUrl}`
          );
        }
        return textResult(
          `BestBox connection error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}
