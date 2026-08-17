import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(".data");
const STORE_PATH = path.join(DATA_DIR, "category-overrides.json");
const STORE_VERSION = 2;
const CORRUPT_BACKUP_PREFIX = "category-overrides.corrupt";

type OverrideStoreReadStatus =
  | "ok"
  | "missing_initialized_empty"
  | "recovered_from_corruption";

type OverrideStoreDiagnostics = {
  status: OverrideStoreReadStatus;
  lastReadAt: string;
  details: string;
  backupPath: string | null;
};

let overrideStoreDiagnostics: OverrideStoreDiagnostics = {
  status: "missing_initialized_empty",
  lastReadAt: new Date(0).toISOString(),
  details: "Store has not been read yet.",
  backupPath: null,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OverrideSource = "llm" | "manual";

export type TransactionOverride = {
  overridePrimary: string;
  overrideDetailed: string;
  source: OverrideSource;
  createdAt: string;
};

export type MerchantRule = {
  merchantName: string | null;
  merchantEntityId: string | null;
  matchDescription: string | null;
  overridePrimary: string;
  overrideDetailed: string;
  createdAt: string;
};

export type ReviewStatus = "pending" | "accepted" | "rejected";

export type ReviewQueueItem = {
  transactionId: string;
  transactionName: string | null;
  merchantName: string | null;
  merchantEntityId: string | null;
  transactionDate: string | null;
  transactionAmount: number | null;
  transactionLocationCity: string | null;
  transactionLocationRegion: string | null;
  transactionLocationCountry: string | null;
  originalPrimary: string | null;
  originalDetailed: string | null;
  suggestedPrimary: string;
  suggestedDetailed: string;
  llmReasoning: string | null;
  status: ReviewStatus;
  createdAt: string;
};

export type CategoryOverrideStore = {
  version: number;
  transactionOverrides: Record<string, TransactionOverride>;
  merchantRules: Record<string, MerchantRule>;
  reviewQueue: ReviewQueueItem[];
  reviewedTransactions: Record<string, string>;
};

export type OverrideStats = {
  pendingReviews: number;
  totalOverrides: number;
  merchantRules: number;
};

// ---------------------------------------------------------------------------
// Merchant rule key
// ---------------------------------------------------------------------------

export function merchantRuleKey(
  merchantName: string | null,
  merchantEntityId: string | null,
): string {
  return `${merchantName ?? ""}::${merchantEntityId ?? ""}`;
}

export function normalizeRuleDescription(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

const RULE_DESCRIPTION_SIMILARITY_THRESHOLD = 0.45;

function normalizeIdentity(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function descriptionSimilarity(
  left: string | null,
  right: string | null,
): number {
  const normalizedLeft = normalizeRuleDescription(left);
  const normalizedRight = normalizeRuleDescription(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const leftTokens = new Set(normalizedLeft.split(" ").filter(Boolean));
  const rightTokens = new Set(normalizedRight.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection++;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function matchesMerchantIdentity(
  rule: MerchantRule,
  merchantName: string | null,
  merchantEntityId: string | null,
): boolean {
  const ruleEntityId = normalizeIdentity(rule.merchantEntityId);
  const candidateEntityId = normalizeIdentity(merchantEntityId);
  if (ruleEntityId && candidateEntityId && ruleEntityId === candidateEntityId) {
    return true;
  }
  const ruleMerchantName = normalizeIdentity(rule.merchantName);
  const candidateMerchantName = normalizeIdentity(merchantName);
  if (
    ruleMerchantName &&
    candidateMerchantName &&
    ruleMerchantName === candidateMerchantName
  ) {
    return true;
  }
  return false;
}

export function merchantRuleAppliesToTransaction(
  rule: MerchantRule,
  transaction: {
    merchantName: string | null;
    merchantEntityId: string | null;
    transactionName: string | null;
  },
): boolean {
  if (
    !matchesMerchantIdentity(
      rule,
      transaction.merchantName,
      transaction.merchantEntityId,
    )
  ) {
    return false;
  }
  const ruleDescription = normalizeRuleDescription(rule.matchDescription);
  if (!ruleDescription) return true;
  const txnDescription = normalizeRuleDescription(transaction.transactionName);
  if (!txnDescription) return false;

  if (
    txnDescription.includes(ruleDescription) ||
    ruleDescription.includes(txnDescription)
  ) {
    return true;
  }

  return descriptionSimilarity(ruleDescription, txnDescription) >=
    RULE_DESCRIPTION_SIMILARITY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Persistence helpers (mirrors storage.ts pattern)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function emptyStore(): CategoryOverrideStore {
  return {
    version: STORE_VERSION,
    transactionOverrides: {},
    merchantRules: {},
    reviewQueue: [],
    reviewedTransactions: {},
  };
}

function normalizeOverride(value: unknown): TransactionOverride | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.overridePrimary !== "string" ||
    typeof value.overrideDetailed !== "string" ||
    typeof value.source !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  const source = value.source as string;
  if (source !== "llm" && source !== "manual") return null;
  return {
    overridePrimary: value.overridePrimary,
    overrideDetailed: value.overrideDetailed,
    source: source as OverrideSource,
    createdAt: value.createdAt,
  };
}

function normalizeMerchantRule(value: unknown): MerchantRule | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.overridePrimary !== "string" ||
    typeof value.overrideDetailed !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    merchantName:
      typeof value.merchantName === "string" ? value.merchantName : null,
    merchantEntityId:
      typeof value.merchantEntityId === "string"
        ? value.merchantEntityId
        : null,
    matchDescription:
      typeof value.matchDescription === "string"
        ? normalizeRuleDescription(value.matchDescription)
        : null,
    overridePrimary: value.overridePrimary,
    overrideDetailed: value.overrideDetailed,
    createdAt: value.createdAt,
  };
}

function normalizeReviewItem(value: unknown): ReviewQueueItem | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.transactionId !== "string" ||
    typeof value.suggestedPrimary !== "string" ||
    typeof value.suggestedDetailed !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  const status = value.status as string;
  if (status !== "pending" && status !== "accepted" && status !== "rejected") {
    return null;
  }
  return {
    transactionId: value.transactionId,
    transactionName:
      typeof value.transactionName === "string"
        ? value.transactionName
        : null,
    merchantName:
      typeof value.merchantName === "string" ? value.merchantName : null,
    merchantEntityId:
      typeof value.merchantEntityId === "string"
        ? value.merchantEntityId
        : null,
    transactionDate:
      typeof value.transactionDate === "string" ? value.transactionDate : null,
    transactionAmount:
      typeof value.transactionAmount === "number"
        ? value.transactionAmount
        : null,
    transactionLocationCity:
      typeof value.transactionLocationCity === "string"
        ? value.transactionLocationCity
        : null,
    transactionLocationRegion:
      typeof value.transactionLocationRegion === "string"
        ? value.transactionLocationRegion
        : null,
    transactionLocationCountry:
      typeof value.transactionLocationCountry === "string"
        ? value.transactionLocationCountry
        : null,
    originalPrimary:
      typeof value.originalPrimary === "string"
        ? value.originalPrimary
        : null,
    originalDetailed:
      typeof value.originalDetailed === "string"
        ? value.originalDetailed
        : null,
    suggestedPrimary: value.suggestedPrimary,
    suggestedDetailed: value.suggestedDetailed,
    llmReasoning:
      typeof value.llmReasoning === "string" ? value.llmReasoning : null,
    status: status as ReviewStatus,
    createdAt: value.createdAt,
  };
}

function normalizeStore(value: unknown): CategoryOverrideStore {
  if (!isRecord(value)) return emptyStore();

  const overrides: Record<string, TransactionOverride> = {};
  if (isRecord(value.transactionOverrides)) {
    for (const [key, raw] of Object.entries(value.transactionOverrides)) {
      const parsed = normalizeOverride(raw);
      if (parsed) overrides[key] = parsed;
    }
  }

  const rules: Record<string, MerchantRule> = {};
  if (isRecord(value.merchantRules)) {
    for (const [key, raw] of Object.entries(value.merchantRules)) {
      const parsed = normalizeMerchantRule(raw);
      if (parsed) rules[key] = parsed;
    }
  }

  const queue: ReviewQueueItem[] = [];
  if (Array.isArray(value.reviewQueue)) {
    for (const raw of value.reviewQueue) {
      const parsed = normalizeReviewItem(raw);
      if (parsed) queue.push(parsed);
    }
  }

  const reviewedTransactions: Record<string, string> = {};
  if (isRecord(value.reviewedTransactions)) {
    for (const [transactionId, reviewedAt] of Object.entries(
      value.reviewedTransactions,
    )) {
      if (typeof reviewedAt !== "string") continue;
      reviewedTransactions[transactionId] = reviewedAt;
    }
  }

  return {
    version: STORE_VERSION,
    transactionOverrides: overrides,
    merchantRules: rules,
    reviewQueue: queue,
    reviewedTransactions,
  };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function setOverrideStoreDiagnostics(
  status: OverrideStoreReadStatus,
  details: string,
  backupPath: string | null = null,
): void {
  overrideStoreDiagnostics = {
    status,
    details,
    backupPath,
    lastReadAt: new Date().toISOString(),
  };
}

async function backupCorruptOverrideStore(raw: string): Promise<string> {
  await ensureDataDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(DATA_DIR, `${CORRUPT_BACKUP_PREFIX}-${timestamp}.json`);
  try {
    await rename(STORE_PATH, backupPath);
  } catch {
    await writeFile(backupPath, raw, "utf8");
  }
  return backupPath;
}

export async function readOverrideStore(): Promise<CategoryOverrideStore> {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    try {
      const store = normalizeStore(JSON.parse(raw));
      setOverrideStoreDiagnostics("ok", "Override store loaded.");
      return store;
    } catch {
      const backupPath = await backupCorruptOverrideStore(raw);
      setOverrideStoreDiagnostics(
        "recovered_from_corruption",
        `Override store was invalid JSON and was quarantined to ${backupPath}.`,
        backupPath,
      );
      return emptyStore();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      setOverrideStoreDiagnostics(
        "missing_initialized_empty",
        "Override store not found; using an empty in-memory state.",
      );
      return emptyStore();
    }
    throw error;
  }
}

async function writeStore(store: CategoryOverrideStore): Promise<void> {
  await ensureDataDir();
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------
// Transaction overrides
// ---------------------------------------------------------------------------

export async function getOverridesMap(): Promise<
  Record<string, TransactionOverride>
> {
  const store = await readOverrideStore();
  return store.transactionOverrides;
}

export async function setOverride(
  transactionId: string,
  primary: string,
  detailed: string,
  source: OverrideSource,
): Promise<void> {
  const store = await readOverrideStore();
  store.transactionOverrides[transactionId] = {
    overridePrimary: primary,
    overrideDetailed: detailed,
    source,
    createdAt: new Date().toISOString(),
  };
  await writeStore(store);
}

export async function removeOverride(transactionId: string): Promise<boolean> {
  const store = await readOverrideStore();
  if (!(transactionId in store.transactionOverrides)) return false;
  delete store.transactionOverrides[transactionId];
  await writeStore(store);
  return true;
}

// ---------------------------------------------------------------------------
// Merchant rules
// ---------------------------------------------------------------------------

export async function getMerchantRules(): Promise<
  Record<string, MerchantRule>
> {
  const store = await readOverrideStore();
  return store.merchantRules;
}

export async function getMerchantRule(
  merchantName: string | null,
  merchantEntityId: string | null,
): Promise<MerchantRule | null> {
  const store = await readOverrideStore();
  const key = merchantRuleKey(merchantName, merchantEntityId);
  return store.merchantRules[key] ?? null;
}

export async function upsertMerchantRule(
  merchantName: string | null,
  merchantEntityId: string | null,
  matchDescription: string | null,
  primary: string,
  detailed: string,
): Promise<void> {
  const store = await readOverrideStore();
  const key = merchantRuleKey(merchantName, merchantEntityId);
  store.merchantRules[key] = {
    merchantName,
    merchantEntityId,
    matchDescription: normalizeRuleDescription(matchDescription),
    overridePrimary: primary,
    overrideDetailed: detailed,
    createdAt: new Date().toISOString(),
  };
  await writeStore(store);
}

export async function removeMerchantRule(
  merchantName: string | null,
  merchantEntityId: string | null,
): Promise<boolean> {
  const store = await readOverrideStore();
  const key = merchantRuleKey(merchantName, merchantEntityId);
  if (!(key in store.merchantRules)) return false;
  delete store.merchantRules[key];
  await writeStore(store);
  return true;
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

export async function addToReviewQueue(
  items: Omit<ReviewQueueItem, "status" | "createdAt">[],
): Promise<number> {
  const store = await readOverrideStore();
  const existingIds = new Set(store.reviewQueue.map((i) => i.transactionId));
  const alreadyOverridden = new Set(
    Object.keys(store.transactionOverrides),
  );

  let added = 0;
  for (const item of items) {
    if (existingIds.has(item.transactionId)) continue;
    if (alreadyOverridden.has(item.transactionId)) continue;
    store.reviewQueue.push({
      ...item,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    existingIds.add(item.transactionId);
    added++;
  }

  if (added > 0) await writeStore(store);
  return added;
}

export async function getPendingReviews(): Promise<ReviewQueueItem[]> {
  const store = await readOverrideStore();
  return store.reviewQueue.filter((item) => item.status === "pending");
}

export async function updateReviewStatus(
  transactionId: string,
  status: ReviewStatus,
): Promise<boolean> {
  const store = await readOverrideStore();
  const item = store.reviewQueue.find(
    (i) => i.transactionId === transactionId,
  );
  if (!item) return false;
  item.status = status;
  await writeStore(store);
  return true;
}

export async function clearReviewQueue(): Promise<void> {
  const store = await readOverrideStore();
  store.reviewQueue = [];
  await writeStore(store);
}

export async function autoResolvePendingReviewsByMerchantRule(
  rule: MerchantRule,
  options?: { exceptTransactionId?: string },
): Promise<number> {
  const store = await readOverrideStore();
  let updated = 0;
  const exceptTransactionId = options?.exceptTransactionId ?? null;

  for (const item of store.reviewQueue) {
    if (item.status !== "pending") continue;
    if (exceptTransactionId && item.transactionId === exceptTransactionId) continue;
    if (
      merchantRuleAppliesToTransaction(rule, {
        merchantName: item.merchantName,
        merchantEntityId: item.merchantEntityId,
        transactionName: item.transactionName,
      })
    ) {
      item.status = "accepted";
      updated++;
    }
  }

  if (updated > 0) {
    await writeStore(store);
  }
  return updated;
}

export async function addReviewedTransactions(
  transactionIds: string[],
): Promise<number> {
  if (transactionIds.length === 0) return 0;
  const store = await readOverrideStore();
  const timestamp = new Date().toISOString();
  const inQueue = new Set(store.reviewQueue.map((item) => item.transactionId));
  let added = 0;

  for (const transactionId of transactionIds) {
    if (transactionId in store.transactionOverrides) continue;
    if (inQueue.has(transactionId)) continue;
    if (transactionId in store.reviewedTransactions) continue;
    store.reviewedTransactions[transactionId] = timestamp;
    added++;
  }

  if (added > 0) {
    await writeStore(store);
  }
  return added;
}

export async function clearReviewedTransactions(): Promise<number> {
  const store = await readOverrideStore();
  const count = Object.keys(store.reviewedTransactions).length;
  if (count === 0) return 0;
  store.reviewedTransactions = {};
  await writeStore(store);
  return count;
}

// ---------------------------------------------------------------------------
// Stats (for badge)
// ---------------------------------------------------------------------------

export async function getOverrideStats(): Promise<OverrideStats> {
  const store = await readOverrideStore();
  return {
    pendingReviews: store.reviewQueue.filter((i) => i.status === "pending")
      .length,
    totalOverrides: Object.keys(store.transactionOverrides).length,
    merchantRules: Object.keys(store.merchantRules).length,
  };
}

export function getOverrideStoreHealth(): {
  path: string;
  status: OverrideStoreReadStatus;
  lastReadAt: string;
  details: string;
  backupPath: string | null;
} {
  return {
    path: STORE_PATH,
    status: overrideStoreDiagnostics.status,
    lastReadAt: overrideStoreDiagnostics.lastReadAt,
    details: overrideStoreDiagnostics.details,
    backupPath: overrideStoreDiagnostics.backupPath,
  };
}
