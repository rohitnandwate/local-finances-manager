import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Holding,
  InvestmentAccount,
  InvestmentSource,
  InvestmentStore,
  Security,
} from "./investment-store.js";
import { readInvestmentStore } from "./investment-store.js";

const DATA_DIR = path.resolve(".data");
const NORMALIZED_PATH = path.join(DATA_DIR, "investment-normalized.json");
const NORMALIZED_VERSION = 1;
const CORRUPT_BACKUP_PREFIX = "investment-normalized.corrupt";

type NormalizationReadStatus =
  | "ok"
  | "missing_initialized_empty"
  | "recovered_from_corruption";

type NormalizationDiagnostics = {
  status: NormalizationReadStatus;
  lastReadAt: string;
  details: string;
  backupPath: string | null;
};

let diagnostics: NormalizationDiagnostics = {
  status: "missing_initialized_empty",
  lastReadAt: new Date(0).toISOString(),
  details: "Normalized holdings store has not been read yet.",
  backupPath: null,
};

export type CanonicalMatchMethod =
  | "isin"
  | "cusip"
  | "ticker"
  | "security_id"
  | "name_fallback";

export type MatchConfidence = "high" | "medium" | "low";

export type NormalizedHoldingRow = {
  normalizedHoldingId: string;
  sourceHoldingId: string;
  source: InvestmentSource;
  sourceItemId: string | null;
  sourceAccountId: string;
  accountId: string;
  institutionName: string | null;
  accountName: string | null;
  accountMask: string | null;
  accountType: string | null;
  accountSubtype: string | null;
  accountClassification: "retirement" | "taxable" | "unknown";
  accountClassificationSource: "inferred" | "manual";
  securityId: string;
  sourceSecurityId: string | null;
  ticker: string | null;
  securityName: string | null;
  cusip: string | null;
  isin: string | null;
  securityType: string | null;
  quantity: number | null;
  currentPrice: number | null;
  currentValue: number | null;
  costBasis: number | null;
  currencyCode: string | null;
  snapshotAt: string;
  canonicalSecurityKey: string;
  canonicalSecurityLabel: string;
  canonicalMatchMethod: CanonicalMatchMethod;
  canonicalMatchConfidence: MatchConfidence;
  overlapAcrossSources: boolean;
  overlapAcrossAccounts: boolean;
  potentialDuplicateExposure: boolean;
  normalizedAt: string;
};

