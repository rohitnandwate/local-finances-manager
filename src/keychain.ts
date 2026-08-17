import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE_SERVICE_NAME = "budget-expense-tracker";
const SECURITY_BIN = "/usr/bin/security";
const NAMESPACE_MARKER = ".keychain-namespace";
const SESSION_FILE = "plaid-session.json";

/** Resolve `.data` the same way as `storage.ts` (cwd-relative). */
function dataDir(): string {
  return path.resolve(".data");
}

function sanitizeKeychainError(stderr: string, stdout: string, fallback: string): string {
  const raw = stderr?.trim() || stdout?.trim() || fallback;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "keychain operation failed";
  return lastLine.replace(/\/[^\s]+/g, "[path]");
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SECURITY_BIN, args, (error, stdout, stderr) => {
      if (error) {
        const message = sanitizeKeychainError(stderr, stdout, error.message);
        reject(new Error(`keychain: ${message}`));
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}

let resolvedServiceName: string | null = null;
let resolveServicePromise: Promise<string> | null = null;

/**
 * If set before the first Keychain operation, forces the macOS Keychain service name:
 * - `default` or `legacy` → `budget-expense-tracker` (shared across clones; old behavior).
 * - Any other non-empty value → `budget-expense-tracker-<value>` (manual isolation).
 * When unset, the service name is derived from `.data/.keychain-namespace` (see below).
 */
function serviceNameFromEnv(): string | null {
  const raw = process.env.BUDGET_TRACKER_KEYCHAIN_SUFFIX?.trim();
  if (raw === undefined) {
    return null;
  }
  if (raw === "" || raw.toLowerCase() === "default" || raw.toLowerCase() === "legacy") {
    return BASE_SERVICE_NAME;
  }
  return `${BASE_SERVICE_NAME}-${raw}`;
}

/**
 * New `.data` dirs (no `plaid-session.json` yet) get a random namespace so separate clones
 * on the same Mac do not share Keychain rows for the same Plaid `item_id`.
 * Existing installs (session file already present before first Keychain op in this process)
 * keep `budget-expense-tracker` for backward compatibility.
 */
async function resolveKeychainServiceName(): Promise<string> {
  const fromEnv = serviceNameFromEnv();
  if (fromEnv) {
    resolvedServiceName = fromEnv;
    return fromEnv;
  }
  if (resolvedServiceName) {
    return resolvedServiceName;
  }
  if (resolveServicePromise) {
    return resolveServicePromise;
  }

  resolveServicePromise = (async () => {
    const dir = dataDir();
    const markerPath = path.join(dir, NAMESPACE_MARKER);
    const sessionPath = path.join(dir, SESSION_FILE);
    await mkdir(dir, { recursive: true });

    for (;;) {
      try {
        const raw = (await readFile(markerPath, "utf8")).trim();
        const name =
          raw === "default" || raw === "legacy" ? BASE_SERVICE_NAME : `${BASE_SERVICE_NAME}-${raw}`;
        resolvedServiceName = name;
        return name;
      } catch {
        // missing marker
      }

      let sessionExists = false;
      try {
        await access(sessionPath);
        sessionExists = true;
      } catch {
        sessionExists = false;
      }

      const initial = sessionExists ? "default" : randomBytes(6).toString("hex");
      try {
        await writeFile(markerPath, `${initial}\n`, { flag: "wx" });
        const name =
          initial === "default" || initial === "legacy"
            ? BASE_SERVICE_NAME
            : `${BASE_SERVICE_NAME}-${initial}`;
        resolvedServiceName = name;
        if (name !== BASE_SERVICE_NAME) {
          console.log(
            `[keychain] Isolated Keychain service for this .data directory: ${name} ` +
              `(set BUDGET_TRACKER_KEYCHAIN_SUFFIX=default to force shared legacy name)`,
          );
        }
        return name;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }
  })();

  return resolveServicePromise;
}

function lockFileForService(serviceName: string): string {
  const hash = createHash("sha256").update(serviceName).digest("hex").slice(0, 24);
  return path.join(tmpdir(), `budget-expense-tracker-kc-${hash}.lock`);
}

/**
 * Serialize Keychain mutations across processes that share the same service name
 * (same legacy namespace or same manual suffix).
 */
async function withKeychainMachineLock<T>(serviceName: string, fn: () => Promise<T>): Promise<T> {
  if (process.platform !== "darwin") {
    return fn();
  }
  const exlock = "O_EXLOCK" in fsConstants
    ? (fsConstants as typeof fsConstants & { O_EXLOCK: number }).O_EXLOCK
    : undefined;
  if (exlock === undefined) {
    return fn();
  }
  const lockPath = lockFileForService(serviceName);
  const fh = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR | exlock);
  try {
    return await fn();
  } finally {
    await fh.close();
  }
}

async function storeTokenImpl(serviceName: string, itemId: string, token: string): Promise<void> {
  try {
    await run([
      "add-generic-password",
      "-s",
      serviceName,
      "-a",
      itemId,
      "-w",
      token,
      "-U",
    ]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("already exists")) {
      await deleteTokenImpl(serviceName, itemId);
      await run([
        "add-generic-password",
        "-s",
        serviceName,
        "-a",
        itemId,
        "-w",
        token,
      ]);
    } else {
      throw error;
    }
  }
  console.log(`[keychain] Stored access token for item ${itemId}`);
}

async function getTokenImpl(serviceName: string, itemId: string): Promise<string> {
  const token = await run([
    "find-generic-password",
    "-s",
    serviceName,
    "-a",
    itemId,
    "-w",
  ]);

  if (!token) {
    throw new Error(`keychain: No token found for item ${itemId}`);
  }

  return token;
}

async function deleteTokenImpl(serviceName: string, itemId: string): Promise<boolean> {
  try {
    await run([
      "delete-generic-password",
      "-s",
      serviceName,
      "-a",
      itemId,
    ]);
    console.log(`[keychain] Deleted access token for item ${itemId}`);
    return true;
  } catch {
    return false;
  }
}

async function hasTokenImpl(serviceName: string, itemId: string): Promise<boolean> {
  try {
    await run(["find-generic-password", "-s", serviceName, "-a", itemId]);
    return true;
  } catch {
    return false;
  }
}

export async function storeToken(itemId: string, token: string): Promise<void> {
  const serviceName = await resolveKeychainServiceName();
  await withKeychainMachineLock(serviceName, () => storeTokenImpl(serviceName, itemId, token));
}

export async function getToken(itemId: string): Promise<string> {
  const serviceName = await resolveKeychainServiceName();
  return withKeychainMachineLock(serviceName, () => getTokenImpl(serviceName, itemId));
}

export async function deleteToken(itemId: string): Promise<boolean> {
  const serviceName = await resolveKeychainServiceName();
  return withKeychainMachineLock(serviceName, () => deleteTokenImpl(serviceName, itemId));
}

export async function hasToken(itemId: string): Promise<boolean> {
  const serviceName = await resolveKeychainServiceName();
  return withKeychainMachineLock(serviceName, () => hasTokenImpl(serviceName, itemId));
}

/** For `/api/health` and debugging; does not touch Keychain. */
export async function getKeychainServiceNameForDiagnostics(): Promise<string> {
  return resolveKeychainServiceName();
}
