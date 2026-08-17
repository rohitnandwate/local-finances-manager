import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { deleteToken, getToken, hasToken, storeToken } from "./keychain.js";

const DATA_DIR = path.resolve(".data");
const SESSION_PATH = path.join(DATA_DIR, "plaid-session.json");
const STORAGE_VERSION = 5;
const CORRUPT_BACKUP_PREFIX = "plaid-session.corrupt";

type StorageReadStatus =
  | "ok"
  | "missing_initialized_empty"
  | "recovered_from_corruption";

type StorageDiagnostics = {
  status: StorageReadStatus;
  lastReadAt: string;
  details: string;
  backupPath: string | null;
};

let storageDiagnostics: StorageDiagnostics = {
  status: "missing_initialized_empty",
  lastReadAt: new Date(0).toISOString(),
  details: "Store has not been read yet.",
  backupPath: null,
};

export type StoredCounterparty = {
  name: string | null;
  type: string | null;
  logoUrl: string | null;
  website: string | null;
  entityId: string | null;
  confidenceLevel: string | null;
};

export type StoredLinkedAccount = {
  id: string;
  name: string | null;
  mask: string | null;
  subtype: string | null;
  type: string | null;
};

export type StoredAccountSnapshot = {
  id: string;
  name: string | null;
  mask: string | null;
  subtype: string | null;
  type: string | null;
  available: number | null;
  current: number | null;
  isoCurrencyCode: string | null;
};

export type StoredTransactionSnapshot = {
  id: string;
  accountId: string | null;
  name: string | null;
  merchantName: string | null;
  amount: number | null;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
  date: string | null;
  authorizedDate: string | null;
  pending: boolean;
  personalFinanceCategoryPrimary: string | null;
  personalFinanceCategoryDetailed: string | null;
  personalFinanceCategoryConfidence: string | null;
  counterparties: StoredCounterparty[];
  paymentChannel: string | null;
  merchantEntityId: string | null;
  logoUrl: string | null;
  website: string | null;
  locationAddress: string | null;
  locationCity: string | null;
  locationRegion: string | null;
  locationPostalCode: string | null;
  locationCountry: string | null;
  locationLat: number | null;
  locationLon: number | null;
  locationStoreNumber: string | null;
};

export type StoredSession = {
  provider: "plaid";
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  linkedAccounts: StoredLinkedAccount[];
  accounts: StoredAccountSnapshot[];
  transactions: StoredTransactionSnapshot[];
  cursor: string | null;
  createdAt: string;
  lastRefreshAt: string | null;
};

type StoredSessionState = {
  version: number;
  items: StoredSession[];
};

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function setStorageDiagnostics(
  status: StorageReadStatus,
  details: string,
  backupPath: string | null = null,
): void {
  storageDiagnostics = {
    status,
    details,
    backupPath,
    lastReadAt: new Date().toISOString(),
  };
}

async function backupCorruptSessionStore(raw: string): Promise<string> {
  await ensureDataDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(DATA_DIR, `${CORRUPT_BACKUP_PREFIX}-${timestamp}.json`);
  try {
    await rename(SESSION_PATH, backupPath);
  } catch {
    await writeFile(backupPath, raw, "utf8");
  }
  return backupPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeLinkedAccounts(value: unknown): StoredLinkedAccount[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
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
      } satisfies StoredLinkedAccount;
    })
    .filter((account): account is StoredLinkedAccount => account !== null);
}

function normalizeAccounts(value: unknown): StoredAccountSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
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
        available: typeof account.available === "number" ? account.available : null,
        current: typeof account.current === "number" ? account.current : null,
        isoCurrencyCode:
          typeof account.isoCurrencyCode === "string"
            ? account.isoCurrencyCode
            : null,
      } satisfies StoredAccountSnapshot;
    })
    .filter((account): account is StoredAccountSnapshot => account !== null);
}

function normalizeCounterparties(value: unknown): StoredCounterparty[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : null,
      type: typeof entry.type === "string" ? entry.type : null,
      logoUrl: typeof entry.logoUrl === "string" ? entry.logoUrl : null,
      website: typeof entry.website === "string" ? entry.website : null,
      entityId: typeof entry.entityId === "string" ? entry.entityId : null,
      confidenceLevel:
        typeof entry.confidenceLevel === "string" ? entry.confidenceLevel : null,
    }));
}

