import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const BUDGET_PATH = path.join(ROOT, "context", "budgets.yml");
const SESSION_PATH = path.join(ROOT, ".data", "plaid-session.json");
const UI_PATH = path.join(ROOT, "public", "index.html");
const BASE_URL = "http://127.0.0.1:3000";

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
    await writeFile(filePath, "", "utf8");
    const fs = await import("node:fs/promises");
    await fs.rm(filePath, { force: true });
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

async function requestJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  return { ok: response.ok, status: response.status, body };
}

async function startServer() {
  serverProcess = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env: process.env,
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
  await new Promise((resolve) => setTimeout(resolve, 500));
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
          itemId: "item-test",
          institutionId: "inst-test",
          institutionName: "Test Bank",
          linkedAccounts: [],
          accounts: [],
          cursor: null,
          createdAt: "2026-04-01T00:00:00.000Z",
          lastRefreshAt: null,
          transactions: [
            {
              id: "txn-food-1",
              accountId: "acc-1",
              name: "Grocery A",
              merchantName: "Store A",
              amount: 20,
              isoCurrencyCode: "USD",
              unofficialCurrencyCode: null,
              date: "2026-04-01",
              authorizedDate: null,
              pending: false,
              personalFinanceCategoryPrimary: "FOOD_AND_DRINK",
              personalFinanceCategoryDetailed: "FOOD_AND_DRINK_GROCERIES",
              personalFinanceCategoryConfidence: "HIGH",
              counterparties: [],
              paymentChannel: null,
              merchantEntityId: null,
              logoUrl: null,
              website: null,
            },
            {
              id: "txn-food-2",
              accountId: "acc-1",
              name: "Grocery B",
              merchantName: "Store B",
              amount: 30,
              isoCurrencyCode: "USD",
              unofficialCurrencyCode: null,
              date: "2026-04-02",
              authorizedDate: null,
              pending: false,
              personalFinanceCategoryPrimary: "FOOD_AND_DRINK",
              personalFinanceCategoryDetailed: "FOOD_AND_DRINK_GROCERIES",
              personalFinanceCategoryConfidence: "HIGH",
              counterparties: [],
              paymentChannel: null,
              merchantEntityId: null,
              logoUrl: null,
              website: null,
            },
            {
              id: "txn-food-3",
              accountId: "acc-1",
              name: "Dining C",
              merchantName: "Restaurant C",
              amount: 40,
              isoCurrencyCode: "USD",
              unofficialCurrencyCode: null,
              date: "2026-04-03",
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
            {
              id: "txn-travel-1",
              accountId: "acc-1",
              name: "Ride Share",
              merchantName: "Ride Co",
              amount: 10,
              isoCurrencyCode: "USD",
              unofficialCurrencyCode: null,
              date: "2026-04-03",
              authorizedDate: null,
              pending: false,
              personalFinanceCategoryPrimary: "TRAVEL",
              personalFinanceCategoryDetailed: "TRAVEL_RIDE_SHARE",
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

async function run() {
  await backupFile(BUDGET_PATH);
  await backupFile(SESSION_PATH);

  await mkdir(path.dirname(BUDGET_PATH), { recursive: true });
  await mkdir(path.dirname(SESSION_PATH), { recursive: true });
  await writeFile(SESSION_PATH, buildSeedSessionFile(), "utf8");

  const results = [];
  const pass = (name) => {
    results.push(`PASS: ${name}`);
  };

  // 1) Valid file + validate endpoint
  await writeFile(
    BUDGET_PATH,
    `version: 1\nbudgets:\n  - id: food-weekly\n    category: FOOD_AND_DRINK\n    amount: 70\n    cadence: weekly\n    effectiveStart: 2026-04-01\n    effectiveEnd:\n`,
    "utf8",
  );

  await startServer();
  const validateOk = await requestJson(`${BASE_URL}/api/budgets/validate`);
  assert(validateOk.ok, "validate endpoint should return 200 for valid file");
  assert(validateOk.body.valid === true, "valid budget file should report valid=true");
  pass("GET /api/budgets/validate accepts valid budgets.yml");

  // 2) Overlap detection blocks review
  await writeFile(
    BUDGET_PATH,
    `version: 1\nbudgets:\n  - id: food-a\n    category: FOOD_AND_DRINK\n    amount: 70\n    cadence: weekly\n    effectiveStart: 2026-04-01\n    effectiveEnd: 2026-04-10\n  - id: food-b\n    category: FOOD_AND_DRINK\n    amount: 70\n    cadence: weekly\n    effectiveStart: 2026-04-05\n    effectiveEnd: 2026-04-20\n`,
    "utf8",
  );
  const reviewOverlap = await requestJson(
    `${BASE_URL}/api/budgets/review?from=2026-04-01&to=2026-04-10`,
  );
  assert(reviewOverlap.ok, "review endpoint should respond even for overlap errors");
  assert(reviewOverlap.body.validation?.valid === false, "overlap should set validation.valid=false");
  assert(
    Array.isArray(reviewOverlap.body.items) && reviewOverlap.body.items.length === 0,
    "overlap should block review item computation",
  );
  assert(
    reviewOverlap.body.validation.issues.some((issue) => issue.code === "overlap"),
    "overlap issue code should be returned",
  );
  pass("Overlap errors are detected and block /api/budgets/review output");

  // 3) Unknown + unbudgeted warnings surfaced
  await writeFile(
    BUDGET_PATH,
    `version: 1\nbudgets:\n  - id: food-weekly\n    category: FOOD_AND_DRINK\n    amount: 70\n    cadence: weekly\n    effectiveStart: 2026-04-01\n    effectiveEnd:\n  - id: unknown-cat\n    category: GAMING\n    amount: 35\n    cadence: weekly\n    effectiveStart: 2026-04-01\n    effectiveEnd:\n`,
    "utf8",
  );
  const reviewWarn = await requestJson(
    `${BASE_URL}/api/budgets/review?from=2026-04-01&to=2026-04-03`,
  );
  assert(reviewWarn.ok, "review endpoint should return 200 for warning scenarios");
  assert(reviewWarn.body.validation?.valid === true, "warnings should not invalidate review");
  const warningCodes = new Set(reviewWarn.body.validation.issues.map((issue) => issue.code));
  assert(warningCodes.has("unknown_category"), "unknown category warning should be present");
  assert(warningCodes.has("unbudgeted_category"), "unbudgeted observed category warning should be present");
  pass("Unknown and unbudgeted category warnings are surfaced in review payload");

  // 4) Shared Analyze date window wiring + window-sensitive output
  const uiContent = await readFile(UI_PATH, "utf8");
  assert(
    uiContent.includes('const budgetFromInput = document.getElementById("briefing-from");') &&
      uiContent.includes('const budgetToInput = document.getElementById("briefing-to");'),
    "budget review should use shared Analyze date inputs (briefing-from/to)",
  );
  const reviewWindowA = await requestJson(
    `${BASE_URL}/api/budgets/review?from=2026-04-01&to=2026-04-03`,
  );
  const reviewWindowB = await requestJson(
    `${BASE_URL}/api/budgets/review?from=2026-04-01&to=2026-04-01`,
  );
  assert(reviewWindowA.body.totals.totalExpected !== reviewWindowB.body.totals.totalExpected, "different windows should produce different expected totals");
  assert(reviewWindowA.body.totals.totalActual !== reviewWindowB.body.totals.totalActual, "different windows should produce different actual totals");
  pass("Analyze shared date window wiring exists and review metrics vary by window");

  // 5) Partial-window proration check
  const foodItem = reviewWindowA.body.items.find((item) => item.category === "FOOD_AND_DRINK");
  assert(Boolean(foodItem), "FOOD_AND_DRINK item should exist in review");
  assert(
    Math.abs(foodItem.expected - 30) < 0.01,
    `expected FOOD_AND_DRINK budget should be 30.00 for 3 days of weekly 70 (got ${foodItem.expected})`,
  );
  pass("Partial-window proration matches hand-check (weekly 70 over 3 days => 30)");

  console.log("\nBL07 smoke test passed:");
  for (const line of results) {
    console.log(` - ${line}`);
  }
}

async function main() {
  try {
    await run();
  } finally {
    await stopServer();
    await restoreFile(BUDGET_PATH);
    await restoreFile(SESSION_PATH);
  }
}

main().catch((error) => {
  console.error("\nBL07 smoke test failed:");
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
