import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const PORT = Number(process.env.BL08_SMOKE_PORT ?? process.env.PORT ?? "3101");
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(ROOT, ".data");
const SESSION_PATH = path.join(DATA_DIR, "plaid-session.json");
const OVERRIDE_PATH = path.join(DATA_DIR, "category-overrides.json");

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

async function requestJson(url) {
  const response = await fetch(url);
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

async function run() {
  await backupFile(SESSION_PATH);
  await backupFile(OVERRIDE_PATH);
  await mkdir(DATA_DIR, { recursive: true });

  const results = [];
  const pass = (name) => {
    results.push(`PASS: ${name}`);
  };

  // 1) Healthy cold start with default empty state
  await rm(SESSION_PATH, { force: true });
  await rm(OVERRIDE_PATH, { force: true });
  await startServer();
  const healthy = await requestJson(`${BASE_URL}/api/health`);
  assert(healthy.ok, "health endpoint should return 200");
  assert(healthy.body?.service?.status === "ready", "fresh startup should report ready status");
  assert(
    healthy.body?.localState?.checks?.dataDirWritable === true,
    "data dir should be writable",
  );
  pass("Cold start reports ready service health");
  await stopServer();

  // 2) Corrupt local stores should be quarantined with actionable health signal
  await writeFile(SESSION_PATH, "{ bad json", "utf8");
  await writeFile(OVERRIDE_PATH, "{ bad json", "utf8");
  await startServer();
  const recovered = await requestJson(`${BASE_URL}/api/health`);
  assert(recovered.ok, "health endpoint should return 200 after corruption recovery");
  assert(
    recovered.body?.service?.status === "degraded",
    "corrupt store recovery should surface degraded health",
  );
  assert(
    recovered.body?.localState?.sessionStore?.status === "recovered_from_corruption",
    "session store should report recovered_from_corruption",
  );
  assert(
    recovered.body?.localState?.overrideStore?.status === "recovered_from_corruption",
    "override store should report recovered_from_corruption",
  );
  assert(
    typeof recovered.body?.localState?.sessionStore?.backupPath === "string" &&
      recovered.body.localState.sessionStore.backupPath.length > 0,
    "session store backup path should be included",
  );
  assert(
    typeof recovered.body?.localState?.overrideStore?.backupPath === "string" &&
      recovered.body.localState.overrideStore.backupPath.length > 0,
    "override store backup path should be included",
  );
  pass("Corrupt stores are quarantined and exposed via health diagnostics");
  await stopServer();

  // 3) Restart behavior remains predictable after recovery
  await startServer();
  const restarted = await requestJson(`${BASE_URL}/api/health`);
  assert(restarted.ok, "health endpoint should return 200 after restart");
  assert(
    restarted.body?.service?.status === "ready",
    "restart after recovered state should return ready status",
  );
  pass("Restart after recovery returns to ready status");

  console.log("\nBL08 smoke test passed:");
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
  console.error("\nBL08 smoke test failed:");
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
