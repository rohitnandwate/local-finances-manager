import express from "express";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";

import {
  assertLanWifiRequirementsMet,
  config,
  isLanAccessEnabled,
  isLlmConfigured,
  isPlaidConfigured,
  validateLlmConfig,
} from "./config.js";
import { handleLanLogin, lanAccessMiddleware } from "./lan-access.js";
import { getCurrentWifiSsid, getWifiBindSnapshot, resolveListenHost } from "./lan-wifi.js";
import {
  createLinkToken,
  createUpdateLinkToken,
  exchangePublicToken,
  getAccountBalances,
  getHistoricalTransactions,
  getInvestmentHoldings,
  getInvestmentTransactions,
  syncTransactions,
} from "./plaid-client.js";
import {
  type ExportParams,
  type ExportType,
  VALID_EXPORT_TYPES,
  generateExport,
  writeMasterTsv,
} from "./export.js";
import {
  clearSessions,
  getAccessToken,
  getSessionStoreHealth,
  readSessions,
  storeAccessToken,
  type StoredAccountSnapshot,
  type StoredTransactionSnapshot,
  summarizeSessions,
  upsertSession,
} from "./storage.js";
import { getKeychainServiceNameForDiagnostics } from "./keychain.js";
import { runBriefingMetrics, queryStreamTransactions } from "./query.js";
import { generateBriefing } from "./briefing.js";
import { type ConversationMessage, askQuestion } from "./ask.js";
import { getCumulativeUsage } from "./llm-usage.js";
import {
  buildBudgetReview,
  getCurrentWeekRange,
  validateBudgetDefinitions,
} from "./budget-targets.js";
import {
  autoResolvePendingReviewsByMerchantRule,
  type OverrideSource,
  type ReviewStatus,
  clearReviewedTransactions,
  getOverrideStats,
  getOverrideStoreHealth,
  getPendingReviews,
  setOverride,
  removeOverride,
  updateReviewStatus,
  readOverrideStore,
  getMerchantRules,
  upsertMerchantRule,
  removeMerchantRule,
} from "./override-store.js";
import { runCategoryReview } from "./category-review.js";
import { detectRecurringStreams } from "./recurring.js";
import {
  getInvestmentStoreHealth,
  readInvestmentStore,
  replaceCsvHoldingsSnapshot,
  replacePlaidItemSnapshot,
  setInvestmentAccountClassification,
  type Holding,
  type InvestmentAccountClassification,
} from "./investment-store.js";
import { parseFidelityHoldingsFile } from "./investment-csv.js";
import {
  getNormalizationStoreHealth,
  getNormalizedHoldings,
  regenerateNormalizedHoldings,
} from "./investment-normalization.js";

const app = express();
const publicDir = path.resolve("public");
const serviceStartedAt = new Date().toISOString();
const INVESTMENT_EXPORT_TYPES: ReadonlySet<string> = new Set([
  "holdings-all",
  "investment-transactions",
  "holdings-normalized-master",
]);
const categoryReviewProgress: {
  active: boolean;
  total: number;
  reviewed: number;
  from: string | null;
  to: string | null;
  startedAt: string | null;
  finishedAt: string | null;
} = {
  active: false,
  total: 0,
  reviewed: 0,
  from: null,
  to: null,
  startedAt: null,
  finishedAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractErrorDetails(error: unknown): {
  status: number;
  message: string;
  logContext?: Record<string, unknown>;
} {
  if (error instanceof Error) {
    const maybeResponse = isRecord(error) ? error.response : undefined;
    if (isRecord(maybeResponse)) {
      const status =
        typeof maybeResponse.status === "number" ? maybeResponse.status : 500;
      const data = isRecord(maybeResponse.data) ? maybeResponse.data : undefined;

      return {
        status,
        message:
          (data && typeof data.error_message === "string" && data.error_message) ||
          (data && typeof data.display_message === "string" && data.display_message) ||
          error.message,
        logContext: data
          ? {
              error_type: typeof data.error_type === "string" ? data.error_type : undefined,
              error_code: typeof data.error_code === "string" ? data.error_code : undefined,
              request_id: typeof data.request_id === "string" ? data.request_id : undefined,
            }
          : undefined,
      };
    }

    return {
      status: 500,
      message: error.message,
    };
  }

  return {
    status: 500,
    message: "Unknown server error",
  };
}

function getPlaidErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const maybeResponse = isRecord(error) ? error.response : undefined;
  const data = isRecord(maybeResponse) && isRecord(maybeResponse.data)
    ? maybeResponse.data
    : null;

  return data && typeof data.error_code === "string" ? data.error_code : null;
}

function ensurePlaidConfigured(response: express.Response): boolean {
  if (isPlaidConfigured()) {
    return true;
  }

  response.status(503).json({
    error:
      "Plaid is not configured. Set PLAID_CLIENT_ID and the Plaid secret for the active PLAID_ENV in .env.local or .env.",
  });
  return false;
}

function parseDateParam(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function parseLinkMetadata(value: unknown): {
  institutionId: string | null;
  institutionName: string | null;
  linkedAccounts: Array<{
    id: string;
    name: string | null;
    mask: string | null;
    subtype: string | null;
    type: string | null;
  }>;
} {
  if (!isRecord(value)) {
    return {
      institutionId: null,
      institutionName: null,
      linkedAccounts: [],
    };
  }

  const institution = isRecord(value.institution) ? value.institution : null;
  const accounts = Array.isArray(value.accounts) ? value.accounts : [];

  return {
    institutionId:
      institution && typeof institution.institution_id === "string"
        ? institution.institution_id
        : null,
    institutionName:
      institution && typeof institution.name === "string" ? institution.name : null,
    linkedAccounts: accounts
      .map((account) => {
        if (!isRecord(account) || typeof account.id !== "string") {
          return null;
        }

        return {
          id: account.id,
          name: typeof account.name === "string" ? account.name : null,
          mask: typeof account.mask === "string" ? account.mask : null,
          subtype: typeof account.subtype === "string" ? account.subtype : null,
          type: typeof account.type === "string" ? account.type : null,
        };
      })
      .filter(
        (
          account,
        ): account is {
          id: string;
          name: string | null;
          mask: string | null;
          subtype: string | null;
          type: string | null;
        } => account !== null,
      ),
  };
}

function normalizeAccountsForStorage(
  accounts: Awaited<ReturnType<typeof getAccountBalances>>,
): StoredAccountSnapshot[] {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name ?? null,
    mask: account.mask ?? null,
    subtype: account.subtype ?? null,
    type: account.type ?? null,
    available: typeof account.available === "number" ? account.available : null,
    current: typeof account.current === "number" ? account.current : null,
    isoCurrencyCode: account.isoCurrencyCode ?? null,
  }));
}

function parseCounterparties(
  value: unknown,
): Array<{
  name: string | null;
  type: string | null;
  logoUrl: string | null;
  website: string | null;
  entityId: string | null;
  confidenceLevel: string | null;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : null,
      type: typeof entry.type === "string" ? entry.type : null,
      logoUrl: typeof entry.logo_url === "string" ? entry.logo_url : null,
      website: typeof entry.website === "string" ? entry.website : null,
      entityId: typeof entry.entity_id === "string" ? entry.entity_id : null,
      confidenceLevel:
        typeof entry.confidence_level === "string" ? entry.confidence_level : null,
    }));
}

function parseTransactionLocation(value: unknown): {
  address: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
  storeNumber: string | null;
} {
  if (!isRecord(value)) {
    return {
      address: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
      lat: null,
      lon: null,
      storeNumber: null,
    };
  }
  return {
    address:
      typeof value.address === "string"
        ? value.address
        : null,
    city:
      typeof value.city === "string"
        ? value.city
        : null,
    region:
      typeof value.region === "string"
        ? value.region
        : null,
    postalCode:
      typeof value.postal_code === "string"
        ? value.postal_code
        : typeof value.postalCode === "string"
          ? value.postalCode
          : null,
    country:
      typeof value.country === "string"
        ? value.country
        : null,
    lat:
      typeof value.lat === "number"
        ? value.lat
        : null,
    lon:
      typeof value.lon === "number"
        ? value.lon
        : null,
    storeNumber:
      typeof value.store_number === "string"
        ? value.store_number
        : typeof value.storeNumber === "string"
          ? value.storeNumber
          : null,
  };
}

function parseTransactionSnapshot(
  transaction: unknown,
): StoredTransactionSnapshot | null {
  if (!isRecord(transaction) || typeof transaction.transaction_id !== "string") {
    return null;
  }

  const personalFinanceCategory = isRecord(transaction.personal_finance_category)
    ? transaction.personal_finance_category
    : null;
  const location = parseTransactionLocation(transaction.location);

  return {
    id: transaction.transaction_id,
    accountId:
      typeof transaction.account_id === "string" ? transaction.account_id : null,
    name: typeof transaction.name === "string" ? transaction.name : null,
    merchantName:
      typeof transaction.merchant_name === "string" ? transaction.merchant_name : null,
    amount: typeof transaction.amount === "number" ? transaction.amount : null,
    isoCurrencyCode:
      typeof transaction.iso_currency_code === "string"
        ? transaction.iso_currency_code
        : null,
    unofficialCurrencyCode:
      typeof transaction.unofficial_currency_code === "string"
        ? transaction.unofficial_currency_code
        : null,
    date: typeof transaction.date === "string" ? transaction.date : null,
    authorizedDate:
      typeof transaction.authorized_date === "string"
        ? transaction.authorized_date
        : null,
    pending: Boolean(transaction.pending),
    personalFinanceCategoryPrimary:
      personalFinanceCategory &&
      typeof personalFinanceCategory.primary === "string"
        ? personalFinanceCategory.primary
        : null,
    personalFinanceCategoryDetailed:
      personalFinanceCategory &&
      typeof personalFinanceCategory.detailed === "string"
        ? personalFinanceCategory.detailed
        : null,
    personalFinanceCategoryConfidence:
      personalFinanceCategory &&
      typeof personalFinanceCategory.confidence_level === "string"
        ? personalFinanceCategory.confidence_level
        : null,
    counterparties: parseCounterparties(transaction.counterparties),
    paymentChannel:
      typeof transaction.payment_channel === "string"
        ? transaction.payment_channel
        : null,
    merchantEntityId:
      typeof transaction.merchant_entity_id === "string"
        ? transaction.merchant_entity_id
        : null,
    logoUrl:
      typeof transaction.logo_url === "string" ? transaction.logo_url : null,
    website:
      typeof transaction.website === "string" ? transaction.website : null,
    locationAddress: location.address,
    locationCity: location.city,
    locationRegion: location.region,
    locationPostalCode: location.postalCode,
    locationCountry: location.country,
    locationLat: location.lat,
    locationLon: location.lon,
    locationStoreNumber: location.storeNumber,
  };
}

