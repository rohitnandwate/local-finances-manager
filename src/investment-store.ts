import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(".data");
const STORE_PATH = path.join(DATA_DIR, "investment-data.json");
const STORE_VERSION = 1;
const CORRUPT_BACKUP_PREFIX = "investment-data.corrupt";

export type InvestmentSource = "csv_upload" | "plaid";
export type InvestmentAccountClassification = "retirement" | "taxable" | "unknown";

type InvestmentStoreReadStatus =
  | "ok"
  | "missing_initialized_empty"
  | "recovered_from_corruption";

type InvestmentStoreDiagnostics = {
  status: InvestmentStoreReadStatus;
  lastReadAt: string;
  details: string;
  backupPath: string | null;
};

let diagnostics: InvestmentStoreDiagnostics = {
  status: "missing_initialized_empty",
  lastReadAt: new Date(0).toISOString(),
  details: "Store has not been read yet.",
  backupPath: null,
};

export type InvestmentAccount = {
  id: string;
  source: InvestmentSource;
  sourceAccountId: string;
  sourceItemId: string | null;
  institutionName: string | null;
  accountName: string | null;
  accountMask: string | null;
  subtype: string | null;
  type: string | null;
  classification: InvestmentAccountClassification;
  classificationSource: "inferred" | "manual";
  createdAt: string;
  updatedAt: string;
};

