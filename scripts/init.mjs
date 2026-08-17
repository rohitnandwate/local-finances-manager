/**
 * Guided first-time setup: dependencies, `.env.local` from `.env.example`,
 * Plaid Production credentials (default), optional `npm run dev`.
 *
 * Usage: npm run init [-- options]
 *   --yes, -y        Non-interactive scaffold (no credential prompts).
 *   --skip-dev       Do not offer npm run dev at the end.
 *   --skip-install   Do not run npm ci when node_modules is missing (exit with hint).
 *   --verbose, -v    Extra paths and step labels (or INIT_VERBOSE=1).
 *   -h, --help
 */

import { spawn } from "node:child_process";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const opts = {
    yes: false,
    skipDev: false,
    skipInstall: false,
    verbose: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--skip-dev") opts.skipDev = true;
    else if (a === "--skip-install") opts.skipInstall = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  if (process.env.INIT_VERBOSE === "1") opts.verbose = true;
  return opts;
}

function printHelp() {
  console.log(`npm run init — guided setup (see README “Before you run the app”)

  --yes            Non-interactive (no Plaid prompts)
  --skip-dev       Skip “start dev server?”
  --skip-install   Exit if node_modules missing instead of running npm ci
  --verbose, -v    Full npm ci log + repo path and step detail (or INIT_VERBOSE=1)
  -h, --help`);
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m === 0) return `${remS}s`;
  return `${m}m ${remS}s`;
}

const INSTALL_HINT_ROTATION = [
  "npm is resolving or fetching packages (only important lines are shown).",
  "If it’s quiet, install scripts may be compiling native code (e.g. DuckDB) — that can take many minutes.",
  "This message repeats so you know the process is still running.",
  "Still working. If install takes longer than ~15 minutes, confirm Node major matches package.json engines and see README.",
];

/**
 * @typedef {'idle' | 'reify' | 'scripts'} NpmCiPhase
 * @param {string} line
 * @param {{ getLastReify: () => string, noteReify: (pkg: string) => void, setPhase: (p: NpmCiPhase) => void }} hooks
 * @returns {boolean}
 */
function npmCiLineInteresting(line, hooks) {
  const t = line.trim();
  if (!t) return false;

  if (/^npm ERR!?/i.test(t) || /^npm error\b/i.test(t)) return true;
  if (/ELIFECYCLE|command failed/i.test(t)) return true;

  if (/^npm WARN\b/i.test(t)) return true;

  if (/^npm notice\b/i.test(t)) return true;

  if (/^npm info run\b/i.test(t)) {
    hooks.setPhase("scripts");
    return true;
  }

  if (/^> .+ (postinstall|install|preinstall|prepare)\b/i.test(t)) {
    hooks.setPhase("scripts");
    return true;
  }

  if (/(node-gyp|node-pre-gyp|prebuild-install)/i.test(t) && !/^\s*(CXX|CC|AR|LIBTOOL)\s/i.test(t)) {
    hooks.setPhase("scripts");
    return true;
  }

  if (/gyp ERR!|^ERROR\b|Error:/i.test(t)) return true;

  if (/added \d+ packages|changed \d+ packages|audited \d+ packages|packages in \d+/i.test(t)) return true;
  if (/found \d+ vulnerabilit/i.test(t)) return true;

  if (/^reify:/.test(t)) {
    const m = /^reify:([^:]+)/.exec(t);
    const pkg = m ? m[1] : "";
    if (pkg && pkg !== hooks.getLastReify()) {
      hooks.noteReify(pkg);
      hooks.setPhase("reify");
      return true;
    }
    return false;
  }

  if (/^npm http /i.test(t)) return false;
  if (/^npm verb(ose)?\b/i.test(t)) return false;
  if (/^npm sill(y)?\b/i.test(t)) return false;
  if (/^npm timing\b/i.test(t)) return false;
  if (/^npm info idealTree/i.test(t)) return false;

  return false;
}

/**
 * @param {import("node:stream").Readable} stream
 * @param {(line: string) => void} onLine
 * @returns {() => void}
 */
function attachLineHandler(stream, onLine) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? "";
    for (const p of parts) onLine(p);
  });
  return () => {
    if (buf) {
      onLine(buf);
      buf = "";
    }
  };
}

async function trySetupGitHooks() {
  const hooks = await run("node", ["scripts/setup-git-hooks.mjs"], { inherit: false });
  if (hooks.code === 0) {
    console.log("[init] Pre-commit secret scan hook enabled (see docs/operations/pre-publish-secret-scan.md).");
    return;
  }
  const gl = await run("gitleaks", ["version"], { inherit: false });
  if (gl.code !== 0) {
    console.log(
      "[init] Git hooks not configured — install gitleaks (brew install gitleaks), then: npm run setup:hooks",
    );
  }
}