function sortTransactions(
  transactions: StoredTransactionSnapshot[],
): StoredTransactionSnapshot[] {
  return [...transactions].sort((left, right) => {
    const leftDate = left.date ?? left.authorizedDate ?? "";
    const rightDate = right.date ?? right.authorizedDate ?? "";
    return rightDate.localeCompare(leftDate) || right.id.localeCompare(left.id);
  });
}

function mergeTransactions(
  existing: StoredTransactionSnapshot[],
  delta: Awaited<ReturnType<typeof syncTransactions>>,
): StoredTransactionSnapshot[] {
  const byId = new Map(existing.map((transaction) => [transaction.id, transaction]));

  for (const transaction of delta.added) {
    const parsed = parseTransactionSnapshot(transaction);
    if (parsed) {
      byId.set(parsed.id, parsed);
    }
  }

  for (const transaction of delta.modified) {
    const parsed = parseTransactionSnapshot(transaction);
    if (parsed) {
      byId.set(parsed.id, parsed);
    }
  }

  for (const transaction of delta.removed) {
    if (
      isRecord(transaction) &&
      typeof transaction.transaction_id === "string"
    ) {
      byId.delete(transaction.transaction_id);
    }
  }

  return sortTransactions([...byId.values()]);
}

function buildSyntheticTransactionDelta(transactions: unknown[]) {
  return {
    added: transactions,
    modified: [],
    removed: [],
    cursor: "",
    hasMore: false,
  } satisfies Awaited<ReturnType<typeof syncTransactions>>;
}

function buildTransactionResponse(
  delta: Awaited<ReturnType<typeof syncTransactions>>,
  currentTransactions: StoredTransactionSnapshot[],
  historicalWindow?: {
    startDate: string;
    endDate: string;
    totalCount: number;
  },
) {
  const newestTransaction =
    currentTransactions.length > 0 ? currentTransactions[0] : null;
  const oldestTransaction =
    currentTransactions.length > 0
      ? currentTransactions[currentTransactions.length - 1]
      : null;

  return {
    addedCount: delta.added.length,
    modifiedCount: delta.modified.length,
    removedCount: delta.removed.length,
    totalCount: currentTransactions.length,
    newestDate:
      newestTransaction?.date ?? newestTransaction?.authorizedDate ?? null,
    oldestDate:
      oldestTransaction?.date ?? oldestTransaction?.authorizedDate ?? null,
    historicalRequest: historicalWindow ?? null,
    hasMore: delta.hasMore,
    sample: currentTransactions.slice(0, 15),
  };
}

async function fetchAndMergeFullTransactionHistory(
  accessToken: string,
  cursor: string | null,
): Promise<{
  transactionSync: Awaited<ReturnType<typeof syncTransactions>>;
  storedTransactions: StoredTransactionSnapshot[];
  historicalWindow: {
    startDate: string;
    endDate: string;
    totalCount: number;
  };
}> {
  const historicalTransactions = await getHistoricalTransactions(
    accessToken,
    config.plaid.daysRequested,
  );
  const transactionSync = await syncTransactions(accessToken, cursor);
  const historicalSnapshot = mergeTransactions(
    [],
    buildSyntheticTransactionDelta(historicalTransactions.transactions),
  );
  const storedTransactions = mergeTransactions(historicalSnapshot, transactionSync);

  return {
    transactionSync,
    storedTransactions,
    historicalWindow: {
      startDate: historicalTransactions.startDate,
      endDate: historicalTransactions.endDate,
      totalCount: historicalTransactions.totalCount,
    },
  };
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePlaidInvestmentAccount(
  value: unknown,
): {
  id: string;
  name: string | null;
  mask: string | null;
  subtype: string | null;
  type: string | null;
} | null {
  if (!isRecord(value) || typeof value.account_id !== "string") {
    return null;
  }

  return {
    id: value.account_id,
    name: parseNullableString(value.name),
    mask: parseNullableString(value.mask),
    subtype: parseNullableString(value.subtype),
    type: parseNullableString(value.type),
  };
}

function parsePlaidInvestmentSecurity(
  value: unknown,
): {
  id: string | null;
  ticker: string | null;
  name: string | null;
  cusip: string | null;
  isin: string | null;
  type: string | null;
  closePrice: number | null;
  closePriceAsOf: string | null;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: parseNullableString(value.security_id),
    ticker: parseNullableString(value.ticker_symbol),
    name: parseNullableString(value.name),
    cusip: parseNullableString(value.cusip),
    isin: parseNullableString(value.isin),
    type: parseNullableString(value.type),
    closePrice: parseNullableNumber(value.close_price),
    closePriceAsOf: parseNullableString(value.close_price_as_of),
    isoCurrencyCode: parseNullableString(value.iso_currency_code),
    unofficialCurrencyCode: parseNullableString(value.unofficial_currency_code),
  };
}

function parsePlaidInvestmentHolding(
  value: unknown,
): {
  id: string | null;
  accountId: string | null;
  securityId: string | null;
  quantity: number | null;
  institutionValue: number | null;
  institutionPrice: number | null;
  costBasis: number | null;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: parseNullableString(value.holding_id),
    accountId: parseNullableString(value.account_id),
    securityId: parseNullableString(value.security_id),
    quantity: parseNullableNumber(value.quantity),
    institutionValue: parseNullableNumber(value.institution_value),
    institutionPrice: parseNullableNumber(value.institution_price),
    costBasis: parseNullableNumber(value.cost_basis),
    isoCurrencyCode: parseNullableString(value.iso_currency_code),
    unofficialCurrencyCode: parseNullableString(value.unofficial_currency_code),
  };
}

function parsePlaidInvestmentTransaction(
  value: unknown,
): {
  id: string;
  accountId: string | null;
  securityId: string | null;
  type: string | null;
  subtype: string | null;
  amount: number | null;
  quantity: number | null;
  price: number | null;
  fees: number | null;
  date: string | null;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
  name: string | null;
} | null {
  if (!isRecord(value) || typeof value.investment_transaction_id !== "string") {
    return null;
  }

  return {
    id: value.investment_transaction_id,
    accountId: parseNullableString(value.account_id),
    securityId: parseNullableString(value.security_id),
    type: parseNullableString(value.type),
    subtype: parseNullableString(value.subtype),
    amount: parseNullableNumber(value.amount),
    quantity: parseNullableNumber(value.quantity),
    price: parseNullableNumber(value.price),
    fees: parseNullableNumber(value.fees),
    date: parseNullableString(value.date),
    isoCurrencyCode: parseNullableString(value.iso_currency_code),
    unofficialCurrencyCode: parseNullableString(value.unofficial_currency_code),
    name: parseNullableString(value.name),
  };
}

async function buildPortfolioSummary() {
  const store = await readInvestmentStore();
  const accountById = new Map(store.accounts.map((account) => [account.id, account]));
  const securityById = new Map(store.securities.map((security) => [security.id, security]));
  const latestHoldings = selectLatestHoldings(store.holdings);

  const bySource = new Map<string, number>();
  const byInstitution = new Map<string, number>();
  const byClassification = new Map<string, number>();
  const bySecurity = new Map<string, {
    securityId: string;
    ticker: string | null;
    name: string | null;
    value: number;
    quantity: number;
  }>();

  let totalValue = 0;
  for (const holding of latestHoldings) {
    const value = holding.institutionValue ?? 0;
    totalValue += value;

    bySource.set(holding.source, (bySource.get(holding.source) ?? 0) + value);
    const account = accountById.get(holding.accountId);
    const institution = account?.institutionName ?? "Unknown institution";
    byInstitution.set(institution, (byInstitution.get(institution) ?? 0) + value);
    const classification = account?.classification ?? "unknown";
    byClassification.set(
      classification,
      (byClassification.get(classification) ?? 0) + value,
    );

    const security = securityById.get(holding.securityId);
    const key = holding.securityId;
    const existing = bySecurity.get(key);
    if (existing) {
      existing.value += value;
      existing.quantity += holding.quantity ?? 0;
    } else {
      bySecurity.set(key, {
        securityId: holding.securityId,
        ticker: security?.ticker ?? null,
        name: security?.name ?? null,
        value,
        quantity: holding.quantity ?? 0,
      });
    }
  }

  const holdingsByInstitution = [...byInstitution.entries()]
    .map(([institution, value]) => ({ institution, value }))
    .sort((left, right) => right.value - left.value);
  const holdingsBySource = [...bySource.entries()]
    .map(([source, value]) => ({ source, value }))
    .sort((left, right) => right.value - left.value);
  const holdingsByClassification = [...byClassification.entries()]
    .map(([classification, value]) => ({ classification, value }))
    .sort((left, right) => right.value - left.value);
  const topSecurities = [...bySecurity.values()]
    .sort((left, right) => right.value - left.value);
  const latestSnapshotDate =
    latestHoldings.length > 0
      ? latestHoldings
        .map((holding) => holding.snapshotAt)
        .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))[0]
      : null;

  return {
    totals: {
      totalInvestmentValue: totalValue,
      accountCount: store.accounts.length,
      securityCount: store.securities.length,
      holdingCount: latestHoldings.length,
      holdingHistoryCount: store.holdings.length,
      transactionCount: store.transactions.length,
      latestSnapshotDate,
    },
    holdingsBySource,
    holdingsByInstitution,
    holdingsByClassification,
    topSecurities,
  };
}

