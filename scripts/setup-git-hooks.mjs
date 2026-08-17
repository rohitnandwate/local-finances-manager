/**
 * Point this clone's git hooks at .githooks/ (pre-commit secret scan).
 *
 * Usage: npm run setup:hooks
 */

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(ROOT, ".githooks");
const PRE_COMMIT = path.join(HOOKS_DIR, "pre-commit");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${r.stderr?.trim() || r.stdout?.trim() || r.status}`,
    );
  }
  return r.stdout?.trim() ?? "";
}

async function main() {
  try {
    await access(PRE_COMMIT);
  } catch {
    console.error("setup-git-hooks: missing .githooks/pre-commit");
    process.exit(1);
  }

  run("git", ["rev-parse", "--is-inside-work-tree"]);

  run("git", ["config", "core.hooksPath", ".githooks"]);

  const hooksPath = run("git", ["config", "--get", "core.hooksPath"]);
  console.log(`Git hooks enabled: core.hooksPath=${hooksPath}`);
  console.log("Pre-commit will run: npm run scan:secrets:staged");
  console.log("");
  console.log("Requires gitleaks on PATH (brew install gitleaks).");
  console.log("Bypass once: SKIP_SECRET_SCAN=1 git commit …");
  console.log("Bypass hook: git commit --no-verify");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
