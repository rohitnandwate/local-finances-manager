import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StoredSession } from "./storage.js";
import {
  type AnnotatedTransaction,
  type TransferAnnotation,
  annotateTransactions,
  detectTransfers,
  isTransferLikeCategory,
} from "./transfers.js";
import {
  type TransactionOverride,
  type MerchantRule,
  merchantRuleAppliesToTransaction,
  readOverrideStore,
  merchantRuleKey,
} from "./override-store.js";
import { detectRecurringStreams } from "./recurring.js";
import { readInvestmentStore } from "./investment-store.js";
import { getNormalizedHoldings } from "./investment-normalization.js";

const EXPORTS_DIR = path.resolve("exports");

export type ExportType =
  | "transactions-all"
  | "category-summary"
  | "income-expense-summary"
  | "transfer-pairs"
  | "transfers-all"
  | "recurring-streams"
  | "holdings-all"
  | "investment-transactions"
  | "holdings-normalized-master";

export const VALID_EXPORT_TYPES: ReadonlySet<string> = new Set<ExportType>([
  "transactions-all",
  "category-summary",
  "income-expense-summary",
  "transfer-pairs",
  "transfers-all",
  "recurring-streams",
  "holdings-all",
  "investment-transactions",
  "holdings-normalized-master",
]);

export type ExportParams = {
  type: ExportType;
  from: string | null;
  to: string | null;
};

function tsvRow(values: (string | number | boolean | null)[]): string {
  return values
    .map((value) => {
      if (value === null || value === undefined) return "";
      return String(value).replaceAll("\t", " ").replaceAll("\n", " ");
    })
    .join("\t");
}

function tsvFile(headers: string[], rows: string[]): string {
  return [tsvRow(headers), ...rows].join("\n") + "\n";
}