function selectLatestHoldings(holdings: Holding[]): Holding[] {
  const latestByKey = new Map<string, Holding>();
  for (const holding of holdings) {
    const key = `${holding.source}:${holding.sourceItemId ?? "none"}:${holding.accountId}:${holding.securityId}`;
    const existing = latestByKey.get(key);
    if (!existing || holding.snapshotAt > existing.snapshotAt) {
      latestByKey.set(key, holding);
    }
  }
  return [...latestByKey.values()];
}

function isoDateOnly(value: string): string {
  return value.slice(0, 10);
}

function daysOldFromToday(date: string): number {
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const targetUtc = Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  );
  return Math.max(0, Math.floor((todayUtc - targetUtc) / (24 * 60 * 60 * 1000)));
}

function freshnessLabel(daysOld: number): "fresh" | "aging" | "stale" {
  if (daysOld <= 1) return "fresh";
  if (daysOld <= 5) return "aging";
  return "stale";
}

async function buildUsefulInvestmentViews() {
  const store = await readInvestmentStore();
  const normalized = await getNormalizedHoldings({ regenerateIfMissing: true });
  const latestRows = selectLatestNormalizedRows(normalized.rows);

  const latestBySource = new Map<
    string,
    { source: string; snapshotDate: string; daysOld: number; freshness: "fresh" | "aging" | "stale" }
  >();
  for (const row of latestRows) {
    const date = isoDateOnly(row.snapshotAt);
    const existing = latestBySource.get(row.source);
    if (!existing || date > existing.snapshotDate) {
      const daysOld = daysOldFromToday(date);
      latestBySource.set(row.source, {
        source: row.source,
        snapshotDate: date,
        daysOld,
        freshness: freshnessLabel(daysOld),
      });
    }
  }

  const consolidatedBySecurity = new Map<
    string,
    {
      canonicalSecurityKey: string;
      canonicalSecurityLabel: string;
      canonicalMatchMethod: string;
      canonicalMatchConfidence: string;
      totalValue: number;
      totalQuantity: number;
      sourceCount: number;
      accountCount: number;
      rowCount: number;
      overlapAcrossSources: boolean;
      overlapAcrossAccounts: boolean;
      potentialDuplicateExposure: boolean;
      drilldown: Array<{
        source: string;
        sourceItemId: string | null;
        institutionName: string | null;
        accountId: string;
        accountName: string | null;
        accountMask: string | null;
        accountType: string | null;
        accountSubtype: string | null;
        accountClassification: "retirement" | "taxable" | "unknown";
        accountClassificationSource: "inferred" | "manual";
        ticker: string | null;
        securityName: string | null;
        quantity: number | null;
        currentPrice: number | null;
        currentValue: number | null;
        costBasis: number | null;
        snapshotAt: string;
      }>;
    }
  >();

  for (const row of latestRows) {
    const existing = consolidatedBySecurity.get(row.canonicalSecurityKey) ?? {
      canonicalSecurityKey: row.canonicalSecurityKey,
      canonicalSecurityLabel: row.canonicalSecurityLabel,
      canonicalMatchMethod: row.canonicalMatchMethod,
      canonicalMatchConfidence: row.canonicalMatchConfidence,
      totalValue: 0,
      totalQuantity: 0,
      sourceCount: 0,
      accountCount: 0,
      rowCount: 0,
      overlapAcrossSources: row.overlapAcrossSources,
      overlapAcrossAccounts: row.overlapAcrossAccounts,
      potentialDuplicateExposure: row.potentialDuplicateExposure,
      drilldown: [],
    };

    existing.totalValue += row.currentValue ?? 0;
    existing.totalQuantity += row.quantity ?? 0;
    existing.rowCount += 1;
    existing.overlapAcrossSources =
      existing.overlapAcrossSources || row.overlapAcrossSources;
    existing.overlapAcrossAccounts =
      existing.overlapAcrossAccounts || row.overlapAcrossAccounts;
    existing.potentialDuplicateExposure =
      existing.potentialDuplicateExposure || row.potentialDuplicateExposure;
    existing.drilldown.push({
      source: row.source,
      sourceItemId: row.sourceItemId,
      institutionName: row.institutionName,
      accountId: row.accountId,
      accountName: row.accountName,
      accountMask: row.accountMask,
      accountType: row.accountType,
      accountSubtype: row.accountSubtype,
      accountClassification: row.accountClassification,
      accountClassificationSource: row.accountClassificationSource,
      ticker: row.ticker,
      securityName: row.securityName,
      quantity: row.quantity,
      currentPrice: row.currentPrice,
      currentValue: row.currentValue,
      costBasis: row.costBasis,
      snapshotAt: row.snapshotAt,
    });
    consolidatedBySecurity.set(row.canonicalSecurityKey, existing);
  }

  for (const consolidated of consolidatedBySecurity.values()) {
    const sourceSet = new Set(consolidated.drilldown.map((row) => row.source));
    const accountSet = new Set(consolidated.drilldown.map((row) => row.accountId));
    consolidated.sourceCount = sourceSet.size;
    consolidated.accountCount = accountSet.size;
    consolidated.drilldown.sort(
      (left, right) => (right.currentValue ?? 0) - (left.currentValue ?? 0),
    );
  }

  const activity = store.transactions
    .sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""))
    .slice(0, 40)
    .map((txn) => {
      const account = txn.accountId
        ? store.accounts.find((entry) => entry.id === txn.accountId)
        : null;
      const security = txn.securityId
        ? store.securities.find((entry) => entry.id === txn.securityId)
        : null;
      return {
        id: txn.id,
        date: txn.date,
        source: txn.source,
        sourceItemId: txn.sourceItemId,
        accountName: account?.accountName ?? null,
        institutionName: account?.institutionName ?? null,
        accountClassification: account?.classification ?? "unknown",
        securityName: security?.name ?? txn.name,
        ticker: security?.ticker ?? null,
        type: txn.type,
        subtype: txn.subtype,
        amount: txn.amount,
        quantity: txn.quantity,
        price: txn.price,
        fees: txn.fees,
        snapshotAt: txn.snapshotAt,
      };
    });

  const unmatchedIdentityCount = latestRows.filter(
    (row) => row.canonicalMatchConfidence === "low",
  ).length;
  const lowConfidenceRows = latestRows
    .filter((row) => row.canonicalMatchConfidence === "low")
    .slice(0, 25)
    .map((row) => ({
      canonicalSecurityKey: row.canonicalSecurityKey,
      canonicalSecurityLabel: row.canonicalSecurityLabel,
      source: row.source,
      institutionName: row.institutionName,
      accountName: row.accountName,
      ticker: row.ticker,
      securityName: row.securityName,
      canonicalMatchMethod: row.canonicalMatchMethod,
      canonicalMatchConfidence: row.canonicalMatchConfidence,
      snapshotAt: row.snapshotAt,
    }));

  const diagnostics = {
    overlapCount: latestRows.filter((row) => row.potentialDuplicateExposure).length,
    missingCostBasisCount: latestRows.filter((row) => row.costBasis === null).length,
    unmatchedIdentityCount,
    lowConfidenceRows,
  };

  return {
    snapshot: {
      latestBySource: [...latestBySource.values()].sort((left, right) =>
        left.source.localeCompare(right.source),
      ),
      distinctSnapshotDates: [...new Set(latestRows.map((row) => isoDateOnly(row.snapshotAt)))]
        .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)),
    },
    holdingsDetail: {
      consolidated: [...consolidatedBySecurity.values()]
        .sort((left, right) => right.totalValue - left.totalValue),
      rowCount: latestRows.length,
      normalizedGeneratedAt: normalized.generatedAt,
    },
    activity: {
      rowCount: store.transactions.length,
      recent: activity,
      emptyState:
        activity.length === 0
          ? "No investment transactions available yet. Plaid may need more time, or this source only contains holdings snapshots."
          : null,
    },
    diagnostics,
  };
}

