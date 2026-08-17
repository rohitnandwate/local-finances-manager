import { generateText, tool, stepCountIs, type ModelMessage } from "ai";
import { z } from "zod";

import { getLlmModel } from "./config.js";
import { type CallUsage, trackUsage } from "./llm-usage.js";
import { getPersonalContextBlock } from "./personal-context.js";
import { type BriefingMetrics, executeArbitraryQuery } from "./query.js";

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

const SYSTEM_PROMPT = `You are a personal financial analyst assistant. You answer follow-up questions using the user's financial data.

## How you work

You have pre-computed financial metrics available as context. You also have a tool called \`query_database\` that lets you run DuckDB SQL against the raw transaction data.

**Decide which approach to use:**
- If the metrics already contain the answer → respond directly with specific numbers.
- If you need data not in the metrics → call the \`query_database\` tool with a DuckDB SQL query.
- You can call the tool multiple times in sequence: run a query, inspect results, refine with another query.

## Tool usage: query_database

The tool executes SQL against a TSV file with these columns:
id, date, authorized_date, institution, item_id, account_id, name, merchant_name, amount, direction, iso_currency_code, pending, pfc_primary, pfc_detailed, pfc_confidence, payment_channel, merchant_entity_id, logo_url, website, counterparties, is_internal_transfer, transfer_pair_id, original_pfc_primary, original_pfc_detailed, override_source

Data conventions:
- amount > 0 = outflow (expense), amount < 0 = inflow (income)
- direction: 'inflow', 'outflow', 'zero', 'unknown'
- pfc_primary / pfc_detailed contain the **effective** (corrected) category. Use these for all standard queries.
- original_pfc_primary / original_pfc_detailed contain the original Plaid-assigned category before any override.
- override_source: 'llm', 'manual', 'merchant_rule', or empty if no override was applied.
- To find overridden transactions: WHERE override_source != '' AND override_source IS NOT NULL
- pfc_primary values: FOOD_AND_DRINK, ENTERTAINMENT, TRANSPORTATION, GENERAL_MERCHANDISE, etc.
- is_internal_transfer: 'true' or 'false' (string, not boolean in the TSV)
- Use read_csv_auto('__TSV_FILE__', delim='\\t', header=true) — the placeholder is replaced automatically.

## Response rules
- Never invent numbers. Every claim must come from the metrics context or a tool result.
- Be concise and specific. Bold key numbers with **markdown**.
- When you run a query and get results, narrate them in plain English — don't just dump JSON.
- If a query fails, explain the error and try a corrected query.
- If personal context mentions budget targets or goals, reference them when relevant.`;

function formatMetricsContext(metrics: BriefingMetrics): string {
  const lines: string[] = [
    `Period: ${metrics.period.from} to ${metrics.period.to}\n`,
  ];
  for (const metric of metrics.metrics) {
    lines.push(`### ${metric.description}`);
    if (metric.rows.length === 0) {
      lines.push("No data.\n");
      continue;
    }
    lines.push(JSON.stringify(metric.rows, null, 2));
    lines.push("");
  }
  return lines.join("\n");
}

const queryToolSchema = z.object({
  sql: z.string().describe("The DuckDB SQL query to execute"),
  reasoning: z
    .string()
    .describe("Brief explanation of why this query answers the question"),
});

type DuckDbRow = Record<string, unknown>;
type QueryToolResult =
  | { success: true; rowCount: number; rows: DuckDbRow[]; truncated: boolean }
  | { success: false; error: string };

function createQueryTool(masterTsvFilename: string) {
  return tool({
    description:
      "Execute a DuckDB SQL query against the transaction data. Use read_csv_auto('__TSV_FILE__', delim='\\t', header=true) to reference the data. The __TSV_FILE__ placeholder is replaced automatically.",
    inputSchema: queryToolSchema,
    execute: async ({ sql }): Promise<QueryToolResult> => {
      try {
        const rows = await executeArbitraryQuery(masterTsvFilename, sql);
        return {
          success: true,
          rowCount: rows.length,
          rows: rows.slice(0, 50),
          truncated: rows.length > 50,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    },
  });
}

export async function askQuestion(
  question: string,
  metrics: BriefingMetrics,
  conversationHistory: ConversationMessage[],
  masterTsvFilename: string,
): Promise<{
  answer: string;
  conversation: ConversationMessage[];
  usage: CallUsage[];
}> {
  const model = getLlmModel();
  const context = formatMetricsContext(metrics);
  const personalContext = await getPersonalContextBlock();

  const systemContent = personalContext
    ? `${SYSTEM_PROMPT}\n\n${personalContext}`
    : SYSTEM_PROMPT;

  const messages: ModelMessage[] = [
    { role: "system", content: systemContent },
    {
      role: "system",
      content: `Here are the pre-computed financial metrics for context:\n\n${context}`,
    },
    ...conversationHistory.map(
      (msg) =>
        ({
          role: msg.role,
          content: msg.content,
        }) as ModelMessage,
    ),
    { role: "user", content: question },
  ];

  const response = await generateText({
    model,
    messages,
    tools: {
      query_database: createQueryTool(masterTsvFilename),
    },
    stopWhen: stepCountIs(5),
    temperature: 0.3,
    maxOutputTokens: 2000,
    onStepFinish: ({ toolCalls }) => {
      for (const tc of toolCalls) {
        const input = tc.input as { sql?: string };
        console.log("[ask] tool call:", tc.toolName, input.sql?.slice(0, 120));
      }
    },
  });

  const usageLog: CallUsage[] = [];
  usageLog.push(trackUsage("ask", response.usage));

  const answer = response.text || "Unable to generate answer.";

  const updatedHistory: ConversationMessage[] = [
    ...conversationHistory,
    { role: "user", content: question },
    { role: "assistant", content: answer },
  ];

  return { answer, conversation: updatedHistory, usage: usageLog };
}