function inDateRange(
  dateStr: string | null,
  from: string | null,
  to: string | null,
): boolean {
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

/**
 * Plaid amount convention: positive = money leaving the account (debit/expense),
 * negative = money entering the account (credit/income).
 */
function derivedDirection(amount: number | null): string {
  if (amount === null) return "unknown";
  if (amount > 0) return "outflow";
  if (amount < 0) return "inflow";
  return "zero";
}

function buildAnnotatedAll(
  sessions: StoredSession[],
): {
  all: AnnotatedTransaction[];
  annotations: Map<string, TransferAnnotation>;
  sessionLookup: Map<string, { institutionName: string | null; itemId: string }>;
} {
  const sessionInputs = sessions.map((s) => ({
    institutionName: s.institutionName,
    transactions: s.transactions,
  }));
  const annotations = detectTransfers(sessionInputs);

  const sessionLookup = new Map<
    string,
    { institutionName: string | null; itemId: string }
  >();
  for (const s of sessions) {
    for (const txn of s.transactions) {
      sessionLookup.set(txn.id, {
        institutionName: s.institutionName,
        itemId: s.itemId,
      });
    }
  }

  const all: AnnotatedTransaction[] = [];
  for (const s of sessions) {
    all.push(...annotateTransactions(s.transactions, annotations));
  }

  all.sort((a, b) => {
    const dateA = a.date ?? a.authorizedDate ?? "";
    const dateB = b.date ?? b.authorizedDate ?? "";
    return dateB.localeCompare(dateA) || b.id.localeCompare(a.id);
  });

  return { all, annotations, sessionLookup };
}

function defaultDateRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const from = `${year}-${month}-01`;
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  const to = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function resolveRange(
  from: string | null,
  to: string | null,
  useDefault: boolean,
): { from: string | null; to: string | null } {
  if (useDefault && !from && !to) {
    const defaults = defaultDateRange();
    return { from: defaults.from, to: defaults.to };
  }
  return { from, to };
}

type ResolvedCategory = {
  effectivePrimary: string | null;
  effectiveDetailed: string | null;
  originalPrimary: string | null;
  originalDetailed: string | null;
  overrideSource: string | null;
};

function resolveMerchantRule(
  txn: AnnotatedTransaction,
  merchantRules: Record<string, MerchantRule>,
): MerchantRule | null {
  const keys = [
    merchantRuleKey(txn.merchantName, txn.merchantEntityId),
    merchantRuleKey(txn.merchantName, null),
    merchantRuleKey(null, txn.merchantEntityId),
  ];
  for (const key of keys) {
    const candidate = merchantRules[key];
    if (
      candidate &&
      merchantRuleAppliesToTransaction(candidate, {
        merchantName: txn.merchantName,
        merchantEntityId: txn.merchantEntityId,
        transactionName: txn.name,
      })
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve effective category for a transaction.
 * Priority: individual transaction override > merchant rule > original PFC.
 */
function resolveCategory(
  txn: AnnotatedTransaction,
  overrides: Record<string, TransactionOverride>,
  merchantRules: Record<string, MerchantRule>,
): ResolvedCategory {
  const originalPrimary = txn.personalFinanceCategoryPrimary;
  const originalDetailed = txn.personalFinanceCategoryDetailed;

  const txnOverride = overrides[txn.id];
  if (txnOverride) {
    return {
      effectivePrimary: txnOverride.overridePrimary,
      effectiveDetailed: txnOverride.overrideDetailed,
      originalPrimary,
      originalDetailed,
      overrideSource: txnOverride.source,
    };
  }

  const rule = resolveMerchantRule(txn, merchantRules);
  if (rule) {
    return {
      effectivePrimary: rule.overridePrimary,
      effectiveDetailed: rule.overrideDetailed,
      originalPrimary,
      originalDetailed,
      overrideSource: "merchant_rule",
    };
  }

  return {
    effectivePrimary: originalPrimary,
    effectiveDetailed: originalDetailed,
    originalPrimary,
    originalDetailed,
    overrideSource: null,
  };
}

export async function generateMasterTsv(
  sessions: StoredSession[],
  from: string | null,
  to: string | null,
): Promise<string> {
  const { all, sessionLookup } = buildAnnotatedAll(sessions);

  const store = await readOverrideStore();
  const overrides = store.transactionOverrides;
  const rules = store.merchantRules;

  const headers = [
    "id",
    "date",
    "authorized_date",
    "institution",
    "item_id",
    "account_id",
    "name",
    "merchant_name",
    "amount",
    "direction",
    "iso_currency_code",
    "pending",
    "pfc_primary",
    "pfc_detailed",
    "pfc_confidence",
    "payment_channel",
    "merchant_entity_id",
    "logo_url",
    "website",
    "counterparties",
    "is_internal_transfer",
    "transfer_pair_id",
    "original_pfc_primary",
    "original_pfc_detailed",
    "override_source",
  ];

  const rows = all
    .filter((txn) => {
      const d = txn.date ?? txn.authorizedDate;
      return inDateRange(d, from, to);
    })
    .map((txn) => {
      const meta = sessionLookup.get(txn.id);
      const cat = resolveCategory(txn, overrides, rules);
      return tsvRow([
        txn.id,
        txn.date,
        txn.authorizedDate,
        meta?.institutionName ?? null,
        meta?.itemId ?? null,
        txn.accountId,
        txn.name,
        txn.merchantName,
        txn.amount,
        derivedDirection(txn.amount),
        txn.isoCurrencyCode,
        txn.pending,
        cat.effectivePrimary,
        cat.effectiveDetailed,
        txn.personalFinanceCategoryConfidence,
        txn.paymentChannel,
        txn.merchantEntityId,
        txn.logoUrl,
        txn.website,
        txn.counterparties.map((cp) => cp.name ?? "").join("; "),
        txn.isInternalTransfer,
        txn.transferPairId,
        cat.originalPrimary,
        cat.originalDetailed,
        cat.overrideSource,
      ]);
    });

  return tsvFile(headers, rows);
}

export function generateCategorySummaryTsv(
  sessions: StoredSession[],
  from: string | null,
  to: string | null,
): string {
  const range = resolveRange(from, to, true);
  const { all } = buildAnnotatedAll(sessions);

  const filtered = all.filter((txn) => {
    if (txn.isInternalTransfer || isTransferLikeCategory(txn)) return false;
    const d = txn.date ?? txn.authorizedDate;
    return inDateRange(d, range.from, range.to);
  });

  const buckets = new Map<
    string,
    { primary: string; detailed: string; total: number; count: number }
  >();

  for (const txn of filtered) {
    if (txn.amount === null || txn.amount <= 0) continue;
    const primary = txn.personalFinanceCategoryPrimary ?? "UNKNOWN";
    const detailed = txn.personalFinanceCategoryDetailed ?? "UNKNOWN";
    const key = `${primary}||${detailed}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.total += txn.amount;
      existing.count += 1;
    } else {
      buckets.set(key, { primary, detailed, total: txn.amount, count: 1 });
    }
  }

  const sorted = [...buckets.values()].sort((a, b) => b.total - a.total);

  const headers = [
    "pfc_primary",
    "pfc_detailed",
    "total_spend",
    "transaction_count",
    "date_from",
    "date_to",
  ];

  const rows = sorted.map((bucket) =>
    tsvRow([
      bucket.primary,
      bucket.detailed,
      Math.round(bucket.total * 100) / 100,
      bucket.count,
      range.from,
      range.to,
    ]),
  );

  return tsvFile(headers, rows);
}

export function generateIncomeExpenseSummaryTsv(
  sessions: StoredSession[],
  from: string | null,
  to: string | null,
): string {
  const { all } = buildAnnotatedAll(sessions);

  const filtered = all.filter((txn) => {
    if (txn.isInternalTransfer || isTransferLikeCategory(txn)) return false;
    const d = txn.date ?? txn.authorizedDate;
    return inDateRange(d, from, to);
  });

  const months = new Map<
    string,
    { income: number; expenses: number; incomeCount: number; expenseCount: number }
  >();

  for (const txn of filtered) {
    if (txn.amount === null) continue;
    const d = txn.date ?? txn.authorizedDate;
    if (!d) continue;
    const monthKey = d.slice(0, 7);
    const existing = months.get(monthKey) ?? {
      income: 0,
      expenses: 0,
      incomeCount: 0,
      expenseCount: 0,
    };

    if (txn.amount < 0) {
      existing.income += Math.abs(txn.amount);
      existing.incomeCount += 1;
    } else if (txn.amount > 0) {
      existing.expenses += txn.amount;
      existing.expenseCount += 1;
    }

    months.set(monthKey, existing);
  }

  const sorted = [...months.entries()].sort(([a], [b]) => b.localeCompare(a));

  const headers = [
    "month",
    "total_income",
    "total_expenses",
    "net",
    "income_txn_count",
    "expense_txn_count",
  ];

  const rows = sorted.map(([month, data]) =>
    tsvRow([
      month,
      Math.round(data.income * 100) / 100,
      Math.round(data.expenses * 100) / 100,
      Math.round((data.income - data.expenses) * 100) / 100,
      data.incomeCount,
      data.expenseCount,
    ]),
  );

  return tsvFile(headers, rows);
}

export function generateTransferPairsTsv(
  sessions: StoredSession[],
  from: string | null,
  to: string | null,
): string {
  const { all, sessionLookup } = buildAnnotatedAll(sessions);

  const paired = all.filter((txn) => txn.isInternalTransfer && txn.transferPairId);
  const filtered = paired.filter((txn) => {
    const d = txn.date ?? txn.authorizedDate;
    return inDateRange(d, from, to);
  });

  const byPairId = new Map<string, AnnotatedTransaction[]>();
  for (const txn of filtered) {
    const group = byPairId.get(txn.transferPairId!) ?? [];
    group.push(txn);
    byPairId.set(txn.transferPairId!, group);
  }

  const headers = [
    "transfer_pair_id",
    "side",
    "id",
    "date",
    "institution",
    "account_id",
    "name",
    "amount",
    "pfc_primary",
  ];

  const rows: string[] = [];
  for (const [pairId, txns] of byPairId) {
    for (const txn of txns) {
      const meta = sessionLookup.get(txn.id);
      rows.push(
        tsvRow([
          pairId,
          txn.personalFinanceCategoryPrimary ?? "TRANSFER",
          txn.id,
          txn.date ?? txn.authorizedDate,
          meta?.institutionName ?? null,
          txn.accountId,
          txn.name,
          txn.amount,
          txn.personalFinanceCategoryPrimary,
        ]),
      );
    }
  }

  return tsvFile(headers, rows);
}

export function generateTransfersAllTsv(
  sessions: StoredSession[],
  from: string | null,
  to: string | null,
): string {
  const { all, sessionLookup } = buildAnnotatedAll(sessions);

  const filtered = all.filter((txn) => {
    if (!isTransferLikeCategory(txn)) return false;
    const d = txn.date ?? txn.authorizedDate;
    return inDateRange(d, from, to);
  });

  const headers = [
    "id",
    "date",
    "institution",
    "account_id",
    "name",
    "merchant_name",
    "amount",
    "direction",
    "pfc_primary",
    "pfc_detailed",
    "counterparties",
    "is_internal_transfer",
    "transfer_pair_id",
  ];

  const rows = filtered.map((txn) => {
    const meta = sessionLookup.get(txn.id);
    return tsvRow([
      txn.id,
      txn.date ?? txn.authorizedDate,
      meta?.institutionName ?? null,
      txn.accountId,
      txn.name,
      txn.merchantName,
      txn.amount,
      derivedDirection(txn.amount),
      txn.personalFinanceCategoryPrimary,
      txn.personalFinanceCategoryDetailed,
      txn.counterparties.map((cp) => cp.name ?? "").join("; "),
      txn.isInternalTransfer,
      txn.transferPairId,
    ]);
  });

  return tsvFile(headers, rows);
}

const MASTER_TSV_FILENAME = "master-transactions.tsv";

async function writeMasterTsvInternal(
  sessions: StoredSession[],
): Promise<string> {
  const content = await generateMasterTsv(sessions, null, null);
  await mkdir(EXPORTS_DIR, { recursive: true });
  const filePath = path.join(EXPORTS_DIR, MASTER_TSV_FILENAME);
  await writeFile(filePath, content);
  return MASTER_TSV_FILENAME;
}

/**
 * Write/overwrite a single stable master TSV for the briefing engine.
 * Unlike timestamped exports, this file is rewritten in place so the
 * exports directory doesn't accumulate files on every briefing request.
 */
export const writeMasterTsv = writeMasterTsvInternal;

export async function generateRecurringStreamsTsv(
  sessions: StoredSession[],
  _from: string | null,
  _to: string | null,
): Promise<string> {
  const masterFilename = await writeMasterTsvInternal(sessions);
  const summary = await detectRecurringStreams(masterFilename);

  const headers = [
    "name",
    "merchant_name",
    "direction",
    "frequency",
    "avg_amount",
    "last_amount",
    "median_interval_days",
    "is_active",
    "txn_count",
    "first_date",
    "last_date",
    "category",
    "category_detailed",
    "institution",
    "account_id",
  ];

  const rows = summary.streams.map((s) =>
    tsvRow([
      s.name,
      s.merchantName,
      s.direction,
      s.frequency,
      s.averageAmount,
      s.lastAmount,
      s.medianIntervalDays,
      s.isActive,
      s.transactionCount,
      s.firstDate,
      s.lastDate,
      s.categoryPrimary,
      s.categoryDetailed,
      s.institution,
      s.accountId,
    ]),
  );

  return tsvFile(headers, rows);
}

export async function generateHoldingsTsv(
  _sessions: StoredSession[],
  from: string | null,
  to: string | null,
): Promise<string> {
  const store = await readInvestmentStore();
  const accountsById = new Map(store.accounts.map((account) => [account.id, account]));
  const securitiesById = new Map(store.securities.map((security) => [security.id, security]));

  const headers = [
    "source",
    "source_item_id",
    "institution",
    "account_name",
    "account_classification",
    "security_name",
    "ticker",
    "quantity",
    "current_price",
    "current_value",
    "cost_basis",
    "currency",
    "snapshot_at",
  ];

  const filtered = store.holdings
    .filter((holding) => inDateRange(holding.snapshotAt.slice(0, 10), from, to))
    .sort((left, right) => {
      const leftValue = left.institutionValue ?? 0;
      const rightValue = right.institutionValue ?? 0;
      return rightValue - leftValue;
    });

  const rows = filtered.map((holding) => {
    const account = accountsById.get(holding.accountId);
    const security = securitiesById.get(holding.securityId);
    return tsvRow([
      holding.source,
      holding.sourceItemId,
      account?.institutionName ?? null,
      account?.accountName ?? null,
      account?.classification ?? "unknown",
      security?.name ?? null,
      security?.ticker ?? null,
      holding.quantity,
      holding.institutionPrice,
      holding.institutionValue,
      holding.costBasis,
      holding.isoCurrencyCode ?? security?.isoCurrencyCode ?? null,
      holding.snapshotAt,
    ]);
  });

  return tsvFile(headers, rows);
}

export async function generateInvestmentTransactionsTsv(
  _sessions: StoredSession[],
  from: string | null,
  to: string | null,
): Promise<string> {
  const store = await readInvestmentStore();
  const accountsById = new Map(store.accounts.map((account) => [account.id, account]));
  const securitiesById = new Map(store.securities.map((security) => [security.id, security]));

  const headers = [
    "source",
    "source_item_id",
    "institution",
    "account_name",
    "security_name",
    "ticker",
    "transaction_type",
    "transaction_subtype",
    "amount",
    "quantity",
    "price",
    "fees",
    "date",
    "currency",
    "snapshot_at",
  ];

  const filtered = store.transactions
    .filter((transaction) => inDateRange(transaction.date, from, to))
    .sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""));

  const rows = filtered.map((transaction) => {
    const account = transaction.accountId ? accountsById.get(transaction.accountId) : null;
    const security = transaction.securityId
      ? securitiesById.get(transaction.securityId)
      : null;
    return tsvRow([
      transaction.source,
      transaction.sourceItemId,
      account?.institutionName ?? null,
      account?.accountName ?? null,
      security?.name ?? null,
      security?.ticker ?? null,
      transaction.type,
      transaction.subtype,
      transaction.amount,
      transaction.quantity,
      transaction.price,
      transaction.fees,
      transaction.date,
      transaction.isoCurrencyCode ?? security?.isoCurrencyCode ?? null,
      transaction.snapshotAt,
    ]);
  });

  return tsvFile(headers, rows);
}

export async function generateNormalizedHoldingsMasterTsv(
  _sessions: StoredSession[],
  from: string | null,
  to: string | null,
): Promise<string> {
  const normalized = await getNormalizedHoldings({ regenerateIfMissing: true });
  const headers = [
    "normalized_holding_id",
    "source_holding_id",
    "source",
    "source_item_id",
    "source_account_id",
    "institution",
    "account_name",
    "account_mask",
    "account_type",
    "account_subtype",
    "account_classification",
    "account_classification_source",
    "security_id",
    "source_security_id",
    "ticker",
    "security_name",
    "cusip",
    "isin",
    "security_type",
    "quantity",
    "current_price",
    "current_value",
    "cost_basis",
    "currency_code",
    "snapshot_at",
    "canonical_security_key",
    "canonical_security_label",
    "canonical_match_method",
    "canonical_match_confidence",
    "overlap_across_sources",
    "overlap_across_accounts",
    "potential_duplicate_exposure",
    "normalized_at",
  ];

  const rows = normalized.rows
    .filter((row) => inDateRange(row.snapshotAt.slice(0, 10), from, to))
    .map((row) =>
      tsvRow([
        row.normalizedHoldingId,
        row.sourceHoldingId,
        row.source,
        row.sourceItemId,
        row.sourceAccountId,
        row.institutionName,
        row.accountName,
        row.accountMask,
        row.accountType,
        row.accountSubtype,
        row.accountClassification,
        row.accountClassificationSource,
        row.securityId,
        row.sourceSecurityId,
        row.ticker,
        row.securityName,
        row.cusip,
        row.isin,
        row.securityType,
        row.quantity,
        row.currentPrice,
        row.currentValue,
        row.costBasis,
        row.currencyCode,
        row.snapshotAt,
        row.canonicalSecurityKey,
        row.canonicalSecurityLabel,
        row.canonicalMatchMethod,
        row.canonicalMatchConfidence,
        row.overlapAcrossSources,
        row.overlapAcrossAccounts,
        row.potentialDuplicateExposure,
        row.normalizedAt,
      ]),
    );

  return tsvFile(headers, rows);
}

const GENERATORS: Record<
  ExportType,
  (sessions: StoredSession[], from: string | null, to: string | null) => string | Promise<string>
> = {
  "transactions-all": generateMasterTsv,
  "category-summary": generateCategorySummaryTsv,
  "income-expense-summary": generateIncomeExpenseSummaryTsv,
  "transfer-pairs": generateTransferPairsTsv,
  "transfers-all": generateTransfersAllTsv,
  "recurring-streams": generateRecurringStreamsTsv,
  "holdings-all": generateHoldingsTsv,
  "investment-transactions": generateInvestmentTransactionsTsv,
  "holdings-normalized-master": generateNormalizedHoldingsMasterTsv,
};

export async function generateExport(
  sessions: StoredSession[],
  params: ExportParams,
): Promise<{ filePath: string; rowCount: number }> {
  const generator = GENERATORS[params.type];
  const content = await generator(sessions, params.from, params.to);
  const lines = content.split("\n").filter(Boolean);
  const rowCount = Math.max(0, lines.length - 1);

  await mkdir(EXPORTS_DIR, { recursive: true });

  const timestamp = new Date()
    .toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" })
    .replace(/[: ]/g, "-");
  const fileName = `${params.type}-${timestamp}.tsv`;
  const filePath = path.join(EXPORTS_DIR, fileName);

  await writeFile(filePath, content);

  return { filePath, rowCount };
}
