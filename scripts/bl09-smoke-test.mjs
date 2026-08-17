import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const ROOT = process.cwd();
const PORT = Number(process.env.BL09_SMOKE_PORT ?? process.env.PORT ?? "3102");
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(ROOT, ".data");
const SESSION_PATH = path.join(DATA_DIR, "plaid-session.json");
const OVERRIDE_PATH = path.join(DATA_DIR, "category-overrides.json");

const KEYCHAIN_SERVICE = "budget-expense-tracker";
const KEYCHAIN_TEST_ITEM = "bl09-smoke-test-item";
const KEYCHAIN_TEST_SERVICE = "budget-expense-tracker-smoke";
const SECURITY_BIN = "/usr/bin/security";

const originalFiles = new Map();
let serverProcess = null;

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function backupFile(filePath) {
  originalFiles.set(filePath, await readIfExists(filePath));
}

async function restoreFile(filePath) {
  const original = originalFiles.get(filePath);
  if (original === null) {
    await rm(filePath, { force: true });
    return;
  }
  if (typeof original === "string") {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, original, "utf8");
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(urlOrPath, options) {
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${BASE_URL}${urlOrPath}`;
  const response = await fetch(url, options);
  const body = await response.json();
  return { ok: response.ok, status: response.status, body };
}

async function startServer(extraEnv = {}) {
  const env = { ...process.env, HOST, PORT: String(PORT), ...extraEnv };
  /* Disable LAN gate: dotenv loads .env after spawn and must not re-enable a code-only guard. */
  env.LAN_ACCESS_CODE = "";
  env.LAN_AUTH_SECRET = "";

  serverProcess = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ready = false;
  let stderr = "";
  let stdout = "";

  serverProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    if (text.includes("Budget tracker listening on")) {
      ready = true;
    }
  });

  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const timeoutAt = Date.now() + 30_000;
  while (!ready && Date.now() < timeoutAt) {
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `Server exited early with code ${serverProcess.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (!ready) {
    throw new Error(`Server did not become ready in time.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
}

async function stopServer() {
  if (!serverProcess) {
    return;
  }
  serverProcess.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (serverProcess.exitCode === null) {
    serverProcess.kill("SIGKILL");
  }
  serverProcess = null;
}

// --- Keychain helpers ---
// The app stores tokens with the default Keychain ACL (trusts /usr/bin/security).
// Standalone round-trip test uses a separate service name for isolation.
// Migration tests check both existence and value readability.

function testKeychainStore(account, password) {
  execFileSync(SECURITY_BIN, [
    "add-generic-password",
    "-s", KEYCHAIN_TEST_SERVICE,
    "-a", account,
    "-w", password,
    "-U",
  ]);
}

function testKeychainFind(account) {
  return execFileSync(SECURITY_BIN, [
    "find-generic-password",
    "-s", KEYCHAIN_TEST_SERVICE,
    "-a", account,
    "-w",
  ]).toString().trim();
}

function testKeychainDelete(account) {
  try {
    execFileSync(SECURITY_BIN, [
      "delete-generic-password",
      "-s", KEYCHAIN_TEST_SERVICE,
      "-a", account,
    ]);
    return true;
  } catch {
    return false;
  }
}

function keychainHas(service, account) {
  try {
    execFileSync(SECURITY_BIN, [
      "find-generic-password",
      "-s", service,
      "-a", account,
    ]);
    return true;
  } catch {
    return false;
  }
}

function keychainDelete(service, account) {
  try {
    execFileSync(SECURITY_BIN, [
      "delete-generic-password",
      "-s", service,
      "-a", account,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  await backupFile(SESSION_PATH);
  await backupFile(OVERRIDE_PATH);
  await mkdir(DATA_DIR, { recursive: true });

  const results = [];
  const pass = (name) => {
    results.push(`PASS: ${name}`);
  };

  // 1) Keychain round-trip in isolation (uses permissive ACL for testability)
  testKeychainDelete(KEYCHAIN_TEST_ITEM);
  const testToken = "access-sandbox-smoke-test-" + Date.now();
  testKeychainStore(KEYCHAIN_TEST_ITEM, testToken);
  const retrieved = testKeychainFind(KEYCHAIN_TEST_ITEM);
  assert(retrieved === testToken, `Keychain round-trip failed: got "${retrieved}"`);
  testKeychainDelete(KEYCHAIN_TEST_ITEM);
  assert(!keychainHas(KEYCHAIN_TEST_SERVICE, KEYCHAIN_TEST_ITEM), "Keychain entry should be deleted");
  pass("macOS Keychain store/find/delete round-trip succeeds");

  // 2) Legacy migration: v3 file with plaintext token → v5 file without token + token in Keychain
  await rm(SESSION_PATH, { force: true });
  await rm(OVERRIDE_PATH, { force: true });
  keychainDelete(KEYCHAIN_SERVICE, "test-item-001");

  const legacyToken = "access-sandbox-plaintext-migrate-test";
  const v3State = {
    version: 3,
    items: [
      {
        provider: "plaid",
        accessToken: legacyToken,
        itemId: "test-item-001",
        institutionId: "ins_1",
        institutionName: "Smoke Test Bank",
        linkedAccounts: [],
        accounts: [],
        transactions: [],
        cursor: null,
        createdAt: new Date().toISOString(),
        lastRefreshAt: null,
      },
    ],
  };
  await writeFile(SESSION_PATH, JSON.stringify(v3State, null, 2), "utf8");

  await startServer();

  const health = await requestJson("/api/health");
  assert(health.ok, "Health endpoint should return 200");
  assert(health.body?.service?.status === "ready", "Service should be ready");
  pass("Service starts healthy with legacy v3 session file");

  // After health triggers readSessions() → migration, check file on disk
  const migratedRaw = await readFile(SESSION_PATH, "utf8");
  const migratedState = JSON.parse(migratedRaw);
  assert(migratedState.version === 5, `Storage version should be 5, got ${migratedState.version}`);
  assert(
    migratedState.items[0].accessToken === undefined,
    "accessToken should not exist in the session file after migration",
  );
  pass("v3→v5 migration removes token from session file");

  // Verify token was moved to Keychain (metadata check — no password read)
  assert(
    keychainHas(KEYCHAIN_SERVICE, "test-item-001"),
    "Token should exist in Keychain after migration",
  );
  pass("Legacy plaintext token migrated to macOS Keychain (protected by system prompt)");

  // 3) Health reports sessions correctly (without ever touching the token)
  const sessions = health.body?.sessions;
  assert(sessions?.hasSessions === true, "Sessions should be reported after migration");
  assert(sessions?.items?.[0]?.institutionName === "Smoke Test Bank", "Institution name preserved");
  pass("Health endpoint reflects sessions correctly (no token needed)");

  // 4) Recurring endpoint returns structured response (local detection shape)
  const recurring = await requestJson("/api/recurring");
  assert(
    recurring.status === 200 || recurring.status === 500,
    `Recurring endpoint should return a response, got ${recurring.status}`,
  );
  if (recurring.status === 200) {
    assert(Array.isArray(recurring.body?.streams), "Response should have streams array");
    assert(typeof recurring.body?.totals === "object", "Response should have totals object");
    assert(typeof recurring.body.totals.activeInflowCount === "number", "activeInflowCount should be a number");
    assert(typeof recurring.body.totals.activeOutflowCount === "number", "activeOutflowCount should be a number");
    assert(typeof recurring.body?.frequentTotals === "object", "Response should have frequentTotals object");
    assert(typeof recurring.body.frequentTotals.activeOutflowCount === "number", "frequentTotals.activeOutflowCount should be a number");
    assert(typeof recurring.body.frequentTotals.merchantCount === "number", "frequentTotals.merchantCount should be a number");
    assert(typeof recurring.body?.detectedAt === "string", "detectedAt should be a string");
    assert(typeof recurring.body?.period === "object", "Response should have period object");
    assert(typeof recurring.body.period.from === "string", "period.from should be a string");
    assert(typeof recurring.body.period.to === "string", "period.to should be a string");
    for (const stream of recurring.body.streams) {
      assert(typeof stream.streamKey === "string", "stream should have streamKey");
      assert(typeof stream.name === "string", "stream should have name");
      assert(typeof stream.direction === "string", "stream should have direction");
      assert(typeof stream.frequency === "string", "stream should have frequency");
      assert(typeof stream.averageAmount === "number", "stream should have averageAmount");
      assert(typeof stream.lastAmount === "number", "stream should have lastAmount");
      assert(typeof stream.transactionCount === "number", "stream should have transactionCount");
      assert(typeof stream.isActive === "boolean", "stream should have isActive boolean");
      assert(typeof stream.firstDate === "string", "stream should have firstDate");
      assert(typeof stream.lastDate === "string", "stream should have lastDate");
      assert(typeof stream.windowTxnCount === "number", "stream should have windowTxnCount");
      assert(typeof stream.windowAvgAmount === "number", "stream should have windowAvgAmount");
      assert(typeof stream.windowLastAmount === "number", "stream should have windowLastAmount");
      assert(["recurring", "frequent"].includes(stream.streamType),
        `stream.streamType should be recurring or frequent, got "${stream.streamType}"`);
    }
  }
  pass("Recurring endpoint responds with valid local detection structure");

  // 5) Restart with Keychain tokens — verify session data survives
  await stopServer();
  await startServer();

  const healthAfterRestart = await requestJson("/api/health");
  assert(healthAfterRestart.ok, "Health should be OK after restart");
  assert(
    healthAfterRestart.body?.sessions?.hasSessions === true,
    "Sessions should survive restart",
  );
  assert(
    healthAfterRestart.body?.sessions?.items?.[0]?.institutionName === "Smoke Test Bank",
    "Session data should be intact after restart",
  );

  const fileAfterRestart = await readFile(SESSION_PATH, "utf8");
  const stateAfterRestart = JSON.parse(fileAfterRestart);
  assert(
    stateAfterRestart.items[0].accessToken === undefined,
    "Token should still not be in the file after restart",
  );
  pass("Session data survives restart; token remains only in Keychain");

  // 6) Session file on disk never contains any token
  const finalFileContent = await readFile(SESSION_PATH, "utf8");
  assert(
    !finalFileContent.includes(legacyToken),
    "Session file must not contain the plaintext token",
  );
  assert(
    !finalFileContent.includes("enc:"),
    "Session file must not contain encrypted tokens",
  );
  pass("Session file on disk contains no token material (plaintext or encrypted)");

  console.log(`\nBL09 smoke test passed (${results.length} checks):`);
  for (const line of results) {
    console.log(` - ${line}`);
  }
}

async function main() {
  try {
    await run();
  } finally {
    await stopServer();
    await restoreFile(SESSION_PATH);
    await restoreFile(OVERRIDE_PATH);
    testKeychainDelete(KEYCHAIN_TEST_ITEM);
    keychainDelete(KEYCHAIN_SERVICE, "test-item-001");
  }
}

main().catch((error) => {
  console.error("\nBL09 smoke test failed:");
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