function run(cmd, args, options = {}) {
  const {
    longRunningHint,
    inherit = true,
    filterNpmCi = false,
    ...spawnOpts
  } = options;
  const useInherit = inherit !== false && !filterNpmCi;
  const { env: optEnv, ...spawnRest } = spawnOpts;

  return new Promise((resolve, reject) => {
    /** @type {NpmCiPhase} */
    let npmPhase = "idle";
    let lastReifyPkg = "";

    /**
     * @param {NpmCiPhase} p
     */
    const setPhase = (p) => {
      const labels = {
        idle: "Starting (npm resolving lockfile & downloading)…",
        reify: "Extracting & linking packages into node_modules…",
        scripts: "Running package install scripts (DuckDB and other native builds run here)…",
      };
      if (p !== npmPhase && labels[p]) {
        npmPhase = p;
        console.log(`[init] ${labels[p]}`);
      }
    };

    const hooks = {
      getLastReify: () => lastReifyPkg,
      noteReify: (pkg) => {
        lastReifyPkg = pkg;
      },
      setPhase,
    };

    const started = Date.now();
    let hintTimeout;
    let hintInterval;
    let hintCount = 0;

    const clearHints = () => {
      if (hintTimeout) clearTimeout(hintTimeout);
      if (hintInterval) clearInterval(hintInterval);
    };

    if (longRunningHint) {
      const initialDelayMs = longRunningHint.initialDelayMs ?? 8_000;
      const intervalMs = longRunningHint.intervalMs ?? 20_000;
      const immediate = longRunningHint.immediate !== false;
      if (immediate) {
        console.log(
          `[init] ${formatElapsed(0)} — Install timer started.${
            filterNpmCi
              ? " Only summaries + warnings/errors from npm are shown; use --verbose for the full log."
              : ""
          } Status every ~${Math.round(intervalMs / 1000)}s if idle.`,
        );
      }
      const tick = () => {
        const elapsed = formatElapsed(Date.now() - started);
        const phaseLabel =
          /** @type {Record<string, string>} */ ({
            idle: "phase: starting / resolving",
            reify: "phase: extracting & linking",
            scripts: "phase: install scripts / native builds",
          })[npmPhase] ?? "working";
        const detail = INSTALL_HINT_ROTATION[hintCount % INSTALL_HINT_ROTATION.length];
        hintCount += 1;
        console.log(`[init] ${elapsed} — ${phaseLabel}. ${detail}`);
      };
      hintTimeout = setTimeout(() => {
        tick();
        hintInterval = setInterval(tick, intervalMs);
      }, initialDelayMs);
    }

    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: useInherit ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: false,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        ...optEnv,
      },
      ...spawnRest,
    });
    let out = "";
    let err = "";

    const processLine = (line) => {
      if (filterNpmCi && npmCiLineInteresting(line, hooks)) {
        console.log(`[npm] ${line}`);
      }
    };

    /** @type {(() => void) | null} */
    let flushOut = null;
    /** @type {(() => void) | null} */
    let flushErr = null;

    if (child.stdout) {
      child.stdout.on("data", (c) => { out += c; });
      if (!useInherit) flushOut = attachLineHandler(child.stdout, processLine);
    }
    if (child.stderr) {
      child.stderr.on("data", (c) => { err += c; });
      if (!useInherit) flushErr = attachLineHandler(child.stderr, processLine);
    }

    child.on("error", (e) => {
      clearHints();
      reject(e);
    });
    child.on("close", (code) => {
      flushOut?.();
      flushErr?.();
      clearHints();
      resolve({ code: code ?? 1, out, err });
    });
  });
}

function parseEngineMajor(enginesNode) {
  const m = enginesNode && />=\s*(\d+)/.exec(String(enginesNode));
  return m ? Number(m[1]) : 22;
}

function localNodeMajor() {
  const m = /^v(\d+)/.exec(process.version);
  return m ? Number(m[1]) : 0;
}

function getEnvValue(content, key) {
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

function upsertEnvLine(content, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    return content.replace(re, line);
  }
  return `${content.replace(/\s*$/, "")}\n${line}\n`;
}

function needsPlaidValue(value) {
  if (value == null || value === "") return true;
  const t = value.trim().toLowerCase();
  if (t.startsWith("your_")) return true;
  if (t.includes("placeholder")) return true;
  return false;
}