function normalizeTransactions(value: unknown): StoredTransactionSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((transaction) => {
      if (!isRecord(transaction) || typeof transaction.id !== "string") {
        return null;
      }

      return {
        id: transaction.id,
        accountId:
          typeof transaction.accountId === "string" ? transaction.accountId : null,
        name: typeof transaction.name === "string" ? transaction.name : null,
        merchantName:
          typeof transaction.merchantName === "string"
            ? transaction.merchantName
            : null,
        amount: typeof transaction.amount === "number" ? transaction.amount : null,
        isoCurrencyCode:
          typeof transaction.isoCurrencyCode === "string"
            ? transaction.isoCurrencyCode
            : null,
        unofficialCurrencyCode:
          typeof transaction.unofficialCurrencyCode === "string"
            ? transaction.unofficialCurrencyCode
            : null,
        date: typeof transaction.date === "string" ? transaction.date : null,
        authorizedDate:
          typeof transaction.authorizedDate === "string"
            ? transaction.authorizedDate
            : null,
        pending: Boolean(transaction.pending),
        personalFinanceCategoryPrimary:
          typeof transaction.personalFinanceCategoryPrimary === "string"
            ? transaction.personalFinanceCategoryPrimary
            : null,
        personalFinanceCategoryDetailed:
          typeof transaction.personalFinanceCategoryDetailed === "string"
            ? transaction.personalFinanceCategoryDetailed
            : null,
        personalFinanceCategoryConfidence:
          typeof transaction.personalFinanceCategoryConfidence === "string"
            ? transaction.personalFinanceCategoryConfidence
            : null,
        counterparties: normalizeCounterparties(transaction.counterparties),
        paymentChannel:
          typeof transaction.paymentChannel === "string"
            ? transaction.paymentChannel
            : null,
        merchantEntityId:
          typeof transaction.merchantEntityId === "string"
            ? transaction.merchantEntityId
            : null,
        logoUrl:
          typeof transaction.logoUrl === "string" ? transaction.logoUrl : null,
        website:
          typeof transaction.website === "string" ? transaction.website : null,
        locationAddress:
          typeof transaction.locationAddress === "string"
            ? transaction.locationAddress
            : null,
        locationCity:
          typeof transaction.locationCity === "string"
            ? transaction.locationCity
            : null,
        locationRegion:
          typeof transaction.locationRegion === "string"
            ? transaction.locationRegion
            : null,
        locationPostalCode:
          typeof transaction.locationPostalCode === "string"
            ? transaction.locationPostalCode
            : null,
        locationCountry:
          typeof transaction.locationCountry === "string"
            ? transaction.locationCountry
            : null,
        locationLat:
          typeof transaction.locationLat === "number"
            ? transaction.locationLat
            : null,
        locationLon:
          typeof transaction.locationLon === "number"
            ? transaction.locationLon
            : null,
        locationStoreNumber:
          typeof transaction.locationStoreNumber === "string"
            ? transaction.locationStoreNumber
            : null,
      } satisfies StoredTransactionSnapshot;
    })
    .filter(
      (transaction): transaction is StoredTransactionSnapshot => transaction !== null,
    );
}

type LegacySessionRecord = Record<string, unknown>;

function extractLegacyAccessToken(value: LegacySessionRecord): string | null {
  return typeof value.accessToken === "string" && value.accessToken.length > 0
    ? value.accessToken
    : null;
}

function normalizeLegacySession(value: unknown): StoredSession | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.provider !== "plaid" ||
    typeof value.itemId !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    provider: "plaid",
    itemId: value.itemId,
    institutionId:
      typeof value.institutionId === "string" ? value.institutionId : null,
    institutionName:
      typeof value.institutionName === "string" ? value.institutionName : null,
    linkedAccounts: normalizeLinkedAccounts(value.linkedAccounts),
    accounts: normalizeAccounts(value.accounts),
    transactions: normalizeTransactions(value.transactions),
    cursor: typeof value.cursor === "string" ? value.cursor : null,
    createdAt: value.createdAt,
    lastRefreshAt:
      typeof value.lastRefreshAt === "string" ? value.lastRefreshAt : null,
  };
}

function normalizeState(value: unknown): {
  state: StoredSessionState;
  legacyTokens: Map<string, string>;
} {
  const legacyTokens = new Map<string, string>();

  if (isRecord(value) && Array.isArray(value.items)) {
    const items: StoredSession[] = [];
    for (const item of value.items) {
      const session = normalizeLegacySession(item);
      if (!session) continue;
      items.push(session);
      if (isRecord(item)) {
        const token = extractLegacyAccessToken(item);
        if (token) {
          legacyTokens.set(session.itemId, token);
        }
      }
    }
    return {
      state: {
        version:
          typeof value.version === "number" ? value.version : STORAGE_VERSION,
        items,
      },
      legacyTokens,
    };
  }

  const legacySession = normalizeLegacySession(value);
  if (legacySession && isRecord(value)) {
    const token = extractLegacyAccessToken(value);
    if (token) {
      legacyTokens.set(legacySession.itemId, token);
    }
  }

  return {
    state: {
      version: STORAGE_VERSION,
      items: legacySession ? [legacySession] : [],
    },
    legacyTokens,
  };
}

