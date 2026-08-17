import { generateObject } from "ai";
import { z } from "zod";

import { getLlmModel } from "./config.js";
import { type CallUsage, trackUsage } from "./llm-usage.js";
import type { StoredTransactionSnapshot } from "./storage.js";
import {
  addReviewedTransactions,
  merchantRuleAppliesToTransaction,
  type MerchantRule,
  type ReviewQueueItem,
  readOverrideStore,
  addToReviewQueue,
} from "./override-store.js";

// ---------------------------------------------------------------------------
// Plaid PFC primary categories (condensed reference for the LLM)
// ---------------------------------------------------------------------------

const PFC_PRIMARY_CATEGORIES = [
  "INCOME",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "LOAN_PAYMENTS",
  "BANK_FEES",
  "ENTERTAINMENT",
  "FOOD_AND_DRINK",
  "GENERAL_MERCHANDISE",
  "HOME_IMPROVEMENT",
  "MEDICAL",
  "PERSONAL_CARE",
  "GENERAL_SERVICES",
  "GOVERNMENT_AND_NON_PROFIT",
  "TRANSPORTATION",
  "TRAVEL",
  "RENT_AND_UTILITIES",
] as const;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a personal finance data quality analyst. Your job is to review transaction categorizations from Plaid's Personal Finance Category (PFC) system and flag ones that are likely wrong or too generic.

## Valid PFC Primary Categories
${PFC_PRIMARY_CATEGORIES.join(", ")}

## What to flag
- Transactions where the category is clearly wrong based on the merchant name and transaction description
  - Example: A hardware store purchase categorized as GENERAL_MERCHANDISE should be HOME_IMPROVEMENT
  - Example: A pharmacy purchase categorized as FOOD_AND_DRINK should be MEDICAL or PERSONAL_CARE
- Transactions with overly generic categories like GENERAL_MERCHANDISE when a more specific category is obvious
- Transactions where the detailed category doesn't match the merchant type

## What NOT to flag
- Transactions where the category is reasonable even if not perfect
- Transfers, income, loan payments — these are usually correct
- Transactions with ambiguous merchants where the current category is plausible

## Rules
- Only flag transactions you are confident are miscategorized
- Your suggested category must be from the valid PFC primary categories above
- For suggested_detailed, use the format: PRIMARY_SUBCATEGORY (e.g., HOME_IMPROVEMENT_HARDWARE, FOOD_AND_DRINK_COFFEE)
- Provide a brief reason explaining why the current category is wrong and your suggestion is better
- Be conservative — false positives waste the user's time`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TransactionForReview = {
  id: string;
  name: string | null;
  merchantName: string | null;
  amount: number | null;
  date: string | null;
  currentPrimary: string | null;
  currentDetailed: string | null;
  confidence: string | null;
};

const flaggedTransactionSchema = z.object({
  transactionId: z.string(),
  suggestedPrimary: z.string(),
  suggestedDetailed: z.string(),
  reasoning: z.string(),
});

const reviewResponseSchema = z.object({
  flaggedTransactions: z.array(flaggedTransactionSchema),
  totalReviewed: z.number(),
  summary: z.string(),
});

// ---------------------------------------------------------------------------
// Core review logic
// ---------------------------------------------------------------------------

const BATCH_SIZE = 200;
const CONCURRENCY = 2; // Anthropic rate limit: 30K input tokens/min; each batch ≈ 10K tokens

function isCoveredByMerchantRule(
  transaction: StoredTransactionSnapshot,
  merchantRules: Record<string, MerchantRule>,
): boolean {
  for (const rule of Object.values(merchantRules)) {
    if (
      merchantRuleAppliesToTransaction(rule, {
        merchantName: transaction.merchantName,
        merchantEntityId: transaction.merchantEntityId,
        transactionName: transaction.name,
      })
    ) {
      return true;
    }
  }
  return false;
}

function formatTransactionsForPrompt(
  transactions: TransactionForReview[],
): string {
  return transactions
    .map(
      (t, i) =>
        `${i + 1}. id=${t.id} | date=${t.date ?? "?"} | name="${t.name ?? "?"}" | merchant="${t.merchantName ?? "?"}" | amount=${t.amount ?? "?"} | category=${t.currentPrimary ?? "?"}/${t.currentDetailed ?? "?"} | confidence=${t.confidence ?? "?"}`,
    )
    .join("\n");
}

async function reviewBatch(
  transactions: TransactionForReview[],
): Promise<{
  flagged: Array<{
    transactionId: string;
    suggestedPrimary: string;
    suggestedDetailed: string;
    reasoning: string;
  }>;
  usage: CallUsage;
}> {
  const prompt = `Review these ${transactions.length} transactions and flag any that are miscategorized:\n\n${formatTransactionsForPrompt(transactions)}`;

  const result = await generateObject({
    model: getLlmModel(),
    system: SYSTEM_PROMPT,
    prompt,
    schema: reviewResponseSchema,
    temperature: 0.2,
    maxOutputTokens: 16000,
  });

  const usage = trackUsage("category-review", result.usage);

  const validIds = new Set(transactions.map((t) => t.id));
  const flagged = result.object.flaggedTransactions.filter((f) =>
    validIds.has(f.transactionId),
  );

  return { flagged, usage };
}