export type NormalizedHoldingsState = {
  version: number;
  generatedAt: string | null;
  rowCount: number;
  rows: NormalizedHoldingRow[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function confidenceForMethod(method: CanonicalMatchMethod): MatchConfidence {
  if (method === "isin" || method === "cusip") return "high";
  if (method === "ticker") return "medium";
  return "low";
}

function canonicalFromSecurity(
  security: Security | undefined,
): {
  key: string;
  label: string;
  method: CanonicalMatchMethod;
  confidence: MatchConfidence;
} {
  const ticker = security?.ticker ? normalizeToken(security.ticker) : "";
  const isin = security?.isin ? normalizeToken(security.isin) : "";
  const cusip = security?.cusip ? normalizeToken(security.cusip) : "";
  const sourceSecurityId = security?.sourceSecurityId
    ? normalizeToken(security.sourceSecurityId)
    : "";
  const name = security?.name ? normalizeText(security.name) : "";

  if (isin) {
    return {
      key: `isin:${isin}`,
      label: security?.ticker ?? security?.name ?? "Unknown security",
      method: "isin",
      confidence: confidenceForMethod("isin"),
    };
  }
  if (cusip) {
    return {
      key: `cusip:${cusip}`,
      label: security?.ticker ?? security?.name ?? "Unknown security",
      method: "cusip",
      confidence: confidenceForMethod("cusip"),
    };
  }
  if (ticker) {
    return {
      key: `ticker:${ticker}`,
      label: security?.ticker ?? security?.name ?? "Unknown security",
      method: "ticker",
      confidence: confidenceForMethod("ticker"),
    };
  }
  if (sourceSecurityId) {
    return {
      key: `security-id:${sourceSecurityId}`,
      label: security?.name ?? "Unknown security",
      method: "security_id",
      confidence: confidenceForMethod("security_id"),
    };
  }
  return {
    key: `name:${name || "unknown"}`,
    label: security?.name ?? "Unknown security",
    method: "name_fallback",
    confidence: confidenceForMethod("name_fallback"),
  };
}

function emptyState(): NormalizedHoldingsState {
  return {
    version: NORMALIZED_VERSION,
    generatedAt: null,
    rowCount: 0,
    rows: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRow(value: unknown): NormalizedHoldingRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.normalizedHoldingId !== "string") return null;
  if (value.source !== "csv_upload" && value.source !== "plaid") return null;
  if (typeof value.sourceHoldingId !== "string") return null;
  if (typeof value.sourceAccountId !== "string") return null;
  if (typeof value.accountId !== "string") return null;
  if (typeof value.securityId !== "string") return null;
  if (
    value.canonicalMatchMethod !== "isin" &&
    value.canonicalMatchMethod !== "cusip" &&
    value.canonicalMatchMethod !== "ticker" &&
    value.canonicalMatchMethod !== "security_id" &&
    value.canonicalMatchMethod !== "name_fallback"
  ) {
    return null;
  }
  if (
    value.canonicalMatchConfidence !== "high" &&
    value.canonicalMatchConfidence !== "medium" &&
    value.canonicalMatchConfidence !== "low"
  ) {
    return null;
  }

  return {
    normalizedHoldingId: value.normalizedHoldingId,
    sourceHoldingId: value.sourceHoldingId,
    source: value.source,
    sourceItemId: toStringOrNull(value.sourceItemId),
    sourceAccountId: value.sourceAccountId,
    accountId: value.accountId,
    institutionName: toStringOrNull(value.institutionName),
    accountName: toStringOrNull(value.accountName),
    accountMask: toStringOrNull(value.accountMask),
    accountType: toStringOrNull(value.accountType),
    accountSubtype: toStringOrNull(value.accountSubtype),
    accountClassification:
      value.accountClassification === "retirement" ||
      value.accountClassification === "taxable" ||
      value.accountClassification === "unknown"
        ? value.accountClassification
        : "unknown",
    accountClassificationSource:
      value.accountClassificationSource === "manual" ? "manual" : "inferred",
    securityId: value.securityId,
    sourceSecurityId: toStringOrNull(value.sourceSecurityId),
    ticker: toStringOrNull(value.ticker),
    securityName: toStringOrNull(value.securityName),
    cusip: toStringOrNull(value.cusip),
    isin: toStringOrNull(value.isin),
    securityType: toStringOrNull(value.securityType),
    quantity: toNumberOrNull(value.quantity),
    currentPrice: toNumberOrNull(value.currentPrice),
    currentValue: toNumberOrNull(value.currentValue),
    costBasis: toNumberOrNull(value.costBasis),
    currencyCode: toStringOrNull(value.currencyCode),
    snapshotAt: typeof value.snapshotAt === "string" ? value.snapshotAt : nowIso(),
    canonicalSecurityKey:
      typeof value.canonicalSecurityKey === "string"
        ? value.canonicalSecurityKey
        : "name:unknown",
    canonicalSecurityLabel:
      typeof value.canonicalSecurityLabel === "string"
        ? value.canonicalSecurityLabel
        : "Unknown security",
    canonicalMatchMethod: value.canonicalMatchMethod,
    canonicalMatchConfidence: value.canonicalMatchConfidence,
    overlapAcrossSources: Boolean(value.overlapAcrossSources),
    overlapAcrossAccounts: Boolean(value.overlapAcrossAccounts),
    potentialDuplicateExposure: Boolean(value.potentialDuplicateExposure),
    normalizedAt: typeof value.normalizedAt === "string" ? value.normalizedAt : nowIso(),
  };
}

function normalizeState(value: unknown): NormalizedHoldingsState {
  if (!isRecord(value)) return emptyState();
  const rows = Array.isArray(value.rows)
    ? value.rows
      .map((row) => normalizeRow(row))
      .filter((row): row is NormalizedHoldingRow => row !== null)
    : [];

  return {
    version: NORMALIZED_VERSION,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : null,
    rowCount: rows.length,
    rows,
  };
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function setDiagnostics(
  status: NormalizationReadStatus,
  details: string,
  backupPath: string | null = null,
): void {
  diagnostics = {
    status,
    details,
    backupPath,
    lastReadAt: nowIso(),
  };
}

async function backupCorrupt(raw: string): Promise<string> {
  await ensureDataDir();
  const timestamp = nowIso().replace(/[:.]/g, "-");
  const backupPath = path.join(DATA_DIR, `${CORRUPT_BACKUP_PREFIX}-${timestamp}.json`);
  try {
    await rename(NORMALIZED_PATH, backupPath);
  } catch {
    await writeFile(backupPath, raw, "utf8");
  }
  return backupPath;
}

async function readState(): Promise<NormalizedHoldingsState> {
  try {
    const raw = await readFile(NORMALIZED_PATH, "utf8");
    try {
      const parsed = normalizeState(JSON.parse(raw));
      setDiagnostics("ok", "Normalized holdings store loaded.");
      return parsed;
    } catch {
      const backupPath = await backupCorrupt(raw);
      setDiagnostics(
        "recovered_from_corruption",
        `Normalized holdings store was invalid JSON and was quarantined to ${backupPath}.`,
        backupPath,
      );
      return emptyState();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      setDiagnostics(
        "missing_initialized_empty",
        "Normalized holdings store not found; using an empty in-memory state.",
      );
      return emptyState();
    }
    throw error;
  }
}

async function writeState(state: NormalizedHoldingsState): Promise<void> {
  await ensureDataDir();
  await writeFile(
    NORMALIZED_PATH,
    JSON.stringify(
      {
        ...state,
        version: NORMALIZED_VERSION,
        rowCount: state.rows.length,
      },
      null,
      2,
    ),
  );
}

function buildRowsFromStore(store: InvestmentStore): NormalizedHoldingRow[] {
  const normalizedAt = nowIso();
  const accountsById = new Map<string, InvestmentAccount>(
    store.accounts.map((account) => [account.id, account]),
  );
  const securitiesById = new Map<string, Security>(
    store.securities.map((security) => [security.id, security]),
  );

  const rows = store.holdings.map((holding: Holding) => {
    const account = accountsById.get(holding.accountId);
    const security = securitiesById.get(holding.securityId);
    const canonical = canonicalFromSecurity(security);

    return {
      normalizedHoldingId: `norm:${holding.id}`,
      sourceHoldingId: holding.id,
      source: holding.source,
      sourceItemId: holding.sourceItemId,
      sourceAccountId: account?.sourceAccountId ?? holding.accountId,
      accountId: holding.accountId,
      institutionName: account?.institutionName ?? null,
      accountName: account?.accountName ?? null,
      accountMask: account?.accountMask ?? null,
      accountType: account?.type ?? null,
      accountSubtype: account?.subtype ?? null,
      accountClassification: account?.classification ?? "unknown",
      accountClassificationSource: account?.classificationSource ?? "inferred",
      securityId: holding.securityId,
      sourceSecurityId: security?.sourceSecurityId ?? null,
      ticker: security?.ticker ?? null,
      securityName: security?.name ?? null,
      cusip: security?.cusip ?? null,
      isin: security?.isin ?? null,
      securityType: security?.type ?? null,
      quantity: holding.quantity,
      currentPrice: holding.institutionPrice ?? security?.closePrice ?? null,
      currentValue: holding.institutionValue,
      costBasis: holding.costBasis,
      currencyCode:
        holding.isoCurrencyCode ??
        holding.unofficialCurrencyCode ??
        security?.isoCurrencyCode ??
        security?.unofficialCurrencyCode ??
        null,
      snapshotAt: holding.snapshotAt,
      canonicalSecurityKey: canonical.key,
      canonicalSecurityLabel: canonical.label,
      canonicalMatchMethod: canonical.method,
      canonicalMatchConfidence: canonical.confidence,
      overlapAcrossSources: false,
      overlapAcrossAccounts: false,
      potentialDuplicateExposure: false,
      normalizedAt,
    } satisfies NormalizedHoldingRow;
  });

  const rowsByCanonicalKey = new Map<string, NormalizedHoldingRow[]>();
  for (const row of rows) {
    const group = rowsByCanonicalKey.get(row.canonicalSecurityKey) ?? [];
    group.push(row);
    rowsByCanonicalKey.set(row.canonicalSecurityKey, group);
  }

  for (const group of rowsByCanonicalKey.values()) {
    if (group.length <= 1) continue;

    const sourceSet = new Set(group.map((row) => row.source));
    const accountSet = new Set(group.map((row) => row.accountId));
    const overlapAcrossSources = sourceSet.size > 1;
    const overlapAcrossAccounts = accountSet.size > 1;
    const potentialDuplicateExposure = overlapAcrossSources || overlapAcrossAccounts;

    for (const row of group) {
      row.overlapAcrossSources = overlapAcrossSources;
      row.overlapAcrossAccounts = overlapAcrossAccounts;
      row.potentialDuplicateExposure = potentialDuplicateExposure;
    }
  }

  return rows.sort((left, right) => {
    const byValue = (right.currentValue ?? 0) - (left.currentValue ?? 0);
    if (byValue !== 0) return byValue;
    return left.normalizedHoldingId.localeCompare(right.normalizedHoldingId);
  });
}

export async function regenerateNormalizedHoldings(): Promise<{
  generatedAt: string;
  rowCount: number;
  overlapCount: number;
  sourceBreakdown: Array<{ source: InvestmentSource; rowCount: number }>;
}> {
  const store = await readInvestmentStore();
  const rows = buildRowsFromStore(store);
  const generatedAt = nowIso();

  const state: NormalizedHoldingsState = {
    version: NORMALIZED_VERSION,
    generatedAt,
    rowCount: rows.length,
    rows,
  };
  await writeState(state);

  const overlapCount = rows.filter((row) => row.potentialDuplicateExposure).length;
  const sourceCounts = new Map<InvestmentSource, number>();
  for (const row of rows) {
    sourceCounts.set(row.source, (sourceCounts.get(row.source) ?? 0) + 1);
  }

  return {
    generatedAt,
    rowCount: rows.length,
    overlapCount,
    sourceBreakdown: [...sourceCounts.entries()].map(([source, rowCount]) => ({
      source,
      rowCount,
    })),
  };
}

export async function getNormalizedHoldings(
  options: { regenerateIfMissing?: boolean } = {},
): Promise<NormalizedHoldingsState> {
  const state = await readState();
  if (
    options.regenerateIfMissing &&
    state.rows.length === 0 &&
    state.generatedAt === null
  ) {
    await regenerateNormalizedHoldings();
    return readState();
  }
  return state;
}

export function getNormalizationStoreHealth(): {
  path: string;
  status: NormalizationReadStatus;
  lastReadAt: string;
  details: string;
  backupPath: string | null;
} {
  return {
    path: NORMALIZED_PATH,
    status: diagnostics.status,
    lastReadAt: diagnostics.lastReadAt,
    details: diagnostics.details,
    backupPath: diagnostics.backupPath,
  };
}