function selectLatestNormalizedRows(
  rows: Awaited<ReturnType<typeof getNormalizedHoldings>>["rows"],
) {
  const latestByKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.source}:${row.sourceItemId ?? "none"}:${row.accountId}:${row.securityId}`;
    const existing = latestByKey.get(key);
    if (!existing || row.snapshotAt > existing.snapshotAt) {
      latestByKey.set(key, row);
    }
  }
  return [...latestByKey.values()];
}

app.use(express.json());
app.use(lanAccessMiddleware);
app.post("/api/auth/lan", handleLanLogin);
app.use(express.static(publicDir));

app.get("/api/health", async (_request, response) => {
  const sessions = await readSessions();
  await readOverrideStore();
  await readInvestmentStore();
  await getNormalizedHoldings();
  const sessionStore = getSessionStoreHealth();
  const overrideStore = getOverrideStoreHealth();
  const investmentStore = getInvestmentStoreHealth();
  const normalizationStore = getNormalizationStoreHealth();

  const healthChecks = {
    publicDirAccessible: true,
    dataDirWritable: true,
  };

  try {
    await fs.access(publicDir);
  } catch {
    healthChecks.publicDirAccessible = false;
  }

  try {
    await fs.mkdir(path.resolve(".data"), { recursive: true });
    await fs.access(path.resolve(".data"), fsConstants.W_OK);
  } catch {
    healthChecks.dataDirWritable = false;
  }

  const readinessIssues = [
    !healthChecks.publicDirAccessible
      ? "Public directory is not accessible."
      : null,
    !healthChecks.dataDirWritable ? "Data directory is not writable." : null,
    sessionStore.status === "recovered_from_corruption"
      ? "Session store was recovered from corruption."
      : null,
    overrideStore.status === "recovered_from_corruption"
      ? "Category override store was recovered from corruption."
      : null,
  ].filter((issue): issue is string => issue !== null);

  const wifi = getWifiBindSnapshot();
  const keychainServiceName = await getKeychainServiceNameForDiagnostics();
  response.json({
    service: {
      startedAt: serviceStartedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
      nodeVersion: process.version,
      mode: "local",
      status: readinessIssues.length === 0 ? "ready" : "degraded",
      readinessIssues,
      localNetwork: {
        wifi: {
          gating: wifi.gating,
          allowlistEnabled: wifi.allowlistEnabled,
          currentSsid: wifi.currentSsid,
          effectiveHost: wifi.effectiveHost,
          requestedHost: wifi.requestedHost,
          detail: wifi.detail,
        },
      },
    },
    provider: {
      name: "Plaid",
      configured: isPlaidConfigured(),
      environment: config.plaid.environment,
      countryCodes: config.plaid.countryCodes,
      products: config.plaid.products,
      daysRequested: config.plaid.daysRequested,
    },
    localState: {
      sessionStore,
      overrideStore,
      investmentStore,
      normalizationStore,
      checks: healthChecks,
      keychainServiceName,
    },
    sessions: summarizeSessions(sessions),
  });
});

app.post("/api/plaid/create-link-token", async (_request, response, next) => {
  try {
    if (!ensurePlaidConfigured(response)) {
      return;
    }

    console.log("[plaid] creating link token");
    const linkToken = await createLinkToken();
    console.log("[plaid] link token created");
    response.json({ linkToken });
  } catch (error) {
    next(error);
  }
});

app.post("/api/plaid/create-update-link-token", async (request, response, next) => {
  try {
    if (!ensurePlaidConfigured(response)) {
      return;
    }

    const sessions = await readSessions();
    if (sessions.length === 0) {
      response.status(400).json({
        error: "No saved sessions found. Connect an account first.",
      });
      return;
    }

    const requestedItemId =
      typeof request.body?.itemId === "string" ? request.body.itemId : null;
    const session =
      requestedItemId
        ? sessions.find((entry) => entry.itemId === requestedItemId)
        : sessions.length === 1
          ? sessions[0]
          : null;

    if (!session) {
      response.status(400).json({
        error:
          "Multiple saved items found. Provide `itemId` to request an update link token for a specific item.",
      });
      return;
    }

    const accessToken = await getAccessToken(session.itemId);
    const linkToken = await createUpdateLinkToken(accessToken);

    response.json({
      itemId: session.itemId,
      institutionName: session.institutionName,
      linkToken,
      purpose: "additional-consent",
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/plaid/exchange-public-token",
  async (request, response, next) => {
    try {
      if (!ensurePlaidConfigured(response)) {
        return;
      }

      const publicToken = request.body?.publicToken;
      if (!publicToken || typeof publicToken !== "string") {
        response.status(400).json({
          error: "Expected `publicToken` string in request body.",
        });
        return;
      }

      console.log("[plaid] exchanging public token");
      const { accessToken, itemId } = await exchangePublicToken(publicToken);
      console.log("[plaid] public token exchanged", { itemId });

      await storeAccessToken(itemId, accessToken);

      const createdAt = new Date().toISOString();
      const linkMetadata = parseLinkMetadata(request.body?.linkMetadata);

      await upsertSession({
        provider: "plaid",
        itemId,
        institutionId: linkMetadata.institutionId,
        institutionName: linkMetadata.institutionName,
        linkedAccounts: linkMetadata.linkedAccounts,
        accounts: [],
        transactions: [],
        cursor: null,
        createdAt,
        lastRefreshAt: null,
      });
      console.log("[plaid] base session persisted", { itemId });

      console.log("[plaid] fetching balances", { itemId });
      const accounts = await getAccountBalances(accessToken);
      console.log("[plaid] balances fetched", {
        itemId,
        accountCount: accounts.length,
      });

      const storedAccounts = normalizeAccountsForStorage(accounts);
      try {
        console.log("[plaid] backfilling full transaction history", {
          itemId,
          daysRequested: config.plaid.daysRequested,
        });
        const { transactionSync, storedTransactions, historicalWindow } =
          await fetchAndMergeFullTransactionHistory(accessToken, null);
        console.log("[plaid] transactions backfill completed", {
          itemId,
          historicalCount: historicalWindow.totalCount,
          addedCount: transactionSync.added.length,
          modifiedCount: transactionSync.modified.length,
          removedCount: transactionSync.removed.length,
          hasMore: transactionSync.hasMore,
        });

        await upsertSession({
          provider: "plaid",
          itemId,
          institutionId: linkMetadata.institutionId,
          institutionName: linkMetadata.institutionName,
          linkedAccounts: linkMetadata.linkedAccounts,
          accounts: storedAccounts,
          transactions: storedTransactions,
          cursor: transactionSync.cursor,
          createdAt,
          lastRefreshAt: null,
        });
        console.log("[plaid] session updated with sync cursor", { itemId });

        response.json({
          itemId,
          institution: {
            id: linkMetadata.institutionId,
            name: linkMetadata.institutionName,
          },
          linkedAccounts: linkMetadata.linkedAccounts,
          accounts,
          transactions: buildTransactionResponse(
            transactionSync,
            storedTransactions,
            historicalWindow,
          ),
        });
      } catch (error) {
        if (getPlaidErrorCode(error) !== "PRODUCT_NOT_READY") {
          throw error;
        }

        console.warn("[plaid] transactions not ready after link", {
          itemId,
          institutionName: linkMetadata.institutionName,
        });

        await upsertSession({
          provider: "plaid",
          itemId,
          institutionId: linkMetadata.institutionId,
          institutionName: linkMetadata.institutionName,
          linkedAccounts: linkMetadata.linkedAccounts,
          accounts: storedAccounts,
          transactions: [],
          cursor: null,
          createdAt,
          lastRefreshAt: null,
        });

        response.json({
          itemId,
          institution: {
            id: linkMetadata.institutionId,
            name: linkMetadata.institutionName,
          },
          linkedAccounts: linkMetadata.linkedAccounts,
          accounts,
          warning:
            "Plaid linked the item, but transactions are not ready yet. Try Refresh saved sessions or Force refetch full history in a minute.",
          transactions: {
            addedCount: 0,
            modifiedCount: 0,
            removedCount: 0,
            totalCount: 0,
            newestDate: null,
            oldestDate: null,
            historicalRequest: null,
            hasMore: false,
            sample: [],
            status: "not_ready",
          },
        });
      }
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/plaid/refresh", async (request, response, next) => {
  try {
    if (!ensurePlaidConfigured(response)) {
      return;
    }

    const sessions = await readSessions();
    if (sessions.length === 0) {
      response.status(400).json({
        error: "No saved sessions found. Connect an account first.",
      });
      return;
    }

    const requestedItemId =
      typeof request.body?.itemId === "string" ? request.body.itemId : null;
    const sessionsToRefresh = requestedItemId
      ? sessions.filter((session) => session.itemId === requestedItemId)
      : sessions;

    if (requestedItemId && sessionsToRefresh.length === 0) {
      response.status(404).json({
        error: `No saved session found for itemId ${requestedItemId}.`,
      });
      return;
    }

    const results = [];

    for (const session of sessionsToRefresh) {
      const accessToken = await getAccessToken(session.itemId);
      const shouldBackfillTransactions = session.transactions.length === 0;
      console.log("[plaid] refreshing saved session", {
        itemId: session.itemId,
        institutionName: session.institutionName,
        mode: shouldBackfillTransactions ? "backfill" : "delta",
      });
      const accounts = await getAccountBalances(accessToken);
      const storedAccounts = normalizeAccountsForStorage(accounts);
      const { transactionSync, storedTransactions, historicalWindow } =
        shouldBackfillTransactions
          ? await fetchAndMergeFullTransactionHistory(accessToken, session.cursor)
          : {
              transactionSync: await syncTransactions(accessToken, session.cursor),
              storedTransactions: [] as StoredTransactionSnapshot[],
              historicalWindow: undefined,
            };

      const mergedTransactions = shouldBackfillTransactions
        ? storedTransactions
        : mergeTransactions(session.transactions, transactionSync);

      const lastRefreshAt = new Date().toISOString();
      await upsertSession({
        ...session,
        accounts: storedAccounts,
        transactions: mergedTransactions,
        cursor: transactionSync.cursor,
        lastRefreshAt,
      });
      console.log("[plaid] refresh completed", {
        itemId: session.itemId,
        accountCount: accounts.length,
        addedCount: transactionSync.added.length,
        modifiedCount: transactionSync.modified.length,
        removedCount: transactionSync.removed.length,
        hasMore: transactionSync.hasMore,
      });

      results.push({
        itemId: session.itemId,
        institution: {
          id: session.institutionId,
          name: session.institutionName,
        },
        linkedAccounts: session.linkedAccounts,
        lastRefreshAt,
        accounts,
        transactions: buildTransactionResponse(
          transactionSync,
          mergedTransactions,
          historicalWindow,
        ),
      });
    }

    response.json({
      refreshedCount: results.length,
      items: results,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/plaid/refetch-history", async (request, response, next) => {
  try {
    if (!ensurePlaidConfigured(response)) {
      return;
    }

    const sessions = await readSessions();
    if (sessions.length === 0) {
      response.status(400).json({
        error: "No saved sessions found. Connect an account first.",
      });
      return;
    }

    const requestedItemId =
      typeof request.body?.itemId === "string" ? request.body.itemId : null;
    const sessionsToRefetch = requestedItemId
      ? sessions.filter((session) => session.itemId === requestedItemId)
      : sessions;

    if (requestedItemId && sessionsToRefetch.length === 0) {
      response.status(404).json({
        error: `No saved session found for itemId ${requestedItemId}.`,
      });
      return;
    }

    const results = [];

    for (const session of sessionsToRefetch) {
      const accessToken = await getAccessToken(session.itemId);
      console.log("[plaid] force refetching full history", {
        itemId: session.itemId,
        institutionName: session.institutionName,
        daysRequested: config.plaid.daysRequested,
      });

      const accounts = await getAccountBalances(accessToken);
      const storedAccounts = normalizeAccountsForStorage(accounts);
      const { transactionSync, storedTransactions, historicalWindow } =
        await fetchAndMergeFullTransactionHistory(
          accessToken,
          session.cursor,
        );

      const lastRefreshAt = new Date().toISOString();
      await upsertSession({
        ...session,
        accounts: storedAccounts,
        transactions: storedTransactions,
        cursor: transactionSync.cursor,
        lastRefreshAt,
      });

      results.push({
        itemId: session.itemId,
        institution: {
          id: session.institutionId,
          name: session.institutionName,
        },
        linkedAccounts: session.linkedAccounts,
        lastRefreshAt,
        accounts,
        transactions: buildTransactionResponse(
          transactionSync,
          storedTransactions,
          historicalWindow,
        ),
      });
    }

    response.json({
      refreshedCount: results.length,
      mode: "full-history-refetch",
      items: results,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/investments/csv/import", async (request, response, next) => {
  try {
    const content =
      typeof request.body?.content === "string" ? request.body.content : null;
    const institutionName =
      typeof request.body?.institutionName === "string"
        ? request.body.institutionName
        : undefined;

    if (!content) {
      response.status(400).json({
        error: "Expected `content` string in request body.",
      });
      return;
    }

    const parsed = parseFidelityHoldingsFile(content, institutionName);
    const snapshotAt =
      typeof request.body?.snapshotDate === "string"
        ? request.body.snapshotDate.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
    const result = await replaceCsvHoldingsSnapshot(parsed.rows, snapshotAt);
    const normalization = await regenerateNormalizedHoldings();
    const summary = await buildPortfolioSummary();

    response.json({
      importedHoldings: parsed.rows.length,
      warnings: parsed.warnings,
      snapshotAt,
      store: result,
      normalization,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/investments/portfolio-summary", async (_request, response, next) => {
  try {
    const summary = await buildPortfolioSummary();
    response.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/investments/useful-views", async (_request, response, next) => {
  try {
    const data = await buildUsefulInvestmentViews();
    response.json(data);
  } catch (error) {
    next(error);
  }
});

app.post("/api/investments/account-classification", async (request, response, next) => {
  try {
    const accountId =
      typeof request.body?.accountId === "string" ? request.body.accountId : null;
    const classification =
      request.body?.classification === "retirement" ||
      request.body?.classification === "taxable" ||
      request.body?.classification === "unknown"
        ? (request.body.classification as InvestmentAccountClassification)
        : null;

    if (!accountId || !classification) {
      response.status(400).json({
        error:
          "Expected `accountId` and `classification` (`retirement` | `taxable` | `unknown`).",
      });
      return;
    }

    const account = await setInvestmentAccountClassification(accountId, classification);
    if (!account) {
      response.status(404).json({
        error: `No investment account found for accountId ${accountId}.`,
      });
      return;
    }

    const normalization = await regenerateNormalizedHoldings();
    const summary = await buildPortfolioSummary();
    response.json({
      account,
      normalization,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/investments/snapshots", async (_request, response, next) => {
  try {
    const store = await readInvestmentStore();
    const byDate = new Map<
      string,
      {
        date: string;
        holdingCount: number;
        totalValue: number;
      }
    >();
    for (const holding of store.holdings) {
      const date = holding.snapshotAt.slice(0, 10);
      const existing = byDate.get(date) ?? { date, holdingCount: 0, totalValue: 0 };
      existing.holdingCount += 1;
      existing.totalValue += holding.institutionValue ?? 0;
      byDate.set(date, existing);
    }

    response.json({
      snapshotDates: [...byDate.values()].sort((left, right) =>
        left.date < right.date ? 1 : left.date > right.date ? -1 : 0,
      ),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/investments/snapshots/compare", async (request, response, next) => {
  try {
    const from = typeof request.query.from === "string" ? request.query.from : null;
    const to = typeof request.query.to === "string" ? request.query.to : null;
    if (!from || !to) {
      response.status(400).json({
        error: "Expected query params: `from` and `to` (YYYY-MM-DD).",
      });
      return;
    }

    const store = await readInvestmentStore();
    const accountById = new Map(store.accounts.map((account) => [account.id, account]));
    const fromTotal = store.holdings
      .filter((holding) => holding.snapshotAt.slice(0, 10) === from)
      .reduce((sum, holding) => sum + (holding.institutionValue ?? 0), 0);
    const toTotal = store.holdings
      .filter((holding) => holding.snapshotAt.slice(0, 10) === to)
      .reduce((sum, holding) => sum + (holding.institutionValue ?? 0), 0);
    const fromRetirement = store.holdings
      .filter(
        (holding) =>
          holding.snapshotAt.slice(0, 10) === from &&
          (accountById.get(holding.accountId)?.classification ?? "unknown") ===
            "retirement",
      )
      .reduce((sum, holding) => sum + (holding.institutionValue ?? 0), 0);
    const toRetirement = store.holdings
      .filter(
        (holding) =>
          holding.snapshotAt.slice(0, 10) === to &&
          (accountById.get(holding.accountId)?.classification ?? "unknown") ===
            "retirement",
      )
      .reduce((sum, holding) => sum + (holding.institutionValue ?? 0), 0);

    response.json({
      from,
      to,
      totals: {
        fromTotal,
        toTotal,
        absoluteChange: toTotal - fromTotal,
      },
      retirement: {
        fromTotal: fromRetirement,
        toTotal: toRetirement,
        absoluteChange: toRetirement - fromRetirement,
      },
      taxableOrUnknown: {
        fromTotal: fromTotal - fromRetirement,
        toTotal: toTotal - toRetirement,
        absoluteChange: (toTotal - toRetirement) - (fromTotal - fromRetirement),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/investments/normalize", async (_request, response, next) => {
  try {
    const result = await regenerateNormalizedHoldings();
    const normalized = await getNormalizedHoldings();
    response.json({
      ...result,
      sample: normalized.rows.slice(0, 25),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/investments/normalized", async (_request, response, next) => {
  try {
    const normalized = await getNormalizedHoldings({
      regenerateIfMissing: true,
    });
    response.json({
      generatedAt: normalized.generatedAt,
      rowCount: normalized.rowCount,
      rows: normalized.rows,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/investments/plaid/sync", async (request, response, next) => {
  try {
    if (!ensurePlaidConfigured(response)) {
      return;
    }
    if (!config.plaid.products.includes("investments")) {
      response.status(400).json({
        error:
          "PLAID_PRODUCTS must include `investments` before syncing investment data. Update your env, restart the server, then run update consent if needed.",
      });
      return;
    }

    const sessions = await readSessions();
    if (sessions.length === 0) {
      response.status(400).json({
        error: "No saved Plaid sessions found. Connect an account first.",
      });
      return;
    }

    const requestedItemId =
      typeof request.body?.itemId === "string" ? request.body.itemId : null;
    const snapshotDate =
      typeof request.body?.snapshotDate === "string"
        ? request.body.snapshotDate.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
    const sessionsToSync = requestedItemId
      ? sessions.filter((session) => session.itemId === requestedItemId)
      : sessions;

    if (requestedItemId && sessionsToSync.length === 0) {
      response.status(404).json({
        error: `No saved session found for itemId ${requestedItemId}.`,
      });
      return;
    }

    const results: Array<{
      itemId: string;
      institutionName: string | null;
      importedAccounts: number;
      importedHoldings: number;
      importedTransactions: number;
      warning: string | null;
    }> = [];
    const consentRequiredItems: Array<{
      itemId: string;
      institutionName: string | null;
      errorCode: string;
    }> = [];

    for (const session of sessionsToSync) {
      const accessToken = await getAccessToken(session.itemId);
      let warning: string | null = null;
      let transactionsPayload: unknown[] = [];

      let holdingsPayload: Awaited<ReturnType<typeof getInvestmentHoldings>>;
      try {
        holdingsPayload = await getInvestmentHoldings(accessToken);
      } catch (error) {
        const plaidErrorCode = getPlaidErrorCode(error);
        if (plaidErrorCode === "ADDITIONAL_CONSENT_REQUIRED") {
          consentRequiredItems.push({
            itemId: session.itemId,
            institutionName: session.institutionName,
            errorCode: plaidErrorCode,
          });
          continue;
        }
        throw error;
      }
      try {
        transactionsPayload = (
          await getInvestmentTransactions(accessToken)
        ).transactions;
      } catch (error) {
        const plaidErrorCode = getPlaidErrorCode(error);
        if (plaidErrorCode === "PRODUCT_NOT_READY") {
          warning =
            "Investments transactions are not ready yet; holdings were synced.";
        } else {
          throw error;
        }
      }

      const parsedAccounts = holdingsPayload.accounts
        .map((account) => parsePlaidInvestmentAccount(account))
        .filter(
          (
            account,
          ): account is {
            id: string;
            name: string | null;
            mask: string | null;
            subtype: string | null;
            type: string | null;
          } => account !== null,
        );
      const parsedSecurities = holdingsPayload.securities
        .map((security) => parsePlaidInvestmentSecurity(security))
        .filter(
          (
            security,
          ): security is {
            id: string | null;
            ticker: string | null;
            name: string | null;
            cusip: string | null;
            isin: string | null;
            type: string | null;
            closePrice: number | null;
            closePriceAsOf: string | null;
            isoCurrencyCode: string | null;
            unofficialCurrencyCode: string | null;
          } => security !== null,
        );
      const parsedHoldings = holdingsPayload.holdings
        .map((holding) => parsePlaidInvestmentHolding(holding))
        .filter(
          (
            holding,
          ): holding is {
            id: string | null;
            accountId: string | null;
            securityId: string | null;
            quantity: number | null;
            institutionValue: number | null;
            institutionPrice: number | null;
            costBasis: number | null;
            isoCurrencyCode: string | null;
            unofficialCurrencyCode: string | null;
          } => holding !== null,
        );
      const parsedTransactions = transactionsPayload
        .map((transaction) => parsePlaidInvestmentTransaction(transaction))
        .filter(
          (
            transaction,
          ): transaction is {
            id: string;
            accountId: string | null;
            securityId: string | null;
            type: string | null;
            subtype: string | null;
            amount: number | null;
            quantity: number | null;
            price: number | null;
            fees: number | null;
            date: string | null;
            isoCurrencyCode: string | null;
            unofficialCurrencyCode: string | null;
            name: string | null;
          } => transaction !== null,
        );

      const snapshotResult = await replacePlaidItemSnapshot({
        itemId: session.itemId,
        institutionName: session.institutionName,
        accounts: parsedAccounts,
        securities: parsedSecurities,
        holdings: parsedHoldings,
        transactions: parsedTransactions,
      }, snapshotDate);

      results.push({
        itemId: session.itemId,
        institutionName: session.institutionName,
        importedAccounts: snapshotResult.accountCount,
        importedHoldings: snapshotResult.holdingCount,
        importedTransactions: snapshotResult.transactionCount,
        warning,
      });
    }

    if (results.length === 0 && consentRequiredItems.length > 0) {
      response.status(409).json({
        error:
          "Additional Plaid consent is required before syncing investments. Run the update consent flow for the affected item(s), then retry sync.",
        code: "ADDITIONAL_CONSENT_REQUIRED",
        items: consentRequiredItems,
      });
      return;
    }

    const summary = await buildPortfolioSummary();
    const normalization = await regenerateNormalizedHoldings();
    response.json({
      syncedCount: results.length,
      snapshotAt: snapshotDate,
      items: results,
      consentRequiredItems,
      normalization,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/export", async (request, response, next) => {
  try {
    const rawType = request.body?.type;
    if (!rawType || typeof rawType !== "string" || !VALID_EXPORT_TYPES.has(rawType)) {
      response.status(400).json({
        error: `Expected \`type\` to be one of: ${[...VALID_EXPORT_TYPES].join(", ")}`,
      });
      return;
    }

    const exportType = rawType as ExportType;
    const from =
      typeof request.body?.from === "string" ? request.body.from : null;
    const to =
      typeof request.body?.to === "string" ? request.body.to : null;
    const isInvestmentExport = INVESTMENT_EXPORT_TYPES.has(exportType);

    const sessions = await readSessions();
    if (!isInvestmentExport && sessions.length === 0) {
      response.status(400).json({
        error: "No saved sessions found. Connect an account first.",
      });
      return;
    }

    const totalTransactions = sessions.reduce((sum, s) => sum + s.transactions.length, 0);
    if (!isInvestmentExport && totalTransactions === 0) {
      response.status(400).json({
        error:
          "Sessions exist but contain no transactions. Refresh or refetch history first.",
      });
      return;
    }

    const params: ExportParams = { type: exportType, from, to };
    console.log("[export] generating", params);

    const result = await generateExport(sessions, params);
    console.log("[export] written", {
      type: exportType,
      rowCount: result.rowCount,
      filePath: result.filePath,
    });

    response.json({
      type: exportType,
      from,
      to,
      rowCount: result.rowCount,
      filePath: result.filePath,
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// BL04: Financial Intelligence — briefing and conversational query
// ---------------------------------------------------------------------------

async function ensureFreshMasterTsv(): Promise<string> {
  const sessions = await readSessions();
  if (sessions.length === 0) {
    throw new Error("No saved sessions found. Connect an account first.");
  }
  const totalTxns = sessions.reduce((s, i) => s + i.transactions.length, 0);
  if (totalTxns === 0) {
    throw new Error(
      "Sessions exist but contain no transactions. Refresh or refetch history first.",
    );
  }
  return writeMasterTsv(sessions);
}

function ensureLlmConfigured(response: express.Response): boolean {
  if (isLlmConfigured()) return true;
  response.status(503).json({
    error:
      "LLM is not configured. Set LLM_PROVIDER and the matching API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY) in .env.local or .env. Required for briefings, chat, and category review.",
  });
  return false;
}

const sessionConversations = new Map<
  string,
  { metrics: Awaited<ReturnType<typeof runBriefingMetrics>>; history: ConversationMessage[]; tsvFilename: string }
>();

app.post("/api/briefing", async (request, response, next) => {
  try {
    if (!ensureLlmConfigured(response)) return;

    const from =
      typeof request.body?.from === "string" ? request.body.from : null;
    const to =
      typeof request.body?.to === "string" ? request.body.to : null;

    console.log("[briefing] generating fresh master TSV");
    const tsvFilename = await ensureFreshMasterTsv();

    console.log("[briefing] running DuckDB metrics", { from, to });
    const metrics = await runBriefingMetrics(tsvFilename, from, to);

    console.log("[briefing] calling LLM for narration");
    const { text: briefing, usage } = await generateBriefing(metrics);

    const sessionId = `session-${Date.now()}`;
    sessionConversations.set(sessionId, { metrics, history: [], tsvFilename });

    console.log("[briefing] done", { sessionId, period: metrics.period });
    response.json({
      sessionId,
      period: metrics.period,
      briefing,
      usage,
      cumulativeUsage: getCumulativeUsage(),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ask", async (request, response, next) => {
  try {
    if (!ensureLlmConfigured(response)) return;

    const question = request.body?.question;
    if (!question || typeof question !== "string") {
      response
        .status(400)
        .json({ error: "Expected `question` string in request body." });
      return;
    }

    const sessionId =
      typeof request.body?.sessionId === "string"
        ? request.body.sessionId
        : null;

    let ctx = sessionId ? sessionConversations.get(sessionId) : undefined;

    if (!ctx) {
      console.log("[ask] no session context — generating fresh metrics");
      const tsvFilename = await ensureFreshMasterTsv();
      const metrics = await runBriefingMetrics(tsvFilename);
      const newSessionId = `session-${Date.now()}`;
      ctx = { metrics, history: [], tsvFilename };
      sessionConversations.set(newSessionId, ctx);
    }

    console.log("[ask] processing question", {
      sessionId,
      historyLength: ctx.history.length,
    });
    const result = await askQuestion(
      question,
      ctx.metrics,
      ctx.history,
      ctx.tsvFilename,
    );
    ctx.history = result.conversation;

    response.json({
      sessionId: sessionId ?? [...sessionConversations.keys()].pop(),
      answer: result.answer,
      usage: result.usage,
      cumulativeUsage: getCumulativeUsage(),
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// BL05: Category Override & Review Queue
// ---------------------------------------------------------------------------

app.get("/api/overrides/stats", async (_request, response, next) => {
  try {
    const stats = await getOverrideStats();
    response.json(stats);
  } catch (error) {
    next(error);
  }
});

app.get("/api/overrides/pending", async (_request, response, next) => {
  try {
    const [items, sessions] = await Promise.all([
      getPendingReviews(),
      readSessions(),
    ]);
    const transactionLookup = new Map(
      sessions.flatMap((session) =>
        session.transactions.map((transaction) => [transaction.id, transaction] as const),
      ),
    );
    const enrichedItems = items.map((item) => {
      const source = transactionLookup.get(item.transactionId);
      if (!source) return item;
      return {
        ...item,
        transactionName: item.transactionName ?? source.name ?? null,
        merchantName: item.merchantName ?? source.merchantName ?? null,
        merchantEntityId: item.merchantEntityId ?? source.merchantEntityId ?? null,
        transactionDate:
          item.transactionDate ??
          source.date ??
          source.authorizedDate ??
          null,
        transactionAmount:
          item.transactionAmount ??
          (typeof source.amount === "number" ? source.amount : null),
        transactionLocationCity:
          item.transactionLocationCity ?? source.locationCity ?? null,
        transactionLocationRegion:
          item.transactionLocationRegion ?? source.locationRegion ?? null,
        transactionLocationCountry:
          item.transactionLocationCountry ?? source.locationCountry ?? null,
      };
    });
    response.json({ items: enrichedItems, count: enrichedItems.length });
  } catch (error) {
    next(error);
  }
});

app.get("/api/overrides/review/progress", async (_request, response) => {
  response.json({
    active: categoryReviewProgress.active,
    total: categoryReviewProgress.total,
    reviewed: categoryReviewProgress.reviewed,
    from: categoryReviewProgress.from,
    to: categoryReviewProgress.to,
    startedAt: categoryReviewProgress.startedAt,
    finishedAt: categoryReviewProgress.finishedAt,
  });
});

app.post("/api/overrides/review", async (request, response, next) => {
  let runStarted = false;
  try {
    if (!ensureLlmConfigured(response)) return;
    if (categoryReviewProgress.active) {
      response.status(409).json({
        error: "Category review already in progress. Wait for current run to finish.",
      });
      return;
    }

    const from = parseDateParam(request.body?.from);
    const to = parseDateParam(request.body?.to);
    const forceReReview = request.body?.forceReReview === true;

    if (request.body?.from != null && !from) {
      response.status(400).json({
        error: "`from` must use YYYY-MM-DD format.",
      });
      return;
    }
    if (request.body?.to != null && !to) {
      response.status(400).json({
        error: "`to` must use YYYY-MM-DD format.",
      });
      return;
    }
    if (from && to && from > to) {
      response.status(400).json({
        error: "`from` must be earlier than or equal to `to`.",
      });
      return;
    }

    const sessions = await readSessions();
    if (sessions.length === 0) {
      response.status(400).json({
        error: "No saved sessions found. Connect an account first.",
      });
      return;
    }

    const allTransactions = sessions.flatMap((s) => s.transactions);
    if (allTransactions.length === 0) {
      response.status(400).json({
        error:
          "Sessions exist but contain no transactions. Refresh or refetch history first.",
      });
      return;
    }

    console.log("[category-review] starting LLM review", {
      transactionCount: allTransactions.length,
      from,
      to,
      forceReReview,
    });
    categoryReviewProgress.active = true;
    categoryReviewProgress.total = 0;
    categoryReviewProgress.reviewed = 0;
    categoryReviewProgress.from = from;
    categoryReviewProgress.to = to;
    categoryReviewProgress.startedAt = new Date().toISOString();
    categoryReviewProgress.finishedAt = null;
    runStarted = true;

    let clearedLedgerReset = 0;
    if (forceReReview) {
      clearedLedgerReset = await clearReviewedTransactions();
    }

    const result = await runCategoryReview(allTransactions, {
      from,
      to,
      onProgress: (state) => {
        categoryReviewProgress.total = state.total;
        categoryReviewProgress.reviewed = state.reviewed;
      },
    });

    console.log("[category-review] done", {
      reviewed: result.reviewed,
      added: result.added,
      from,
      to,
      forceReReview,
      clearedLedgerReset,
    });

    response.json({
      reviewed: result.reviewed,
      added: result.added,
      from,
      to,
      forceReReview,
      clearedLedgerReset,
      usage: result.usage,
      cumulativeUsage: getCumulativeUsage(),
    });
  } catch (error) {
    next(error);
  } finally {
    if (runStarted) {
      categoryReviewProgress.active = false;
      categoryReviewProgress.finishedAt = new Date().toISOString();
    }
  }
});

app.post("/api/overrides", async (request, response, next) => {
  try {
    const transactionId = request.body?.transactionId;
    const primary = request.body?.primary;
    const detailed = request.body?.detailed;
    const source = request.body?.source;

    if (
      typeof transactionId !== "string" ||
      typeof primary !== "string" ||
      typeof detailed !== "string"
    ) {
      response.status(400).json({
        error:
          "Expected `transactionId`, `primary`, and `detailed` strings in request body.",
      });
      return;
    }

    const validSources: OverrideSource[] = ["llm", "manual"];
    const effectiveSource: OverrideSource = validSources.includes(source)
      ? source
      : "manual";

    await setOverride(transactionId, primary, detailed, effectiveSource);

    if (request.body?.reviewAction) {
      const reviewStatus: ReviewStatus =
        request.body.reviewAction === "accept" ? "accepted" : "rejected";
      await updateReviewStatus(transactionId, reviewStatus);
    }

    let autoResolvedPendingCount = 0;
    if (request.body?.applyMerchantRule) {
      const merchantName =
        typeof request.body.merchantName === "string"
          ? request.body.merchantName
          : null;
      const merchantEntityId =
        typeof request.body.merchantEntityId === "string"
          ? request.body.merchantEntityId
          : null;
      const matchDescription =
        typeof request.body.transactionName === "string"
          ? request.body.transactionName
          : null;
      if (merchantName || merchantEntityId) {
        await upsertMerchantRule(
          merchantName,
          merchantEntityId,
          matchDescription,
          primary,
          detailed,
        );
        autoResolvedPendingCount = await autoResolvePendingReviewsByMerchantRule(
          {
            merchantName,
            merchantEntityId,
            matchDescription,
            overridePrimary: primary,
            overrideDetailed: detailed,
            createdAt: new Date().toISOString(),
          },
          { exceptTransactionId: transactionId },
        );
      }
    }

    console.log("[overrides] applied", {
      transactionId,
      primary,
      detailed,
      source: effectiveSource,
    });

    response.json({
      ok: true,
      transactionId,
      primary,
      detailed,
      autoResolvedPendingCount,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/overrides/reject", async (request, response, next) => {
  try {
    const transactionId = request.body?.transactionId;
    if (typeof transactionId !== "string") {
      response
        .status(400)
        .json({ error: "Expected `transactionId` string in request body." });
      return;
    }
    const updated = await updateReviewStatus(transactionId, "rejected");
    if (!updated) {
      response.status(404).json({
        error: `No review queue item found for transaction ${transactionId}.`,
      });
      return;
    }
    response.json({ ok: true, transactionId });
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/overrides/merchant-rules",
  async (_request, response, next) => {
    try {
      const rules = await getMerchantRules();
      response.json({ rules });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/overrides/merchant-rules",
  async (request, response, next) => {
    try {
      const merchantName =
        typeof request.body?.merchantName === "string"
          ? request.body.merchantName
          : null;
      const merchantEntityId =
        typeof request.body?.merchantEntityId === "string"
          ? request.body.merchantEntityId
          : null;
      const primary = request.body?.primary;
      const detailed = request.body?.detailed;
      const matchDescription =
        typeof request.body?.matchDescription === "string"
          ? request.body.matchDescription
          : null;

      if (typeof primary !== "string" || typeof detailed !== "string") {
        response.status(400).json({
          error: "Expected `primary` and `detailed` strings in request body.",
        });
        return;
      }

      if (!merchantName && !merchantEntityId) {
        response.status(400).json({
          error:
            "At least one of `merchantName` or `merchantEntityId` is required.",
        });
        return;
      }

      await upsertMerchantRule(
        merchantName,
        merchantEntityId,
        matchDescription,
        primary,
        detailed,
      );
      response.json({
        ok: true,
        merchantName,
        merchantEntityId,
        matchDescription,
        primary,
        detailed,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.delete(
  "/api/overrides/merchant-rules",
  async (request, response, next) => {
    try {
      const merchantName =
        typeof request.body?.merchantName === "string"
          ? request.body.merchantName
          : null;
      const merchantEntityId =
        typeof request.body?.merchantEntityId === "string"
          ? request.body.merchantEntityId
          : null;

      if (!merchantName && !merchantEntityId) {
        response.status(400).json({
          error:
            "At least one of `merchantName` or `merchantEntityId` is required.",
        });
        return;
      }

      const removed = await removeMerchantRule(merchantName, merchantEntityId);
      if (!removed) {
        response
          .status(404)
          .json({ error: "No matching merchant rule found." });
        return;
      }
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

app.delete(
  "/api/overrides/:transactionId",
  async (request, response, next) => {
    try {
      const { transactionId } = request.params;
      const removed = await removeOverride(transactionId);
      if (!removed) {
        response
          .status(404)
          .json({ error: `No override found for transaction ${transactionId}.` });
        return;
      }
      response.json({ ok: true, transactionId });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// BL07: Budget targets and category-level spend tracking
// ---------------------------------------------------------------------------

app.get("/api/budgets/targets", async (_request, response, next) => {
  try {
    const validation = await validateBudgetDefinitions();
    response.json({
      filePath: validation.filePath,
      definitions: validation.definitions,
      count: validation.definitions.length,
      valid: validation.valid,
      issues: validation.issues,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/budgets/validate", async (_request, response, next) => {
  try {
    const validation = await validateBudgetDefinitions();
    response.json(validation);
  } catch (error) {
    next(error);
  }
});

app.get("/api/budgets/review", async (request, response, next) => {
  try {
    const range = getCurrentWeekRange();
    const from = parseDateParam(request.query.from) ?? range.from;
    const to = parseDateParam(request.query.to) ?? range.to;
    if (from > to) {
      response
        .status(400)
        .json({ error: "`from` must be earlier than or equal to `to`." });
      return;
    }
    const sessions = await readSessions();
    const review = await buildBudgetReview(sessions, from, to);
    response.json(review);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// BL09: Recurring transaction detection (local DuckDB, no Plaid call)
// ---------------------------------------------------------------------------

app.get("/api/recurring", async (request, response, next) => {
  try {
    const from = parseDateParam(request.query.from) ?? null;
    const to = parseDateParam(request.query.to) ?? null;

    if (from && to) {
      const diffMs = new Date(to).getTime() - new Date(from).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays < 28) {
        response.status(400).json({ error: "Window must be at least 1 month." });
        return;
      }
    }

    console.log("[recurring] detecting recurring streams from local data", { from, to });
    const tsvFilename = await ensureFreshMasterTsv();
    const summary = await detectRecurringStreams(tsvFilename, from, to);

    console.log("[recurring] done", {
      period: summary.period,
      activeInflows: summary.totals.activeInflowCount,
      activeOutflows: summary.totals.activeOutflowCount,
      totalStreams: summary.streams.length,
    });

    response.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/recurring/transactions", async (request, response, next) => {
  try {
    const streamKey = typeof request.query.streamKey === "string" ? request.query.streamKey : null;
    if (!streamKey) {
      response.status(400).json({ error: "streamKey query parameter is required." });
      return;
    }

    const from = parseDateParam(request.query.from) ?? null;
    const to = parseDateParam(request.query.to) ?? null;

    const tsvFilename = await ensureFreshMasterTsv();
    const transactions = await queryStreamTransactions(tsvFilename, streamKey, from, to);

    response.json({ transactions });
  } catch (error) {
    next(error);
  }
});

app.post("/api/session/reset", async (_request, response, next) => {
  try {
    await clearSessions();
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// File Browser — list, serve, and pretty-print exported / context files
// ---------------------------------------------------------------------------

const THEME_SCRIPT = `<script>
(function(){
  function apply(t){
    if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);
    else document.documentElement.removeAttribute("data-theme");
  }
  apply(localStorage.getItem("theme"));
  window.addEventListener("storage",function(e){
    if(e.key==="theme")apply(e.newValue);
  });
})();
</script>`;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTsvViewer(filename: string, content: string): string {
  const lines = content.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    return renderTextViewer(filename, "(empty file)");
  }

  const headers = lines[0]!.split("\t");
  const rows = lines.slice(1).map((line) => line.split("\t"));

  const headerHtml = headers
    .map(
      (h, i) =>
        `<th data-col="${i}" style="cursor:pointer;user-select:none;" onclick="sortTable(${i})">${esc(h)} <span id="arrow-${i}"></span></th>`,
    )
    .join("");

  const bodyHtml = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(filename)}</title>
${THEME_SCRIPT}
<style>
  :root,[data-theme="dark"]{color-scheme:dark;--bg:#0f172a;--fg:#e2e8f0;--card-bg:#111827;--border:#334155;--surface:#1e293b;--deep:#020617;--muted:#94a3b8;--accent:#2563eb;--hover-row:#172033;}
  @media(prefers-color-scheme:light){:root:not([data-theme="dark"]){color-scheme:light;--bg:#f8fafc;--fg:#1e293b;--card-bg:#ffffff;--border:#e2e8f0;--surface:#f1f5f9;--deep:#ffffff;--muted:#64748b;--accent:#2563eb;--hover-row:#f1f5f9;}}
  [data-theme="light"]{color-scheme:light;--bg:#f8fafc;--fg:#1e293b;--card-bg:#ffffff;--border:#e2e8f0;--surface:#f1f5f9;--deep:#ffffff;--muted:#64748b;--accent:#2563eb;--hover-row:#f1f5f9;}
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: var(--bg); color: var(--fg); }
  .toolbar { position: sticky; top: 0; z-index: 10; background: var(--card-bg); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .toolbar h1 { font-size: 16px; margin: 0; }
  .toolbar .meta { color: var(--muted); font-size: 13px; }
  .toolbar input { background: var(--deep); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; width: 260px; }
  .toolbar input:focus { outline: none; border-color: var(--accent); }
  .table-wrap { overflow-x: auto; padding: 0 12px 40px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 8px; }
  th { position: sticky; top: 52px; background: var(--surface); text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--border); font-weight: 600; white-space: nowrap; }
  td { padding: 6px 10px; border-bottom: 1px solid var(--surface); white-space: nowrap; max-width: 350px; overflow: hidden; text-overflow: ellipsis; }
  tr:hover td { background: var(--hover-row); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div class="toolbar">
  <div>
    <h1>${esc(filename)}</h1>
    <div class="meta">${rows.length.toLocaleString()} rows &middot; ${headers.length} columns</div>
  </div>
  <input id="search" type="text" placeholder="Filter rows..." oninput="filterRows()" />
</div>
<div class="table-wrap">
<table>
  <thead><tr>${headerHtml}</tr></thead>
  <tbody id="tbody">${bodyHtml}</tbody>
</table>
</div>
<script>
const tbody = document.getElementById("tbody");
const allRows = [...tbody.querySelectorAll("tr")];
let sortCol = -1, sortAsc = true;

function sortTable(col) {
  if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
  document.querySelectorAll("th span").forEach(s => s.textContent = "");
  document.getElementById("arrow-" + col).textContent = sortAsc ? " \\u25B2" : " \\u25BC";
  allRows.sort((a, b) => {
    const av = a.children[col]?.textContent ?? "";
    const bv = b.children[col]?.textContent ?? "";
    const an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return sortAsc ? an - bn : bn - an;
    return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
  });
  for (const r of allRows) tbody.appendChild(r);
}

function filterRows() {
  const q = document.getElementById("search").value.toLowerCase();
  for (const row of allRows) {
    const text = row.textContent?.toLowerCase() ?? "";
    row.style.display = text.includes(q) ? "" : "none";
  }
}

// Auto-detect numeric columns and right-align them
const firstRow = allRows[0];
if (firstRow) {
  for (let i = 0; i < firstRow.children.length; i++) {
    const val = firstRow.children[i]?.textContent ?? "";
    if (/^-?\\d+(\\.\\d+)?$/.test(val.trim())) {
      for (const row of allRows) {
        if (row.children[i]) row.children[i].classList.add("num");
      }
    }
  }
}
</script>
</body>
</html>`;
}

function renderTextViewer(filename: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(filename)}</title>
${THEME_SCRIPT}
<style>
  :root,[data-theme="dark"]{color-scheme:dark;--bg:#0f172a;--fg:#e2e8f0;--card-bg:#111827;--border:#334155;}
  @media(prefers-color-scheme:light){:root:not([data-theme="dark"]){color-scheme:light;--bg:#f8fafc;--fg:#1e293b;--card-bg:#ffffff;--border:#e2e8f0;}}
  [data-theme="light"]{color-scheme:light;--bg:#f8fafc;--fg:#1e293b;--card-bg:#ffffff;--border:#e2e8f0;}
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: var(--bg); color: var(--fg); padding: 20px; }
  h1 { font-size: 16px; margin: 0 0 16px; }
  pre { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow-x: auto; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<h1>${esc(filename)}</h1>
<pre>${esc(content)}</pre>
</body>
</html>`;
}

const FILE_CATEGORIES: Record<string, { dir: string; extensions: string[] }> = {
  exports: { dir: path.resolve("exports"), extensions: [".tsv"] },
  context: { dir: path.resolve("context"), extensions: [".yml", ".yaml", ".md"] },
};

interface FileEntry {
  name: string;
  size: number;
  modified: string;
}

async function listFiles(
  dir: string,
  extensions: string[],
): Promise<FileEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files: FileEntry[] = [];
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!extensions.includes(ext)) continue;
    try {
      const stat = await fs.stat(path.join(dir, entry));
      if (!stat.isFile()) continue;
      files.push({
        name: entry,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      // skip files we can't stat
    }
  }

  files.sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
  );
  return files;
}

function requireDebugFiles(response: express.Response): boolean {
  if (config.debugFiles) {
    return true;
  }
  response.status(403).json({ error: "File browsing is disabled. Set DEBUG_FILES=true to enable." });
  return false;
}

app.get("/api/files", async (_request, response, next) => {
  if (!requireDebugFiles(response)) return;
  try {
    const result: Record<string, FileEntry[]> = {};
    for (const [category, { dir, extensions }] of Object.entries(FILE_CATEGORIES)) {
      result[category] = await listFiles(dir, extensions);
    }
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/files/:category/:filename/view",
  async (request, response, next) => {
    if (!requireDebugFiles(response)) return;
    try {
      const { category, filename } = request.params;

      const categoryConfig = FILE_CATEGORIES[category];
      if (!categoryConfig) {
        response.status(400).json({ error: `Invalid category "${category}".` });
        return;
      }
      if (
        filename.includes("..") ||
        filename.includes("/") ||
        filename.includes("\\")
      ) {
        response.status(400).json({ error: "Invalid filename." });
        return;
      }

      const filePath = path.join(categoryConfig.dir, filename);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        response.status(404).json({ error: "File not found." });
        return;
      }

      const ext = path.extname(filename).toLowerCase();
      if (ext === ".tsv") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.send(renderTsvViewer(filename, content));
      } else {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.send(renderTextViewer(filename, content));
      }
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/files/:category/:filename", async (request, response, next) => {
  if (!requireDebugFiles(response)) return;
  try {
    const { category, filename } = request.params;

    const categoryConfig = FILE_CATEGORIES[category];
    if (!categoryConfig) {
      response.status(400).json({ error: `Invalid category "${category}".` });
      return;
    }

    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      response.status(400).json({ error: "Invalid filename." });
      return;
    }

    const filePath = path.join(categoryConfig.dir, filename);
    try {
      await fs.access(filePath);
    } catch {
      response.status(404).json({ error: "File not found." });
      return;
    }

    const content = await fs.readFile(filePath, "utf-8");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.send(content);
  } catch (error) {
    next(error);
  }
});

app.use((_request, response) => {
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    const extracted = extractErrorDetails(error);

    console.error("[server] request failed", {
      status: extracted.status,
      message: extracted.message,
      ...(extracted.logContext ? { context: extracted.logContext } : {}),
    });

    response.status(extracted.status).json({ error: extracted.message });
  },
);

let httpServer: Server | null = null;
let wifiRecheckTimer: ReturnType<typeof setInterval> | null = null;
let didFirstListenLog = false;
let shuttingDown = false;

function currentBoundAddressString(): string | null {
  if (!httpServer) {
    return null;
  }
  const addr = httpServer.address();
  if (addr && typeof addr === "object") {
    return `${addr.address}:${addr.port}`;
  }
  return addr == null ? null : String(addr);
}

function doListenForHttp(bindHost: string): void {
  const { port } = config;
  httpServer = app.listen(port, bindHost, () => {
    if (!httpServer) {
      return;
    }
    const bound = currentBoundAddressString() ?? "?";

    console.log(
      `Budget tracker listening on http://${bindHost}:${port}`,
    );
    console.log(`[server] bound to ${bound}`);

    const snap = getWifiBindSnapshot();
    if (snap.requestedHost === "127.0.0.1" || snap.requestedHost === "localhost") {
      console.warn(
        "[server] HOST is loopback only — set HOST=0.0.0.0 plus LAN_ACCESS_CODE and LAN_ALLOWED_WIFI_SSIDS for LAN (or BUDGET_TRACKER_DISABLE_WIFI_GATING=1 on Linux/CI).",
      );
    } else if (bindHost === "0.0.0.0" && snap.requestedHost === "0.0.0.0") {
      console.log(
        "[server] LAN: open http://<this-Mac-IP>:" +
          String(port) +
          " on other devices (this Mac’s IP: run `ipconfig getifaddr en0`, or check System Settings → Network → Wi‑Fi → Details).",
      );
    }

    if (isLanAccessEnabled()) {
      console.log(
        "[server] LAN access gate enabled (session cookie or Authorization: Bearer)",
      );
    }
    if (!didFirstListenLog) {
      didFirstListenLog = true;
      validateLlmConfig();
    }
  });

  if (!httpServer) {
    return;
  }

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[server] cannot bind ${bindHost}:${port} — address already in use (another process is likely using this port).`,
      );
      console.error(
        `[server] Stop the other server, or set PORT to a free port in .env.local. On macOS you can run: lsof -iTCP:${port} -sTCP:LISTEN`,
      );
    } else if (err.code === "EACCES") {
      console.error(
        `[server] permission denied binding ${bindHost}:${port} (ports below 1024 often require admin).`,
      );
    } else {
      console.error(
        `[server] failed to start HTTP server (${err.code ?? "unknown"})`,
        err.message,
      );
    }
    process.exit(1);
  });
}

function refreshHttpBinding(): void {
  const ssid = getCurrentWifiSsid();
  const { host: nextHost, logLines } = resolveListenHost(ssid);
  for (const line of logLines) {
    console.log(line);
  }

  if (httpServer) {
    const addr = httpServer.address();
    if (addr && typeof addr === "object" && "address" in addr) {
      if (addr.address === nextHost) {
        return;
      }
    }
  }

  if (httpServer) {
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
    httpServer.close((closeErr) => {
      if (closeErr) {
        console.error("[server] close before rebind failed", closeErr);
        return;
      }
      httpServer = null;
      doListenForHttp(nextHost);
    });
  } else {
    doListenForHttp(nextHost);
  }
}

assertLanWifiRequirementsMet();
refreshHttpBinding();
if (config.lanAllowedWifiSsids.length > 0 && !config.disableWifiGating) {
  const ms = config.lanWifiCheckIntervalSec * 1000;
  wifiRecheckTimer = setInterval(() => {
    if (!shuttingDown) {
      refreshHttpBinding();
    }
  }, ms);
  if (typeof wifiRecheckTimer.unref === "function") {
    wifiRecheckTimer.unref();
  }
  console.log(
    `[server] Wi‑Fi SSID recheck every ${config.lanWifiCheckIntervalSec}s (LAN allowlist active).`,
  );
}

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (wifiRecheckTimer) {
    clearInterval(wifiRecheckTimer);
    wifiRecheckTimer = null;
  }
  console.log(`[server] received ${signal}, starting graceful shutdown`);

  const forceExitTimer = setTimeout(() => {
    console.error("[server] graceful shutdown timed out after 10s");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  if (!httpServer) {
    process.exit(0);
    return;
  }

  httpServer.close((error) => {
    clearTimeout(forceExitTimer);
    if (error) {
      console.error("[server] shutdown failed", error);
      process.exit(1);
      return;
    }

    httpServer = null;
    console.log("[server] shutdown complete");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
