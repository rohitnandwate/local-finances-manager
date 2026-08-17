// If the server is started with LAN_ACCESS_CODE set, call APIs with header
// Authorization: Bearer <same code>. Default smoke runs do not set LAN_ACCESS_CODE.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const PORT = Number(process.env.BL12_SMOKE_PORT ?? process.env.PORT ?? "3103");
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(ROOT, ".data");
const SESSION_PATH = path.join(DATA_DIR, "plaid-session.json");
const INVESTMENT_STORE_PATH = path.join(DATA_DIR, "investment-data.json");
const FIXTURE_PATH = path.join(ROOT, "data", "fixtures", "fidelity-holdings-sample.csv");

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
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "bl12-smoke-test-key",
      LLM_MODEL: "gpt-4o-mini",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ready = false;
  let stdout = "";
  let stderr = "";

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
  if (!serverProcess) return;
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
      version: 5,
      items: [
        {
          provider: "plaid",
          itemId: "item-bl12",
          institutionId: "ins-bl12",
          institutionName: "BL12 Test Bank",
          linkedAccounts: [],
          accounts: [],
          transactions: [],
          cursor: null,
          createdAt: "2026-04-01T00:00:00.000Z",
          lastRefreshAt: null,
        },
      ],
    },
    null,
    2,
  );
}

async function run() {
  await backupFile(SESSION_PATH);
  await backupFile(INVESTMENT_STORE_PATH);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SESSION_PATH, buildSeedSessionFile(), "utf8");
  await rm(INVESTMENT_STORE_PATH, { force: true });

  const results = [];
  const pass = (name) => results.push(`PASS: ${name}`);

  await startServer();

  const fixture = await readFile(FIXTURE_PATH, "utf8");

  const importResponse = await requestJson(`${BASE_URL}/api/investments/csv/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: fixture,
      institutionName: "Fidelity",
    }),
  });
  assert(importResponse.ok, "CSV import should return 200");
  assert(importResponse.body.importedHoldings === 3, "CSV import should persist three holdings");
  assert(importResponse.body.summary?.totals?.holdingCount === 3, "summary should include three holdings");
  assert(
    importResponse.body.normalization?.rowCount === 3,
    "CSV import should rebuild normalized master list with one row per holding",
  );
  pass("CSV holdings import persists normalized records");

  const normalizedResponse = await requestJson(`${BASE_URL}/api/investments/normalized`, {
    method: "GET",
  });
  assert(normalizedResponse.ok, "normalized holdings endpoint should return 200");
  assert(
    Array.isArray(normalizedResponse.body.rows) &&
      normalizedResponse.body.rows.length === 3,
    "normalized holdings should preserve all source line items (no row merging)",
  );
  pass("Normalized holdings master list preserves row-level line items");

  const summaryResponse = await requestJson(`${BASE_URL}/api/investments/portfolio-summary`, {
    method: "GET",
  });
  assert(summaryResponse.ok, "portfolio summary should return 200");
  const totalValue = Number(summaryResponse.body?.totals?.totalInvestmentValue ?? 0);
  assert(Math.abs(totalValue - 7489.34) < 0.01, "portfolio total should match fixture values");
  pass("Portfolio summary aggregates imported holdings");

  const holdingsExport = await requestJson(`${BASE_URL}/api/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "holdings-all", from: null, to: null }),
  });
  assert(holdingsExport.ok, "holdings export should return 200");
  assert(holdingsExport.body.rowCount === 3, "holdings export should contain three rows");
  const holdingsFile = await readFile(holdingsExport.body.filePath, "utf8");
  assert(
    holdingsFile.includes("source_item_id") && holdingsFile.includes("Vanguard Total Stock Market ETF"),
    "holdings export should include expected columns and security names",
  );
  pass("Holdings export writes TSV with investment rows");

  const transactionsExport = await requestJson(`${BASE_URL}/api/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "investment-transactions", from: null, to: null }),
  });
  assert(transactionsExport.ok, "investment transactions export should return 200");
  assert(transactionsExport.body.rowCount === 0, "investment transactions export should be empty without plaid sync");
  pass("Investment transactions export works for empty-state store");

  console.log("\nBL12 smoke test passed:");
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
    await restoreFile(INVESTMENT_STORE_PATH);
  }
}

main().catch((error) => {
  console.error("\nBL12 smoke test failed:");
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
