#!/usr/bin/env node
/**
 * One-time repair: re-stores Keychain tokens with the default ACL
 * (replacing entries that used -T "" which blocks non-interactive reads).
 *
 * Run from the project root:  node scripts/repair-keychain-acl.mjs
 *
 * For each Plaid item in the session file, macOS will show a password dialog
 * to read the current token. Enter your password to allow the read, then the
 * script re-stores the token with a permissive ACL.
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const SERVICE = "budget-expense-tracker";
const SECURITY = "/usr/bin/security";
const SESSION_PATH = path.resolve(".data/plaid-session.json");

function readToken(itemId) {
  return execFileSync(SECURITY, [
    "find-generic-password",
    "-s", SERVICE,
    "-a", itemId,
    "-w",
  ]).toString().trim();
}

function deleteToken(itemId) {
  try {
    execFileSync(SECURITY, ["delete-generic-password", "-s", SERVICE, "-a", itemId]);
  } catch { /* entry may not exist */ }
}

function storeToken(itemId, token) {
  execFileSync(SECURITY, [
    "add-generic-password",
    "-s", SERVICE,
    "-a", itemId,
    "-w", token,
    "-U",
  ]);
}

async function main() {
  const raw = await readFile(SESSION_PATH, "utf8");
  const state = JSON.parse(raw);
  const items = state.items ?? [];

  if (items.length === 0) {
    console.log("No items in session file. Nothing to repair.");
    return;
  }

  console.log(`Found ${items.length} item(s). Each token read will prompt for your macOS password.\n`);

  let repaired = 0;
  for (const item of items) {
    const id = item.itemId;
    const name = item.institutionName ?? id;
    console.log(`[${name}] Reading token from Keychain (enter password when prompted)...`);
    try {
      const token = readToken(id);
      deleteToken(id);
      storeToken(id, token);
      console.log(`[${name}] Repaired — token re-stored with default ACL.\n`);
      repaired++;
    } catch (error) {
      console.error(`[${name}] Failed — ${error.message}`);
      console.error(`  You may need to re-link this account.\n`);
    }
  }

  console.log(`Done. Repaired ${repaired}/${items.length} token(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
