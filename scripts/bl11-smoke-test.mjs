import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const PORT = Number(process.env.BL11_SMOKE_PORT ?? process.env.PORT ?? "3102");
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(ROOT, ".data");
const SESSION_PATH = path.join(DATA_DIR, "plaid-session.json");
const OVERRIDE_PATH = path.join(DATA_DIR, "category-overrides.json");
const UI_PATH = path.join(ROOT, "public", "index.html");

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

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { ok: response.ok, status: response.status, body };
}

async function startServer() {
  serverProcess = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST,
      PORT: String(PORT),
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "bl11-smoke-test-key",
      LLM_MODEL: "gpt-4o-mini",
    },
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

function buildSeedSessionFile() {
  return JSON.stringify(
    {
      version: 3,
      items: [
        {
          provider: "plaid",
          accessToken: "test-token",
          itemId: "item-bl11",
          institutionId: "inst-bl11",
          institutionName: "BL11 Test Bank",
          linkedAccounts: [],
          accounts: [],
          cursor: null,
          createdAt: "2026-04-01T00:00:00.000Z",
          lastRefreshAt: null,
          transactions: [
            {
              id: "txn-reviewed-low-confidence",
              accountId: "acc-1",
              name: "General Purchase",
              merchantName: "Merchant One",
              amount: 40,
              isoCurrencyCode: "USD",
              unofficialCurrencyCode: null,
              date: "2026-01-15",
              authorizedDate: null,
              pending: false,
              personalFinanceCategoryPrimary: "GENERAL_MERCHANDISE",
              personalFinanceCategoryDetailed: "GENERAL_MERCHANDISE_SUPERSTORES",
              personalFinanceCategoryConfidence: "LOW",
              counterparties: [],
              paymentChannel: null,
              merchantEntityId: null,
              logoUrl: null,
              website: null,
            },
            {
              id: "txn-high-confidence",
              accountId: "acc-1",
              name: "Restaurant High Confidence",
              merchantName: "Merchant Two",
              amount: 20,
              isoCurrencyCode: "USD",
              unofficialCurrencyCode: null,
              date: "2026-02-20",
              authorizedDate: null,
              pending: false,
              personalFinanceCategoryPrimary: "FOOD_AND_DRINK",
              personalFinanceCategoryDetailed: "FOOD_AND_DRINK_RESTAURANT",
              personalFinanceCategoryConfidence: "HIGH",
              counterparties: [],
              paymentChannel: null,
              merchantEntityId: null,
              logoUrl: null,
              website: null,
            },
          ],
        },
      ],
    },
    null,
    2,
  );
}

function buildSeedOverrideFile() {
  return JSON.stringify(
    {
      version: 2,
      transactionOverrides: {},
      merchantRules: {},
      reviewQueue: [],
      reviewedTransactions: {
        "txn-reviewed-low-confidence": "2026-04-01T00:00:00.000Z",
      },
    },
    null,
    2,
  );
}

async function run() {
  await backupFile(SESSION_PATH);
  await backupFile(OVERRIDE_PATH);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SESSION_PATH, buildSeedSessionFile(), "utf8");
  await writeFile(OVERRIDE_PATH, buildSeedOverrideFile(), "utf8");

  const results = [];
  const pass = (name) => {
    results.push(`PASS: ${name}`);
  };

  await startServer();

  // 1) Date validation for review endpoint
  const badWindow = await requestJson(`${BASE_URL}/api/overrides/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: "2026-03-01",
      to: "2026-02-01",
    }),
  });
  assert(!badWindow.ok && badWindow.status === 400, "invalid review window should return 400");
  assert(
    typeof badWindow.body?.error === "string" &&
      badWindow.body.error.includes("earlier than or equal"),
    "invalid window should return from<=to validation message",
  );
  pass("Review endpoint rejects invalid from/to window");

  // 2) Windowed review path should execute with deterministic no-candidate setup
  const noCandidateRun = await requestJson(`${BASE_URL}/api/overrides/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: "2026-03-01",
      to: "2026-03-31",
      forceReReview: false,
    }),
  });
  assert(noCandidateRun.ok, "windowed review should return 200");
  assert(noCandidateRun.body.reviewed === 0, "windowed run should review zero candidates in seeded data");
  assert(noCandidateRun.body.added === 0, "windowed run should add zero review queue items");
  assert(noCandidateRun.body.from === "2026-03-01", "response should echo from date");
  assert(noCandidateRun.body.to === "2026-03-31", "response should echo to date");
  assert(noCandidateRun.body.forceReReview === false, "response should echo non-force mode");
  assert(noCandidateRun.body.clearedLedgerReset === 0, "non-force mode should not clear reviewed ledger");
  const storeAfterNoForce = JSON.parse(await readFile(OVERRIDE_PATH, "utf8"));
  assert(
    typeof storeAfterNoForce.reviewedTransactions?.["txn-reviewed-low-confidence"] === "string",
    "reviewed ledger should remain intact without force re-review",
  );
  pass("Windowed review respects provided dates and preserves cleared ledger in non-force mode");

  // 3) Force re-review should clear ledger even when candidate window is empty
  const forceRun = await requestJson(`${BASE_URL}/api/overrides/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: "2026-03-01",
      to: "2026-03-31",
      forceReReview: true,
    }),
  });
  assert(forceRun.ok, "force re-review run should return 200");
  assert(forceRun.body.forceReReview === true, "response should echo force mode");
  assert(forceRun.body.clearedLedgerReset === 1, "force mode should clear one seeded reviewed transaction");
  const storeAfterForce = JSON.parse(await readFile(OVERRIDE_PATH, "utf8"));
  assert(
    Object.keys(storeAfterForce.reviewedTransactions || {}).length === 0,
    "reviewed ledger should be empty after force re-review",
  );
  pass("Force re-review clears incremental reviewed-transaction ledger");

  // 4) UI controls are wired for BL11 inputs
  const uiContent = await readFile(UI_PATH, "utf8");
  assert(
    uiContent.includes('id="review-from"') &&
      uiContent.includes('id="review-to"') &&
      uiContent.includes('id="review-force-rerun"'),
    "Review UI should include from/to and force re-review controls",
  );
  assert(
    uiContent.includes("body: JSON.stringify({ from, to, forceReReview })"),
    "Review UI should send from/to/force payload to review endpoint",
  );
  pass("Review tab UI wiring exists for BL11 controls");

  console.log("\nBL11 smoke test passed:");
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
  }
}

main().catch((error) => {
  console.error("\nBL11 smoke test failed:");
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
