import type { LanguageModelUsage } from "ai";

import { config } from "./config.js";

export type CallUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};

export type SessionUsage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};

type ModelPricing = { input: number; output: number };

/**
 * Approximate per-token pricing (USD per 1M tokens).
 * Updated periodically — treat as estimates, not invoices.
 */
const PRICING: Record<string, ModelPricing> = {
  "gpt-4o":            { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":       { input: 0.15,  output: 0.60  },
  "gpt-4.1":           { input: 2.00,  output: 8.00  },
  "gpt-4.1-mini":      { input: 0.40,  output: 1.60  },
  "claude-sonnet-4-5": { input: 3.00,  output: 15.00 },
  "claude-sonnet-4":   { input: 3.00,  output: 15.00 },
  "claude-haiku-4-5":  { input: 0.80,  output: 4.00  },
  "gemini-2.0-flash":  { input: 0.10,  output: 0.40  },
  "gemini-2.5-pro":    { input: 1.25,  output: 10.00 },
  "gemini-2.5-flash":  { input: 0.15,  output: 0.60  },
};

function estimateCost(
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = PRICING[config.llm.model];
  if (!pricing) return null;
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

let cumulativeCalls = 0;
let cumulativeInput = 0;
let cumulativeOutput = 0;
let cumulativeCost = 0;

export function trackUsage(
  label: string,
  usage: LanguageModelUsage,
): CallUsage {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = input + output;
  const cost = estimateCost(input, output);

  cumulativeCalls += 1;
  cumulativeInput += input;
  cumulativeOutput += output;
  if (cost !== null) cumulativeCost += cost;

  const costStr = cost !== null ? `~$${cost.toFixed(4)}` : "unknown";
  const cumCostStr = cumulativeCost > 0 ? `~$${cumulativeCost.toFixed(4)}` : "unknown";

  console.log(
    `[llm-usage] ${label} | ${input} in + ${output} out = ${total} tokens | cost: ${costStr} | cumulative: ${cumulativeCalls} calls, ${cumulativeInput + cumulativeOutput} tokens, ${cumCostStr}`,
  );

  return { inputTokens: input, outputTokens: output, totalTokens: total, estimatedCostUsd: cost };
}

export function getCumulativeUsage(): SessionUsage {
  return {
    calls: cumulativeCalls,
    inputTokens: cumulativeInput,
    outputTokens: cumulativeOutput,
    totalTokens: cumulativeInput + cumulativeOutput,
    estimatedCostUsd: cumulativeCost > 0 ? cumulativeCost : null,
  };
}