/**
 * Run LLM-assisted category review on transactions that haven't been
 * reviewed or overridden yet. Returns the number of items added to the
 * review queue and cumulative LLM usage.
 */
export async function runCategoryReview(
  transactions: StoredTransactionSnapshot[],
  options?: {
    from?: string | null;
    to?: string | null;
    onProgress?: (state: { total: number; reviewed: number }) => void;
  },
): Promise<{
  added: number;
  reviewed: number;
  usage: CallUsage[];
}> {
  const from = options?.from ?? null;
  const to = options?.to ?? null;
  const onProgress = options?.onProgress;
  const store = await readOverrideStore();
  const alreadyOverridden = new Set(
    Object.keys(store.transactionOverrides),
  );
  const alreadyInQueue = new Set(
    store.reviewQueue.map((i) => i.transactionId),
  );
  const alreadyReviewed = new Set(Object.keys(store.reviewedTransactions));

  const candidates: TransactionForReview[] = transactions
    .filter((t) => {
      if (alreadyOverridden.has(t.id)) return false;
      if (alreadyInQueue.has(t.id)) return false;
      if (alreadyReviewed.has(t.id)) return false;
      if (isCoveredByMerchantRule(t, store.merchantRules)) return false;
      if (t.pending) return false;
      if (!t.personalFinanceCategoryPrimary) return false;
      const reviewDate = t.date ?? t.authorizedDate;
      if (from || to) {
        if (!reviewDate) return false;
        if (from && reviewDate < from) return false;
        if (to && reviewDate > to) return false;
      }
      const primary = t.personalFinanceCategoryPrimary;
      if (
        primary === "INCOME" ||
        primary === "TRANSFER_IN" ||
        primary === "TRANSFER_OUT"
      ) {
        return false;
      }
      const confidence = t.personalFinanceCategoryConfidence;
      if (confidence === "VERY_HIGH" || confidence === "HIGH") return false;
      return true;
    })
    .map((t) => ({
      id: t.id,
      name: t.name,
      merchantName: t.merchantName,
      amount: t.amount,
      date: t.date ?? t.authorizedDate,
      currentPrimary: t.personalFinanceCategoryPrimary,
      currentDetailed: t.personalFinanceCategoryDetailed,
      confidence: t.personalFinanceCategoryConfidence,
    }));

  if (candidates.length === 0) {
    onProgress?.({ total: 0, reviewed: 0 });
    return { added: 0, reviewed: 0, usage: [] };
  }

  onProgress?.({ total: candidates.length, reviewed: 0 });

  const txnLookup = new Map(
    transactions.map((t) => [t.id, t]),
  );

  const allUsage: CallUsage[] = [];
  const queueItems: Omit<ReviewQueueItem, "status" | "createdAt">[] = [];
  const processedIds = new Set<string>();
  const flaggedIds = new Set<string>();

  const batches: TransactionForReview[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  let batchIndex = 0;
  let reviewedCount = 0;
  async function runNext(): Promise<void> {
    while (batchIndex < batches.length) {
      const myIndex = batchIndex++;
      const batch = batches[myIndex]!;
      let flagged: Awaited<ReturnType<typeof reviewBatch>>["flagged"];
      let usage: CallUsage;
      try {
        const result = await reviewBatch(batch);
        flagged = result.flagged;
        usage = result.usage;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[category-review] batch ${myIndex + 1} failed:`, errMsg.slice(0, 200));
        continue;
      }
      allUsage.push(usage);
      for (const transaction of batch) {
        processedIds.add(transaction.id);
      }
      reviewedCount += batch.length;
      onProgress?.({ total: candidates.length, reviewed: reviewedCount });

      for (const item of flagged) {
        flaggedIds.add(item.transactionId);
        const original = txnLookup.get(item.transactionId);
        queueItems.push({
          transactionId: item.transactionId,
          transactionName: original?.name ?? null,
          merchantName: original?.merchantName ?? null,
          merchantEntityId: original?.merchantEntityId ?? null,
          transactionDate: original?.date ?? original?.authorizedDate ?? null,
          transactionAmount:
            typeof original?.amount === "number" ? original.amount : null,
          transactionLocationCity: original?.locationCity ?? null,
          transactionLocationRegion: original?.locationRegion ?? null,
          transactionLocationCountry: original?.locationCountry ?? null,
          originalPrimary:
            original?.personalFinanceCategoryPrimary ?? null,
          originalDetailed:
            original?.personalFinanceCategoryDetailed ?? null,
          suggestedPrimary: item.suggestedPrimary,
          suggestedDetailed: item.suggestedDetailed,
          llmReasoning: item.reasoning,
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => runNext());
  await Promise.all(workers);

  const added = await addToReviewQueue(queueItems);
  const clearedIds = [...processedIds].filter((id) => !flaggedIds.has(id));
  await addReviewedTransactions(clearedIds);

  return {
    added,
    reviewed: processedIds.size,
    usage: allUsage,
  };
}