export type Security = {
  id: string;
  sourceSecurityId: string | null;
  ticker: string | null;
  name: string | null;
  cusip: string | null;
  isin: string | null;
  type: string | null;
  closePrice: number | null;
  closePriceAsOf: string | null;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Holding = {
  id: string;
  source: InvestmentSource;
  sourceHoldingId: string | null;
  sourceItemId: string | null;
  accountId: string;
  securityId: string;
  quantity: number | null;
  institutionValue: number | null;
  institutionPrice: number | null;
  costBasis: number | null;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
  snapshotAt: string;
};

export type InvestmentTransaction = {
  id: string;
  source: InvestmentSource;
  sourceTransactionId: string;
  sourceItemId: string | null;
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
  snapshotAt: string;
};

export type InvestmentStore = {
  version: number;
  accounts: InvestmentAccount[];
  securities: Security[];
  holdings: Holding[];
  transactions: InvestmentTransaction[];
};

export type CsvHoldingInput = {
  institutionName: string | null;
  accountName: string;
  accountMask: string | null;
  symbol: string | null;
  securityName: string | null;
  quantity: number | null;
  currentPrice: number | null;
  currentValue: number | null;
  costBasisPerShare: number | null;
  totalCostBasis: number | null;
  isoCurrencyCode: string | null;
};

export type PlaidSnapshotInput = {
  itemId: string;
  institutionName: string | null;
  accounts: Array<{
    id: string;
    name: string | null;
    mask: string | null;
    subtype: string | null;
    type: string | null;
  }>;
  securities: Array<{
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
  }>;
  holdings: Array<{
    id: string | null;
    accountId: string | null;
    securityId: string | null;
    quantity: number | null;
    institutionValue: number | null;
    institutionPrice: number | null;
    costBasis: number | null;
    isoCurrencyCode: string | null;
    unofficialCurrencyCode: string | null;
  }>;
  transactions: Array<{
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
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toSnapshotDate(value: string): string {
  return value.slice(0, 10);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function slug(value: string): string {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function inferAccountClassification(input: {
  accountName: string | null;
  type: string | null;
  subtype: string | null;
}): InvestmentAccountClassification {
  const text = [input.accountName, input.type, input.subtype]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (/ira|roth|401k|403b|457|hsa|retire|pension|workplace|target date/.test(text)) {
    return "retirement";
  }
  if (/brokerage|taxable|individual|joint|cash management/.test(text)) {
    return "taxable";
  }
  return "unknown";
}

function canonicalSecurityKey(input: {
  isin: string | null;
  cusip: string | null;
  ticker: string | null;
  name: string | null;
  sourceSecurityId: string | null;
}): string {
  if (input.isin) return `isin:${normalizeKey(input.isin)}`;
  if (input.cusip) return `cusip:${normalizeKey(input.cusip)}`;
  if (input.ticker) {
    const namePart = input.name ? normalizeKey(input.name) : "unknown";
    return `ticker:${normalizeKey(input.ticker)}:${namePart}`;
  }
  if (input.sourceSecurityId) return `source:${normalizeKey(input.sourceSecurityId)}`;
  if (input.name) return `name:${normalizeKey(input.name)}`;
  return "unknown:unidentified";
}

function emptyStore(): InvestmentStore {
  return {
    version: STORE_VERSION,
    accounts: [],
    securities: [],
    holdings: [],
    transactions: [],
  };
}

function normalizeAccount(value: unknown): InvestmentAccount | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  if (value.source !== "csv_upload" && value.source !== "plaid") return null;
  if (typeof value.sourceAccountId !== "string") return null;

  const createdAt = typeof value.createdAt === "string" ? value.createdAt : nowIso();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;

  return {
    id: value.id,
    source: value.source,
    sourceAccountId: value.sourceAccountId,
    sourceItemId: toStringOrNull(value.sourceItemId),
    institutionName: toStringOrNull(value.institutionName),
    accountName: toStringOrNull(value.accountName),
    accountMask: toStringOrNull(value.accountMask),
    subtype: toStringOrNull(value.subtype),
    type: toStringOrNull(value.type),
    classification:
      value.classification === "retirement" ||
      value.classification === "taxable" ||
      value.classification === "unknown"
        ? value.classification
        : "unknown",
    classificationSource: value.classificationSource === "manual" ? "manual" : "inferred",
    createdAt,
    updatedAt,
  };
}

function normalizeSecurity(value: unknown): Security | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : nowIso();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  return {
    id: value.id,
    sourceSecurityId: toStringOrNull(value.sourceSecurityId),
    ticker: toStringOrNull(value.ticker),
    name: toStringOrNull(value.name),
    cusip: toStringOrNull(value.cusip),
    isin: toStringOrNull(value.isin),
    type: toStringOrNull(value.type),
    closePrice: toNumberOrNull(value.closePrice),
    closePriceAsOf: toStringOrNull(value.closePriceAsOf),
    isoCurrencyCode: toStringOrNull(value.isoCurrencyCode),
    unofficialCurrencyCode: toStringOrNull(value.unofficialCurrencyCode),
    createdAt,
    updatedAt,
  };
}

function normalizeHolding(value: unknown): Holding | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (value.source !== "csv_upload" && value.source !== "plaid") return null;
  if (typeof value.accountId !== "string" || typeof value.securityId !== "string") return null;

  return {
    id: value.id,
    source: value.source,
    sourceHoldingId: toStringOrNull(value.sourceHoldingId),
    sourceItemId: toStringOrNull(value.sourceItemId),
    accountId: value.accountId,
    securityId: value.securityId,
    quantity: toNumberOrNull(value.quantity),
    institutionValue: toNumberOrNull(value.institutionValue),
    institutionPrice: toNumberOrNull(value.institutionPrice),
    costBasis: toNumberOrNull(value.costBasis),
    isoCurrencyCode: toStringOrNull(value.isoCurrencyCode),
    unofficialCurrencyCode: toStringOrNull(value.unofficialCurrencyCode),
    snapshotAt: typeof value.snapshotAt === "string" ? toSnapshotDate(value.snapshotAt) : toSnapshotDate(nowIso()),
  };
}

function normalizeTransaction(value: unknown): InvestmentTransaction | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (value.source !== "csv_upload" && value.source !== "plaid") return null;
  if (typeof value.sourceTransactionId !== "string") return null;

  return {
    id: value.id,
    source: value.source,
    sourceTransactionId: value.sourceTransactionId,
    sourceItemId: toStringOrNull(value.sourceItemId),
    accountId: toStringOrNull(value.accountId),
    securityId: toStringOrNull(value.securityId),
    type: toStringOrNull(value.type),
    subtype: toStringOrNull(value.subtype),
    amount: toNumberOrNull(value.amount),
    quantity: toNumberOrNull(value.quantity),
    price: toNumberOrNull(value.price),
    fees: toNumberOrNull(value.fees),
    date: toStringOrNull(value.date),
    isoCurrencyCode: toStringOrNull(value.isoCurrencyCode),
    unofficialCurrencyCode: toStringOrNull(value.unofficialCurrencyCode),
    name: toStringOrNull(value.name),
    snapshotAt: typeof value.snapshotAt === "string" ? toSnapshotDate(value.snapshotAt) : toSnapshotDate(nowIso()),
  };
}

function normalizeStore(value: unknown): InvestmentStore {
  if (!isRecord(value)) return emptyStore();

  const accounts = Array.isArray(value.accounts)
    ? value.accounts
      .map((entry) => normalizeAccount(entry))
      .filter((entry): entry is InvestmentAccount => entry !== null)
    : [];

  const securities = Array.isArray(value.securities)
    ? value.securities
      .map((entry) => normalizeSecurity(entry))
      .filter((entry): entry is Security => entry !== null)
    : [];

  const holdings = Array.isArray(value.holdings)
    ? value.holdings
      .map((entry) => normalizeHolding(entry))
      .filter((entry): entry is Holding => entry !== null)
    : [];

  const transactions = Array.isArray(value.transactions)
    ? value.transactions
      .map((entry) => normalizeTransaction(entry))
      .filter((entry): entry is InvestmentTransaction => entry !== null)
    : [];

  return {
    version: STORE_VERSION,
    accounts,
    securities,
    holdings,
    transactions,
  };
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function setDiagnostics(
  status: InvestmentStoreReadStatus,
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

async function backupCorruptStore(raw: string): Promise<string> {
  await ensureDataDir();
  const timestamp = nowIso().replace(/[:.]/g, "-");
  const backupPath = path.join(DATA_DIR, `${CORRUPT_BACKUP_PREFIX}-${timestamp}.json`);
  try {
    await rename(STORE_PATH, backupPath);
  } catch {
    await writeFile(backupPath, raw, "utf8");
  }
  return backupPath;
}

async function readState(): Promise<InvestmentStore> {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    try {
      const state = normalizeStore(JSON.parse(raw));
      setDiagnostics("ok", "Investment store loaded.");
      return state;
    } catch {
      const backupPath = await backupCorruptStore(raw);
      setDiagnostics(
        "recovered_from_corruption",
        `Investment store was invalid JSON and was quarantined to ${backupPath}.`,
        backupPath,
      );
      return emptyStore();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      setDiagnostics(
        "missing_initialized_empty",
        "Investment store not found; using an empty in-memory state.",
      );
      return emptyStore();
    }
    throw error;
  }
}

async function writeState(state: InvestmentStore): Promise<void> {
  await ensureDataDir();
  await writeFile(
    STORE_PATH,
    JSON.stringify(
      {
        ...state,
        version: STORE_VERSION,
      },
      null,
      2,
    ),
  );
}

function getOrCreateSecurityId(
  state: InvestmentStore,
  input: {
    sourceSecurityId: string | null;
    ticker: string | null;
    name: string | null;
    cusip: string | null;
    isin: string | null;
    type: string | null;
    closePrice: number | null;
    closePriceAsOf: string | null;
    isoCurrencyCode: string | null;
    unofficialCurrencyCode: string | null;
  },
): string {
  const key = canonicalSecurityKey(input);
  const existing = state.securities.find((security) => security.id === key);
  const timestamp = nowIso();

  if (existing) {
    existing.sourceSecurityId = input.sourceSecurityId ?? existing.sourceSecurityId;
    existing.ticker = input.ticker ?? existing.ticker;
    existing.name = input.name ?? existing.name;
    existing.cusip = input.cusip ?? existing.cusip;
    existing.isin = input.isin ?? existing.isin;
    existing.type = input.type ?? existing.type;
    existing.closePrice = input.closePrice ?? existing.closePrice;
    existing.closePriceAsOf = input.closePriceAsOf ?? existing.closePriceAsOf;
    existing.isoCurrencyCode = input.isoCurrencyCode ?? existing.isoCurrencyCode;
    existing.unofficialCurrencyCode =
      input.unofficialCurrencyCode ?? existing.unofficialCurrencyCode;
    existing.updatedAt = timestamp;
    return existing.id;
  }

  state.securities.push({
    id: key,
    sourceSecurityId: input.sourceSecurityId,
    ticker: input.ticker,
    name: input.name,
    cusip: input.cusip,
    isin: input.isin,
    type: input.type,
    closePrice: input.closePrice,
    closePriceAsOf: input.closePriceAsOf,
    isoCurrencyCode: input.isoCurrencyCode,
    unofficialCurrencyCode: input.unofficialCurrencyCode,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return key;
}

function getOrCreateCsvAccount(
  state: InvestmentStore,
  institutionName: string | null,
  accountName: string,
  accountMask: string | null,
): InvestmentAccount {
  const sourceAccountId = `csv:${slug(`${institutionName ?? "manual"}:${accountName}`)}`;
  const existing = state.accounts.find(
    (account) =>
      account.source === "csv_upload" && account.sourceAccountId === sourceAccountId,
  );
  const timestamp = nowIso();

  if (existing) {
    existing.institutionName = institutionName ?? existing.institutionName;
    existing.accountName = accountName;
    existing.accountMask = accountMask ?? existing.accountMask;
    if (existing.classificationSource !== "manual") {
      existing.classification = inferAccountClassification({
        accountName,
        type: existing.type,
        subtype: existing.subtype,
      });
      existing.classificationSource = "inferred";
    }
    existing.updatedAt = timestamp;
    return existing;
  }

  const account: InvestmentAccount = {
    id: `acc:${sourceAccountId}`,
    source: "csv_upload",
    sourceAccountId,
    sourceItemId: null,
    institutionName,
    accountName,
    accountMask,
    subtype: null,
    type: "investment",
    classification: inferAccountClassification({
      accountName,
      type: "investment",
      subtype: null,
    }),
    classificationSource: "inferred",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.accounts.push(account);
  return account;
}

export async function readInvestmentStore(): Promise<InvestmentStore> {
  return readState();
}

export async function replaceCsvHoldingsSnapshot(
  rows: CsvHoldingInput[],
  snapshotAt: string = nowIso(),
): Promise<{
  accountCount: number;
  holdingCount: number;
  securityCount: number;
}> {
  const state = await readState();
  const snapshotDate = toSnapshotDate(snapshotAt);
  const touchedAccountIds = new Set<string>();

  for (const row of rows) {
    const account = getOrCreateCsvAccount(
      state,
      row.institutionName,
      row.accountName,
      row.accountMask,
    );
    touchedAccountIds.add(account.id);
  }

  if (touchedAccountIds.size > 0) {
    state.holdings = state.holdings.filter(
      (holding) =>
        !(
          holding.source === "csv_upload" &&
          touchedAccountIds.has(holding.accountId) &&
          toSnapshotDate(holding.snapshotAt) === snapshotDate
        ),
    );
  }

  for (const row of rows) {
    const account = getOrCreateCsvAccount(
      state,
      row.institutionName,
      row.accountName,
      row.accountMask,
    );
    const securityId = getOrCreateSecurityId(state, {
      sourceSecurityId: row.symbol,
      ticker: row.symbol,
      name: row.securityName,
      cusip: null,
      isin: null,
      type: null,
      closePrice: row.currentPrice,
      closePriceAsOf: snapshotDate,
      isoCurrencyCode: row.isoCurrencyCode,
      unofficialCurrencyCode: null,
    });
    const costBasis =
      row.totalCostBasis ??
      (row.costBasisPerShare !== null && row.quantity !== null
        ? row.costBasisPerShare * row.quantity
        : null);
    state.holdings.push({
      id: `hold:csv:${snapshotDate}:${account.sourceAccountId}:${securityId}`,
      source: "csv_upload",
      sourceHoldingId: null,
      sourceItemId: null,
      accountId: account.id,
      securityId,
      quantity: row.quantity,
      institutionValue: row.currentValue,
      institutionPrice: row.currentPrice,
      costBasis,
      isoCurrencyCode: row.isoCurrencyCode,
      unofficialCurrencyCode: null,
      snapshotAt: snapshotDate,
    });
  }

  await writeState(state);

  const accountCount = state.accounts.filter((account) => account.source === "csv_upload")
    .length;
  const holdingCount = state.holdings.filter((holding) => holding.source === "csv_upload")
    .length;
  return {
    accountCount,
    holdingCount,
    securityCount: state.securities.length,
  };
}

export async function replacePlaidItemSnapshot(
  snapshot: PlaidSnapshotInput,
  snapshotAt: string = nowIso(),
): Promise<{
  accountCount: number;
  holdingCount: number;
  transactionCount: number;
}> {
  const state = await readState();
  const snapshotDate = toSnapshotDate(snapshotAt);
  const timestamp = nowIso();
  const sourceItemId = snapshot.itemId;
  const removedAccountIds = new Set(
    state.accounts
      .filter((account) => account.source === "plaid" && account.sourceItemId === sourceItemId)
      .map((account) => account.id),
  );

  state.accounts = state.accounts.filter(
    (account) => !(account.source === "plaid" && account.sourceItemId === sourceItemId),
  );
  if (removedAccountIds.size > 0) {
    state.holdings = state.holdings.filter(
      (holding) =>
        !(
          removedAccountIds.has(holding.accountId) &&
          toSnapshotDate(holding.snapshotAt) === snapshotDate
        ),
    );
  } else {
    state.holdings = state.holdings.filter(
      (holding) =>
        !(
          holding.source === "plaid" &&
          holding.sourceItemId === sourceItemId &&
          toSnapshotDate(holding.snapshotAt) === snapshotDate
        ),
    );
  }
  state.transactions = state.transactions.filter(
    (transaction) =>
      !(
        transaction.source === "plaid" &&
        transaction.sourceItemId === sourceItemId &&
        toSnapshotDate(transaction.snapshotAt) === snapshotDate
      ),
  );

  const accountIdMap = new Map<string, string>();
  for (const account of snapshot.accounts) {
    const sourceAccountId = account.id;
    const id = `acc:plaid:${sourceItemId}:${sourceAccountId}`;
    state.accounts.push({
      id,
      source: "plaid",
      sourceAccountId,
      sourceItemId,
      institutionName: snapshot.institutionName,
      accountName: account.name,
      accountMask: account.mask,
      subtype: account.subtype,
      type: account.type,
      classification: inferAccountClassification({
        accountName: account.name,
        type: account.type,
        subtype: account.subtype,
      }),
      classificationSource: "inferred",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    accountIdMap.set(sourceAccountId, id);
  }

  const securityIdMap = new Map<string, string>();
  for (const security of snapshot.securities) {
    const securityId = getOrCreateSecurityId(state, {
      sourceSecurityId: security.id,
      ticker: security.ticker,
      name: security.name,
      cusip: security.cusip,
      isin: security.isin,
      type: security.type,
      closePrice: security.closePrice,
      closePriceAsOf: security.closePriceAsOf,
      isoCurrencyCode: security.isoCurrencyCode,
      unofficialCurrencyCode: security.unofficialCurrencyCode,
    });
    if (security.id) {
      securityIdMap.set(security.id, securityId);
    }
  }

  for (const holding of snapshot.holdings) {
    if (!holding.accountId) continue;
    const accountId = accountIdMap.get(holding.accountId);
    if (!accountId) continue;
    const securityIdFromMap = holding.securityId
      ? securityIdMap.get(holding.securityId) ?? null
      : null;
    const securityId = securityIdFromMap ?? getOrCreateSecurityId(state, {
      sourceSecurityId: holding.securityId,
      ticker: null,
      name: null,
      cusip: null,
      isin: null,
      type: null,
      closePrice: holding.institutionPrice,
      closePriceAsOf: snapshotDate,
      isoCurrencyCode: holding.isoCurrencyCode,
      unofficialCurrencyCode: holding.unofficialCurrencyCode,
    });

    state.holdings.push({
      id: `hold:plaid:${snapshotDate}:${sourceItemId}:${holding.id ?? `${holding.accountId}:${holding.securityId ?? "unknown"}`}`,
      source: "plaid",
      sourceHoldingId: holding.id,
      sourceItemId,
      accountId,
      securityId,
      quantity: holding.quantity,
      institutionValue: holding.institutionValue,
      institutionPrice: holding.institutionPrice,
      costBasis: holding.costBasis,
      isoCurrencyCode: holding.isoCurrencyCode,
      unofficialCurrencyCode: holding.unofficialCurrencyCode,
      snapshotAt: snapshotDate,
    });
  }

  for (const transaction of snapshot.transactions) {
    const accountId = transaction.accountId
      ? accountIdMap.get(transaction.accountId) ?? null
      : null;
    const securityId = transaction.securityId
      ? securityIdMap.get(transaction.securityId) ?? null
      : null;
    state.transactions.push({
      id: `txn:plaid:${snapshotDate}:${sourceItemId}:${transaction.id}`,
      source: "plaid",
      sourceTransactionId: transaction.id,
      sourceItemId,
      accountId,
      securityId,
      type: transaction.type,
      subtype: transaction.subtype,
      amount: transaction.amount,
      quantity: transaction.quantity,
      price: transaction.price,
      fees: transaction.fees,
      date: transaction.date,
      isoCurrencyCode: transaction.isoCurrencyCode,
      unofficialCurrencyCode: transaction.unofficialCurrencyCode,
      name: transaction.name,
      snapshotAt: snapshotDate,
    });
  }

  await writeState(state);

  return {
    accountCount: state.accounts.filter((account) => account.source === "plaid").length,
    holdingCount: state.holdings.filter((holding) => holding.source === "plaid").length,
    transactionCount: state.transactions.filter((transaction) => transaction.source === "plaid")
      .length,
  };
}

export async function setInvestmentAccountClassification(
  accountId: string,
  classification: InvestmentAccountClassification,
): Promise<InvestmentAccount | null> {
  const state = await readState();
  const account = state.accounts.find((entry) => entry.id === accountId);
  if (!account) {
    return null;
  }
  account.classification = classification;
  account.classificationSource = "manual";
  account.updatedAt = nowIso();
  await writeState(state);
  return account;
}

export function getInvestmentStoreHealth(): {
  path: string;
  status: InvestmentStoreReadStatus;
  lastReadAt: string;
  details: string;
  backupPath: string | null;
} {
  return {
    path: STORE_PATH,
    status: diagnostics.status,
    lastReadAt: diagnostics.lastReadAt,
    details: diagnostics.details,
    backupPath: diagnostics.backupPath,
  };
}
