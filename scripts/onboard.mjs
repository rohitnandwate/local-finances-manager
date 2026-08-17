/**
 * Guided clean-machine / stranger onboarding: preflight checks, optional .env.local
 * scaffolding, automated verify steps, manual reminders, and a paste-ready sign-off
 * block for GitHub issues or PRs.
 *
 * Usage: npm run onboard [-- options]
 *
 * Options:
 *   --yes, -y       Non-interactive: copy .env.local from .env.example if missing (no prompt).
 *   --skip-env      Do not create or prompt for .env.local.
 *   --skip-build    Skip `npm run build`.
 *   --skip-secrets  Skip `npm run scan:secrets` (gitleaks).
 *   --full          Also run `npm test` (typecheck + keychain smoke on macOS).
 *   --install       Run `npm ci` if node_modules is missing (non-interactive installs).
 *   --help, -h      Show this help.
 */

import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  readFile,
} from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const COL = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  bold: "\x1b[1m",
};

function parseArgs(argv) {
  const opts = {
    yes: false,
    skipEnv: false,
    skipBuild: false,
    skipSecrets: false,
    full: false,
    install: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--skip-env") opts.skipEnv = true;
    else if (a === "--skip-build") opts.skipBuild = true;
    else if (a === "--skip-secrets") opts.skipSecrets = true;
    else if (a === "--full") opts.full = true;
    else if (a === "--install") opts.install = true;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`\
${COL.bold}local-finances-manager — onboard (clean-machine helper)${COL.reset}

  npm run onboard -- [options]

  ${COL.dim}--yes${COL.reset}              Create .env.local from .env.example if missing (no prompt)
  ${COL.dim}--install${COL.reset}           Run npm ci when node_modules is missing
  ${COL.dim}--skip-env${COL.reset}         Do not create or prompt for .env.local
  ${COL.dim}--skip-build${COL.reset}       Skip npm run build
  ${COL.dim}--skip-secrets${COL.reset}     Skip npm run scan:secrets (gitleaks)
  ${COL.dim}--full${COL.reset}             Also run npm test
  ${COL.dim}-h, --help${COL.reset}         This help

  More detail: ${COL.dim}scripts/onboard.mjs${COL.reset} (file header) and
  ${COL.dim}docs/operations/clean-machine-first-run.md${COL.reset}
`);
}

function parseEngineMajor(enginesNode) {
  const m = enginesNode && />=\s*(\d+)/.exec(String(enginesNode));
  return m ? Number(m[1]) : 22;
}

