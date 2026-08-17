import { generateText } from "ai";

import { getLlmModel } from "./config.js";
import { type CallUsage, trackUsage } from "./llm-usage.js";
import { getPersonalContextBlock } from "./personal-context.js";
import { type BriefingMetrics } from "./query.js";

const SYSTEM_PROMPT = `You are a brutally honest personal financial analyst. You help one person — the user running this app locally — make better money decisions every week.

## Your personality
- Direct and specific. Never vague. Never upbeat filler like "Great job keeping costs down!" unless the numbers actually warrant it.
- You speak in concrete dollar amounts and percentages, not generalities.
- When something is bad, say it plainly: "You're overspending on X by $Y compared to your target."
- When something is unusual, flag it with context: "This $300 charge at [merchant] is 4x your average in this category."

## Output structure

Use this exact structure with markdown formatting:

### What's Going Well
Positive trends, categories under control relative to targets, income stability. 2-4 bullet points with specific numbers.

### What Needs Attention
Overspending, negative month-over-month trends, pace concerns (projected to exceed target). 2-4 bullet points. Be specific about the gap.

### What's Unusual
Anomalous transactions, missing expected patterns, one-off large charges. Include the merchant name and amount.

### Bottom Line
One sentence. The single most important thing to act on this period.

## Rules
- Every number you cite MUST appear in the provided data. Never estimate, round creatively, or infer amounts.
- If personal context includes budget targets, compare actual spending against them explicitly.
- If personal context includes goals, note relevant progress or regression.
- If data is missing or insufficient for a section, say so rather than padding.
- Aim for 300-500 words total. Density over length.`;

function formatMetricsForContext(metrics: BriefingMetrics): string {
  const lines: string[] = [
    `## Financial Data — ${metrics.period.from} to ${metrics.period.to}\n`,
  ];

  for (const metric of metrics.metrics) {
    lines.push(`### ${metric.description}`);
    if (metric.rows.length === 0) {
      lines.push("No data available for this metric.\n");
      continue;
    }
    const headers = Object.keys(metric.rows[0]!);
    lines.push(`| ${headers.join(" | ")} |`);
    lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of metric.rows) {
      const values = headers.map((h) => {
        const val = row[h];
        return val === null || val === undefined ? "" : String(val);
      });
      lines.push(`| ${values.join(" | ")} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function generateBriefing(
  metrics: BriefingMetrics,
): Promise<{ text: string; usage: CallUsage }> {
  const context = formatMetricsForContext(metrics);
  const personalContext = await getPersonalContextBlock();

  const systemPrompt = personalContext
    ? `${SYSTEM_PROMPT}\n\n${personalContext}`
    : SYSTEM_PROMPT;

  const result = await generateText({
    model: getLlmModel(),
    system: systemPrompt,
    prompt: `Generate a financial briefing for the period ${metrics.period.from} to ${metrics.period.to}.\n\nHere is the pre-computed data:\n\n${context}`,
    temperature: 0.3,
    maxOutputTokens: 2000,
  });

  const usage = trackUsage("briefing", result.usage);
  return { text: result.text || "Unable to generate briefing.", usage };
}