async function migrateTokensToKeychain(
  legacyTokens: Map<string, string>,
): Promise<void> {
  for (const [itemId, token] of legacyTokens) {
    if (token.startsWith("enc:")) {
      console.warn(
        `[storage] Item ${itemId} has an encrypted token from a previous version. ` +
          `The token cannot be auto-migrated. Please re-link this account.`,
      );
      continue;
    }

    const alreadyInKeychain = await hasToken(itemId);
    if (alreadyInKeychain) {
      console.log(`[storage] Token for item ${itemId} already in Keychain, skipping`);
      continue;
    }

    try {
      await storeToken(itemId, token);
      console.log(`[storage] Migrated token for item ${itemId} to macOS Keychain`);
    } catch (error) {
      console.error(
        `[storage] Failed to migrate token for item ${itemId} to Keychain: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

let migrationPromise: Promise<void> | null = null;

async function readState(): Promise<StoredSessionState> {
  try {
    const raw = await readFile(SESSION_PATH, "utf8");
    try {
      const parsed = JSON.parse(raw);
      const { state: normalized, legacyTokens } = normalizeState(parsed);

      const needsMigration =
        (typeof parsed.version === "number" && parsed.version < STORAGE_VERSION) ||
        legacyTokens.size > 0;

      if (needsMigration && !migrationPromise) {
        migrationPromise = (async () => {
          console.log(
            `[storage] Migrating session store to v${STORAGE_VERSION} (Keychain token storage)`,
          );
          if (legacyTokens.size > 0) {
            await migrateTokensToKeychain(legacyTokens);
          }
          await writeState({ ...normalized, version: STORAGE_VERSION });
        })();
      }

      if (migrationPromise) {
        await migrationPromise;
      }

      setStorageDiagnostics("ok", "Session store loaded.");
      return normalized;
    } catch (error) {
      const backupPath = await backupCorruptSessionStore(raw);
      setStorageDiagnostics(
        "recovered_from_corruption",
        `Session store was invalid JSON and was quarantined to ${backupPath}.`,
        backupPath,
      );
      return {
        version: STORAGE_VERSION,
        items: [],
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      setStorageDiagnostics(
        "missing_initialized_empty",
        "Session store not found; using an empty in-memory state.",
      );
      return {
        version: STORAGE_VERSION,
        items: [],
      };
    }

    throw error;
  }
}

async function writeState(state: StoredSessionState): Promise<void> {
  await ensureDataDir();
  await writeFile(SESSION_PATH, JSON.stringify(state, null, 2));
}

export async function readSessions(): Promise<StoredSession[]> {
  const state = await readState();
  return state.items;
}

export async function getAccessToken(itemId: string): Promise<string> {
  return getToken(itemId);
}

export async function storeAccessToken(
  itemId: string,
  token: string,
): Promise<void> {
  await storeToken(itemId, token);
}

export async function upsertSession(session: StoredSession): Promise<void> {
  const state = await readState();
  const items = state.items.filter((item) => item.itemId !== session.itemId);
  items.push(session);

  await writeState({
    version: STORAGE_VERSION,
    items,
  });
}

export async function clearSessions(): Promise<void> {
  const state = await readState();
  for (const session of state.items) {
    await deleteToken(session.itemId);
  }
  await rm(SESSION_PATH, { force: true });
}

export function getSessionStoreHealth(): {
  path: string;
  status: StorageReadStatus;
  lastReadAt: string;
  details: string;
  backupPath: string | null;
} {
  return {
    path: SESSION_PATH,
    status: storageDiagnostics.status,
    lastReadAt: storageDiagnostics.lastReadAt,
    details: storageDiagnostics.details,
    backupPath: storageDiagnostics.backupPath,
  };
}

export function summarizeSessions(sessions: StoredSession[]): {
  hasSessions: boolean;
  sessionCount: number;
  items: Array<{
    provider: string;
    itemId: string;
    institutionId: string | null;
    institutionName: string | null;
    linkedAccountCount: number;
    accountCount: number;
    transactionCount: number;
    newestTransactionDate: string | null;
    oldestTransactionDate: string | null;
    cursorPresent: boolean;
    createdAt: string;
    lastRefreshAt: string | null;
  }>;
} {
  return {
    hasSessions: sessions.length > 0,
    sessionCount: sessions.length,
    items: sessions.map((session) => ({
      provider: session.provider,
      itemId: session.itemId,
      institutionId: session.institutionId,
      institutionName: session.institutionName,
      linkedAccountCount: session.linkedAccounts.length,
      accountCount: session.accounts.length,
      transactionCount: session.transactions.length,
      newestTransactionDate:
        session.transactions.length > 0
          ? (session.transactions[0]?.date ??
            session.transactions[0]?.authorizedDate ??
            null)
          : null,
      oldestTransactionDate:
        session.transactions.length > 0
          ? (session.transactions[session.transactions.length - 1]?.date ??
            session.transactions[session.transactions.length - 1]?.authorizedDate ??
            null)
          : null,
      cursorPresent: Boolean(session.cursor),
      createdAt: session.createdAt,
      lastRefreshAt: session.lastRefreshAt,
    })),
  };
}
