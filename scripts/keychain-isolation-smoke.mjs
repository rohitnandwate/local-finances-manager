/**
 * Verifies macOS Keychain service naming and /api/health exposure.
 *
 * - Fresh .data (no session file): auto-isolated suffix budget-expense-tracker-<12 hex>
 * - Two separate workdirs: different suffixes
 * - Existing plaid-session.json before first Keychain op: legacy budget-expense-tracker
 * - BUDGET_TRACKER_KEYCHAIN_SUFFIX=custom: budget-expense-tracker-custom
 *
 * Skips with exit 0 on non-darwin (Keychain not used).
 *
 * Usage: node scripts/keychain-isolation-smoke.mjs
 * Optional: KEYCHAIN_SMOKE_PORT_A=3120 KEYCHAIN_SMOKE_PORT_B=3121
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";

const execFileP = promisify(execFile);

const ROOT = process.cwd();
const HOST = "127.0.0.1";
const PORT_A = Number(process.env.KEYCHAIN_SMOKE_PORT_A ?? "3120");
const PORT_B = Number(process.env.KEYCHAIN_SMOKE_PORT_B ?? "3121");
const PORT_C = Number(process.env.KEYCHAIN_SMOKE_PORT_C ?? "3122");
const PORT_D = Number(process.env.KEYCHAIN_SMOKE_PORT_D ?? "3123");

let lastServer = null;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function prepareSandbox(dest) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await execFileP("rsync", [
    "-a",
    "--exclude",
    "node_modules",
    "--exclude",
    ".env",
    "--exclude",
    ".env.local",
    "--exclude",
    ".git",
    "--exclude",
    ".data",
    "--exclude",
    "dist",
    "--exclude",
    "exports",
    "--exclude",
    "briefings",
    path.join(ROOT, "/"),
    path.join(dest, "/"),
  ]);
  await rm(path.join(dest, "node_modules"), { recursive: true, force: true });
  await symlink(path.join(ROOT, "node_modules"), path.join(dest, "node_modules"), "dir");
}

async function requestHealth(port) {
  const url = `http://${HOST}:${port}/api/health`;
  const response = await fetch(url);
  const body = await response.json();
  return { ok: response.ok, status: response.status, body };
}

async function startServer(cwd, port, extraEnv = {}) {
  if (lastServer) {
    await stopServer();
  }
  const { spawn } = await import("node:child_process");
  const env = { ...process.env, HOST, PORT: String(port) };
  delete env.BUDGET_TRACKER_KEYCHAIN_SUFFIX;
  env.LAN_ACCESS_CODE = "";
  env.LAN_AUTH_SECRET = "";
  Object.assign(env, extraEnv);

  const serverProcess = spawn("npm", ["run", "dev"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  lastServer = serverProcess;
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

  const timeoutAt = Date.now() + 45_000;
  while (!ready && Date.now() < timeoutAt) {
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `Server exited early (port ${port}) code ${serverProcess.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    throw new Error(`Server not ready on port ${port}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }

  return serverProcess;
}

async function stopServer() {
  if (!lastServer) {
    return;
  }
  lastServer.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  if (lastServer.exitCode === null) {
    lastServer.kill("SIGKILL");
  }
  lastServer = null;
}

const ISOLATED_PATTERN = /^budget-expense-tracker-[a-f0-9]{12}$/;
const LEGACY_NAME = "budget-expense-tracker";

async function main() {
  if (process.platform !== "darwin") {
    console.log("keychain-isolation-smoke: skip (non-darwin)");
    return;
  }

  const results = [];

  const dirA = await mkdtemp(path.join(tmpdir(), "bet-kc-a-"));
  const dirB = await mkdtemp(path.join(tmpdir(), "bet-kc-b-"));
  const dirC = await mkdtemp(path.join(tmpdir(), "bet-kc-c-"));
  const dirD = await mkdtemp(path.join(tmpdir(), "bet-kc-d-"));

  try {
    await prepareSandbox(dirA);
    await prepareSandbox(dirB);
    await prepareSandbox(dirC);
    await prepareSandbox(dirD);

    // --- A: fresh tree, no .data — auto isolated
    await startServer(dirA, PORT_A, {});
    let h = await requestHealth(PORT_A);
    assert(h.ok, `Health A should be OK, got ${h.status}`);
    const nameA = h.body?.localState?.keychainServiceName;
    assert(typeof nameA === "string" && ISOLATED_PATTERN.test(nameA), `Expected isolated name, got ${nameA}`);
    const markerA = (await readFile(path.join(dirA, ".data", ".keychain-namespace"), "utf8")).trim();
    assert(markerA.length === 12, `Marker A should be 12 hex chars, got ${markerA}`);
    results.push(`fresh .data → ${nameA}`);
    await stopServer();

    // --- B: fresh tree — different isolated name than A
    await startServer(dirB, PORT_B, {});
    h = await requestHealth(PORT_B);
    assert(h.ok, `Health B should be OK, got ${h.status}`);
    const nameB = h.body?.localState?.keychainServiceName;
    assert(ISOLATED_PATTERN.test(nameB), `Expected isolated name B, got ${nameB}`);
    assert(nameB !== nameA, `A and B should differ (${nameA} vs ${nameB})`);
    results.push(`second fresh .data → ${nameB} (≠ A)`);
    await stopServer();

    // --- C: session file before marker → legacy shared name
    await mkdir(path.join(dirC, ".data"), { recursive: true });
    await writeFile(
      path.join(dirC, ".data", "plaid-session.json"),
      JSON.stringify({ version: 5, items: [] }, null, 2),
      "utf8",
    );
    await startServer(dirC, PORT_C, {});
    h = await requestHealth(PORT_C);
    assert(h.ok, `Health C should be OK, got ${h.status}`);
    const nameC = h.body?.localState?.keychainServiceName;
    assert(nameC === LEGACY_NAME, `Existing session should use legacy name, got ${nameC}`);
    const markerC = (await readFile(path.join(dirC, ".data", ".keychain-namespace"), "utf8")).trim();
    assert(markerC === "default", `Marker C should be default, got ${markerC}`);
    results.push(`session-before-marker → ${nameC}`);
    await stopServer();

    // --- D: env suffix override, fresh (no .data)
    await startServer(dirD, PORT_D, { BUDGET_TRACKER_KEYCHAIN_SUFFIX: "smoke-isolation" });
    h = await requestHealth(PORT_D);
    assert(h.ok, `Health D should be OK, got ${h.status}`);
    const nameD = h.body?.localState?.keychainServiceName;
    assert(
      nameD === "budget-expense-tracker-smoke-isolation",
      `Suffix override should win, got ${nameD}`,
    );
    results.push(`BUDGET_TRACKER_KEYCHAIN_SUFFIX=smoke-isolation → ${nameD}`);
    await stopServer();

    console.log("\nkeychain-isolation-smoke passed:");
    for (const line of results) {
      console.log(`  - ${line}`);
    }
  } finally {
    await stopServer();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(dirC, { recursive: true, force: true });
    await rm(dirD, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\nkeychain-isolation-smoke failed:");
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
