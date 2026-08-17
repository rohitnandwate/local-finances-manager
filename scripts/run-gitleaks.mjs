/**
 * Run gitleaks with repo config. Used by npm scripts, pre-commit hook, and CI.
 *
 * Usage:
 *   node scripts/run-gitleaks.mjs --detect     # full repo + history (default)
 *   node scripts/run-gitleaks.mjs --staged     # staged changes only (pre-commit)
 *
 * Skip (emergency only): SKIP_SECRET_SCAN=1
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG = path.join(ROOT, ".gitleaks.toml");

/** Pin for local install hints; keep in sync with .github/workflows/ci.yml */
const GITLEAKS_VERSION = "8.24.3";

function printInstallHint() {
  console.error(`
gitleaks is not installed or not on PATH.

Install (macOS):  brew install gitleaks
Install (Linux):  see https://github.com/gitleaks/gitleaks#installing
Suggested pin:    v${GITLEAKS_VERSION} (matches CI)

Then enable the pre-commit hook:  npm run setup:hooks
`);
}

function parseMode(argv) {
  if (argv.includes("--staged")) return "staged";
  if (argv.includes("--detect")) return "detect";
  if (argv.includes("-h") || argv.includes("--help")) return "help";
  return "detect";
}

function printHelp() {
  console.log(`run-gitleaks — secret scan via gitleaks

  node scripts/run-gitleaks.mjs --detect   Full repository scan (npm run scan:secrets)
  node scripts/run-gitleaks.mjs --staged     Staged files only (pre-commit hook)

  SKIP_SECRET_SCAN=1   Skip scan (avoid except emergencies; prefer git commit --no-verify)
`);
}

function main() {
  const mode = parseMode(process.argv.slice(2));
  if (mode === "help") {
    printHelp();
    return;
  }

  if (process.env.SKIP_SECRET_SCAN === "1") {
    console.warn("run-gitleaks: SKIP_SECRET_SCAN=1 — scan skipped.");
    return;
  }

  const which = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  if (which.status !== 0) {
    printInstallHint();
    process.exit(1);
  }

  const args =
    mode === "staged"
      ? [
          "protect",
          "--staged",
          "--redact",
          "--config",
          CONFIG,
          "--verbose",
          "--exit-code",
          "1",
        ]
      : [
          "detect",
          "--redact",
          "--config",
          CONFIG,
          "--verbose",
          "--exit-code",
          "1",
        ];

  const run = spawnSync("gitleaks", args, {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (run.status !== 0) {
    if (mode === "staged") {
      console.error(`
Secret scan failed on staged changes.

- Remove or redact the reported secret before committing.
- False positive? Add a narrow allowlist in .gitleaks.toml and explain in your PR.
- Emergency bypass: git commit --no-verify  (not recommended)
`);
    }
    process.exit(run.status ?? 1);
  }
}

main();