async function defaultYes(rl, message, { preferYes = true } = {}) {
  const hint = preferYes ? "Y/n" : "y/N";
  const ans = (await rl.question(`${message} [${hint}] `)).trim().toLowerCase();
  if (ans === "") return preferYes;
  return ans === "y" || ans === "yes";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbg = (...a) => {
    if (opts.verbose) console.log("[init]", ...a);
  };

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  process.chdir(ROOT);
  dbg("cwd", ROOT);

  const envExample = path.join(ROOT, ".env.example");
  const envLocal = path.join(ROOT, ".env.local");

  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  } catch {
    console.error("init: could not read package.json");
    process.exit(1);
  }

  const needMajor = parseEngineMajor(pkg.engines?.node);
  if (localNodeMajor() < needMajor) {
    console.error(`init: Node ${process.version} requires major >= ${needMajor} (see package.json engines).`);
    process.exit(1);
  }

  const hasModules = await pathExists(path.join(ROOT, "node_modules"));
  const interactive = input.isTTY && output.isTTY && !opts.yes;

  if (!hasModules) {
    if (opts.skipInstall) {
      console.error("init: node_modules missing — run npm ci (or npm install), or omit --skip-install.");
      process.exit(1);
    }
    console.log("");
    console.log("──────── init: install dependencies ────────");
    console.log("Running: npm ci --foreground-scripts (output filtered to key lines; use --verbose for full npm log)");
    console.log("  • Resolves the lockfile and downloads packages.");
    console.log("  • Runs lifecycle scripts (DuckDB may compile C++ here — often the slow part).");
    console.log("  • You’ll see [init] phases, occasional [npm] lines, and repeating elapsed hints if idle.");
    console.log("Tip: run `npm ci` alone first, then `npm run init`, if you prefer two shorter sessions.");
    console.log("────────────────────────────────────────────");
    console.log("");
    dbg(`spawn npm ci (verbose full log: ${opts.verbose})`);
    const r = await run(
      "npm",
      ["ci", "--foreground-scripts", "--loglevel=info"],
      {
        longRunningHint: { initialDelayMs: 8_000, intervalMs: 20_000 },
        filterNpmCi: !opts.verbose,
      },
    );
    if (r.code !== 0) {
      console.error("init: npm ci failed — try npm install, then npm run init again.");
      if (!opts.verbose) {
        console.error("init: for the full npm log, run: npm run init -- --verbose");
      }
      process.exit(1);
    }
    console.log("\n[init] npm ci finished — next: env / Plaid prompts.\n");
    dbg("npm ci exit 0");
  }

  await trySetupGitHooks();

  if (!(await pathExists(envExample))) {
    console.error("init: .env.example not found");
    process.exit(1);
  }

  if (!(await pathExists(envLocal))) {
    await copyFile(envExample, envLocal);
    console.log("Created .env.local from .env.example");
    dbg("copied .env.example → .env.local");
  }

  let envText = await readFile(envLocal, "utf8");

  if (opts.yes && !interactive) {
    envText = upsertEnvLine(envText, "PLAID_ENV", "production");
    await writeFile(envLocal, envText, "utf8");
    console.log(
      "Scaffold done. Set PLAID_CLIENT_ID and PROD_PLAID_SECRET in .env.local, then npm run dev.",
    );
    process.exit(0);
  }

  if (!interactive) {
    console.error("init: not a TTY — use npm run init -- --yes or run in a terminal.");
    process.exit(1);
  }

  const rl = createInterface({ input, output });
  if (opts.verbose) {
    console.log(
      "\nPlaid (dashboard.plaid.com): Client ID + Production secret — typing is visible in this terminal.\n",
    );
  }

  envText = upsertEnvLine(envText, "PLAID_ENV", "production");

  let clientId = getEnvValue(envText, "PLAID_CLIENT_ID");
  if (!needsPlaidValue(clientId)) {
    const ch = (
      await rl.question(
        `PLAID_CLIENT_ID is already set (${clientId.slice(0, Math.min(6, clientId.length))}…). Replace? [y/N] `,
      )
    )
      .trim()
      .toLowerCase();
    if (ch === "y" || ch === "yes") clientId = "";
    dbg("PLAID_CLIENT_ID replace?", ch);
  }
  if (needsPlaidValue(clientId)) {
    clientId = (await rl.question("PLAID_CLIENT_ID: ")).trim();
    envText = upsertEnvLine(envText, "PLAID_CLIENT_ID", clientId);
  }

  let secret = getEnvValue(envText, "PROD_PLAID_SECRET");
  if (!needsPlaidValue(secret)) {
    const ch = (
      await rl.question("PROD_PLAID_SECRET is already set. Replace? [y/N] ")
    )
      .trim()
      .toLowerCase();
    if (ch === "y" || ch === "yes") secret = "";
    dbg("PROD_PLAID_SECRET replace?", ch);
  }
  if (needsPlaidValue(secret)) {
    secret = (await rl.question("PROD_PLAID_SECRET: ")).trim();
    envText = upsertEnvLine(envText, "PROD_PLAID_SECRET", secret);
  }

  await writeFile(envLocal, envText, "utf8");
  rl.close();

  if (needsPlaidValue(clientId) || needsPlaidValue(secret)) {
    console.error("init: credentials still incomplete — edit .env.local, then npm run dev.");
    process.exit(1);
  }

  console.log("Saved .env.local");

  if (opts.skipDev) {
    console.log("Run: npm run dev");
    process.exit(0);
  }

  const rl2 = createInterface({ input, output });
  const start = await defaultYes(rl2, "Start npm run dev now?", { preferYes: true });
  rl2.close();

  if (!start) {
    console.log("Run npm run dev when ready.");
    process.exit(0);
  }

  dbg("spawn npm run dev");
  console.log("Starting dev server: npm run dev (tsx) — stop with Ctrl+C.\n");
  const dev = await run("npm", ["run", "dev"], { inherit: true });
  process.exit(dev.code ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