function localNodeMajor() {
  const v = process.version;
  const m = /^v(\d+)/.exec(v);
  return m ? Number(m[1]) : 0;
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: options.inherit === false ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
      ...options,
    });
    let out = "";
    let err = "";
    if (child.stdout) child.stdout.on("data", (c) => { out += c; });
    if (child.stderr) child.stderr.on("data", (c) => { err += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, out, err });
    });
  });
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  process.chdir(ROOT);
  const startedAt = new Date();
  /** @type {{ id: string; label: string; status: 'pass' | 'fail' | 'skip' | 'warn'; detail?: string }[]} */
  const results = [];

  console.log(
    `${COL.bold}Onboard — clean-machine preflight${COL.reset} ${COL.dim}(repo: ${ROOT})${COL.reset}\n`,
  );

  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  } catch {
    console.error(`${COL.red}package.json not found or invalid.${COL.reset}`);
    process.exit(1);
  }

  const needMajor = parseEngineMajor(pkg.engines?.node);
  const gotMajor = localNodeMajor();
  if (gotMajor < needMajor) {
    results.push({
      id: "node-engine",
      label: `Node.js >= ${needMajor} (engines.node)`,
      status: "fail",
      detail: `Found ${process.version}; need major >= ${needMajor}.`,
    });
  } else {
    results.push({
      id: "node-engine",
      label: `Node.js >= ${needMajor} (engines.node)`,
      status: "pass",
      detail: process.version,
    });
  }

  const hasModules = await pathExists(path.join(ROOT, "node_modules"));
  if (!hasModules) {
    if (opts.install) {
      console.log(`${COL.bold}Running npm ci…${COL.reset}`);
      const npm = await run("npm", ["ci"], { inherit: true });
      if (npm.code !== 0) {
        results.push({
          id: "npm-ci",
          label: "npm ci",
          status: "fail",
          detail: `exit ${npm.code}`,
        });
      } else {
        results.push({ id: "npm-ci", label: "npm ci", status: "pass" });
      }
    } else {
      results.push({
        id: "node_modules",
        label: "node_modules present",
        status: "warn",
        detail: "Missing — run npm ci or npm install (or npm run onboard -- --install).",
      });
    }
  } else {
    results.push({
      id: "node_modules",
      label: "node_modules present",
      status: "pass",
    });
  }

  const envExample = path.join(ROOT, ".env.example");
  const envLocal = path.join(ROOT, ".env.local");
  if (!opts.skipEnv) {
    const hasLocal = await pathExists(envLocal);
    if (!hasLocal) {
      const hasExample = await pathExists(envExample);
      if (!hasExample) {
        results.push({
          id: "env-local",
          label: ".env.local",
          status: "warn",
          detail: ".env.example missing — create .env.local manually.",
        });
      } else if (opts.yes || !input.isTTY) {
        if (!opts.yes && !input.isTTY) {
          results.push({
            id: "env-local",
            label: ".env.local",
            status: "warn",
            detail:
              "Missing; non-interactive stdin — use --yes to copy from .env.example, or create .env.local manually.",
          });
        } else {
          await copyFile(envExample, envLocal);
          results.push({
            id: "env-local",
            label: "Copy .env.example → .env.local",
            status: "pass",
            detail: "Non-interactive (--yes). Edit Plaid Sandbox vars before npm run dev.",
          });
        }
      } else {
        const rl = createInterface({ input, output });
        const ans = (await rl.question(
          `${COL.yellow}Create .env.local from .env.example?${COL.reset} [y/N] `,
        )).trim().toLowerCase();
        rl.close();
        if (ans === "y" || ans === "yes") {
          await copyFile(envExample, envLocal);
          results.push({
            id: "env-local",
            label: "Copy .env.example → .env.local",
            status: "pass",
            detail: "Edit Plaid Sandbox vars before npm run dev.",
          });
        } else {
          results.push({
            id: "env-local",
            label: ".env.local",
            status: "skip",
            detail: "Skipped — create manually (see .env.example).",
          });
        }
      }
    } else {
      results.push({
        id: "env-local",
        label: ".env.local exists",
        status: "pass",
      });
    }
  } else {
    results.push({
      id: "env-local",
      label: ".env.local",
      status: "skip",
      detail: "--skip-env",
    });
  }

  const canRunNpmScripts =
    (await pathExists(path.join(ROOT, "node_modules"))) ||
    results.some((r) => r.id === "npm-ci" && r.status === "pass");

  if (canRunNpmScripts) {
    console.log(`\n${COL.bold}npm run typecheck${COL.reset}`);
    const tc = await run("npm", ["run", "typecheck"], { inherit: true });
    results.push({
      id: "typecheck",
      label: "npm run typecheck",
      status: tc.code === 0 ? "pass" : "fail",
      detail: tc.code === 0 ? undefined : `exit ${tc.code}`,
    });

    if (!opts.skipBuild) {
      console.log(`\n${COL.bold}npm run build${COL.reset}`);
      const b = await run("npm", ["run", "build"], { inherit: true });
      results.push({
        id: "build",
        label: "npm run build",
        status: b.code === 0 ? "pass" : "fail",
        detail: b.code === 0 ? undefined : `exit ${b.code}`,
      });
    } else {
      results.push({
        id: "build",
        label: "npm run build",
        status: "skip",
        detail: "--skip-build",
      });
    }

    if (!opts.skipSecrets) {
      console.log(`\n${COL.bold}npm run scan:secrets${COL.reset} ${COL.dim}(gitleaks)${COL.reset}`);
      const gl = await run("npm", ["run", "scan:secrets"], { inherit: false });
      if (gl.code === 0) {
        results.push({
          id: "secrets",
          label: "npm run scan:secrets",
          status: "pass",
        });
      } else {
        const combined = `${gl.out}\n${gl.err}`.toLowerCase();
        const missing =
          combined.includes("enoent") ||
          combined.includes("not found") ||
          combined.includes("gitleaks: command not found") ||
          /sh:\s*gitleaks:\s*not found/i.test(combined);
        if (missing) {
          console.log(
            `${COL.yellow}gitleaks not found or not on PATH — install: brew install gitleaks; then npm run setup:hooks${COL.reset}\n` +
              `${COL.dim}See docs/operations/pre-publish-secret-scan.md${COL.reset}`,
          );
          results.push({
            id: "secrets",
            label: "npm run scan:secrets",
            status: "warn",
            detail: "gitleaks not available — install and re-run (see pre-publish-secret-scan.md).",
          });
        } else {
          process.stdout.write(gl.out);
          process.stderr.write(gl.err);
          results.push({
            id: "secrets",
            label: "npm run scan:secrets",
            status: "fail",
            detail: `exit ${gl.code}`,
          });
        }
      }
    } else {
      results.push({
        id: "secrets",
        label: "npm run scan:secrets",
        status: "skip",
        detail: "--skip-secrets",
      });
    }

    if (opts.full) {
      console.log(`\n${COL.bold}npm test${COL.reset} ${COL.dim}(typecheck + smoke:keychain)${COL.reset}`);
      const t = await run("npm", ["test"], { inherit: true });
      results.push({
        id: "npm-test",
        label: "npm test",
        status: t.code === 0 ? "pass" : "fail",
        detail: t.code === 0 ? undefined : `exit ${t.code}`,
      });
    } else {
      results.push({
        id: "npm-test",
        label: "npm test",
        status: "skip",
        detail: "Run with --full to include npm test",
      });
    }
  } else {
    results.push({
      id: "typecheck",
      label: "npm run typecheck",
      status: "skip",
      detail: "node_modules missing",
    });
    results.push({
      id: "build",
      label: "npm run build",
      status: "skip",
      detail: "node_modules missing",
    });
    results.push({
      id: "secrets",
      label: "npm run scan:secrets",
      status: "skip",
      detail: "node_modules missing",
    });
    results.push({
      id: "npm-test",
      label: "npm test",
      status: "skip",
      detail: "node_modules missing",
    });
  }

  console.log(`\n${COL.bold}── Manual steps (human)${COL.reset}`);
  console.log(`  • ${COL.dim}Fill Plaid Sandbox vars in .env.local (minimal path can omit LLM keys).${COL.reset}`);
  console.log(`  • ${COL.dim}npm run dev — complete Plaid Link; sync accounts.${COL.reset}`);
  console.log(`  • ${COL.dim}(Optional) Add an LLM key — category review, briefings, chat.${COL.reset}`);

  const finishedAt = new Date();
  let gitBranch = "";
  let gitRemote = "";
  try {
    const b = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      inherit: false,
    });
    if (b.code === 0) gitBranch = b.out.trim();
  } catch { /* no git */ }
  try {
    const u = await run("git", ["remote", "get-url", "origin"], { inherit: false });
    if (u.code === 0) gitRemote = u.out.trim();
  } catch { /* no git */ }

  const npmVersion = await run("npm", ["-v"], { inherit: false }).then(
    (r) => (r.code === 0 ? r.out.trim() : ""),
    () => "",
  );

  const summaryLine = results
    .map((r) => `${r.id}:${r.status}`)
    .join(", ");

  const signOff = `### Clean-machine sign-off

_Paste into an issue or PR comment when recording a clean-machine sign-off. Fill timing and platform if needed._

| Field | Value |
|-------|-------|
| Date (UTC) | ${startedAt.toISOString().slice(0, 10)} |
| Machine OS | ${process.platform} (${process.arch}) |
| Clone path | \`${ROOT}\` |
| Git branch | ${gitBranch || "_unknown_"} |
| origin URL | ${gitRemote || "_unknown_"} |
| Node | ${process.version} (npm ${npmVersion || "?"}) |
| Onboard started | ${startedAt.toISOString()} |
| Onboard finished | ${finishedAt.toISOString()} |
| Minutes (CLI wall) | ${Math.round((finishedAt - startedAt) / 60000)} |
| Automated steps | ${summaryLine} |
| Plaid Link + sync | _done / pending — confirm manually_ |
| Notes | |

`;

  console.log(`\n${COL.bold}── Sign-off block (copy below)${COL.reset}\n`);
  console.log(signOff);

  const hasFail = results.some((r) => r.status === "fail");
  const badEngine = results.some(
    (r) => r.id === "node-engine" && r.status === "fail",
  );
  if (badEngine || hasFail) {
    console.log(
      `${COL.red}Onboard finished with failures — fix above before sign-off.${COL.reset}\n`,
    );
    process.exit(1);
  }
  console.log(`${COL.green}Onboard preflight complete.${COL.reset}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
