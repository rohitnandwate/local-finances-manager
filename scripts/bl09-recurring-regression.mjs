#!/usr/bin/env node
/**
 * BL09 Recurring Transactions — regression test (local detection)
 *
 * Validates the /api/recurring endpoint against real session data.
 * The endpoint now runs DuckDB-based local pattern detection (no Plaid call).
 *
 * Usage:  node scripts/bl09-recurring-regression.mjs
 *         PORT=3001 node scripts/bl09-recurring-regression.mjs
 */

const PORT = Number(process.env.PORT ?? "3000");
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

const results = [];
function pass(name) { results.push(`PASS: ${name}`); }
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(urlPath, options) {
  const url = `${BASE_URL}${urlPath}`;
  const response = await fetch(url, options);
  const body = await response.json();
  return { ok: response.ok, status: response.status, body };
}

async function run() {
  // 0) Verify server is reachable
  let health;
  try {
    health = await requestJson("/api/health");
  } catch (error) {
    console.error(`Cannot reach server at ${BASE_URL}. Is the dev server running?`);
    process.exitCode = 1;
    return;
  }
  assert(health.ok, "Health endpoint should return 200");
  assert(health.body?.sessions?.hasSessions, "At least one session should exist");

  const sessionCount = health.body.sessions.sessionCount;
  console.log(`Server healthy — ${sessionCount} linked institution(s)\n`);

  // 1) /api/recurring returns 200 with local detection shape
  const res = await requestJson("/api/recurring");
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  assert(Array.isArray(res.body?.streams), "Response must have streams array");
  assert(typeof res.body?.totals === "object", "Response must have totals object");
  assert(typeof res.body?.detectedAt === "string", "Response must have detectedAt string");
  assert(typeof res.body?.period === "object", "Response must have period object");
  assert(typeof res.body.period.from === "string", "period.from must be string");
  assert(typeof res.body.period.to === "string", "period.to must be string");
  pass(`/api/recurring returns ${res.body.streams.length} stream(s)`);

  // 2) Totals have the required fields
  const t = res.body.totals;
  assert(typeof t.activeInflowCount === "number", "activeInflowCount must be number");
  assert(typeof t.activeOutflowCount === "number", "activeOutflowCount must be number");
  pass("Totals structure is valid");

  // 3) Each stream has the required local detection fields (including streamType)
  const outflows = res.body.streams.filter((s) => s.direction === "outflow");
  const inflows = res.body.streams.filter((s) => s.direction === "inflow");
  const recurring = res.body.streams.filter((s) => s.streamType === "recurring");
  const frequent = res.body.streams.filter((s) => s.streamType === "frequent");

  for (const stream of res.body.streams) {
    assert(typeof stream.streamKey === "string", "stream.streamKey must be string");
    assert(typeof stream.name === "string", "stream.name must be string");
    assert(typeof stream.accountId === "string", "stream.accountId must be string");
    assert(["inflow", "outflow"].includes(stream.direction), "stream.direction must be inflow or outflow");
    assert(typeof stream.frequency === "string", "stream.frequency must be string");
    assert(typeof stream.averageAmount === "number", "stream.averageAmount must be number");
    assert(typeof stream.lastAmount === "number", "stream.lastAmount must be number");
    assert(typeof stream.transactionCount === "number", "stream.transactionCount must be number");
    assert(stream.transactionCount >= 3, `stream.transactionCount must be >= 3, got ${stream.transactionCount}`);
    assert(typeof stream.medianIntervalDays === "number", "stream.medianIntervalDays must be number");
    assert(typeof stream.isActive === "boolean", "stream.isActive must be boolean");
    assert(typeof stream.firstDate === "string", "stream.firstDate must be string");
    assert(typeof stream.lastDate === "string", "stream.lastDate must be string");
    assert(typeof stream.windowTxnCount === "number", "stream.windowTxnCount must be number");
    assert(typeof stream.windowAvgAmount === "number", "stream.windowAvgAmount must be number");
    assert(typeof stream.windowLastAmount === "number", "stream.windowLastAmount must be number");
    assert(["recurring", "frequent"].includes(stream.streamType),
      `stream.streamType must be recurring or frequent, got "${stream.streamType}"`);
  }
  pass("All streams have valid local detection structure");

  // 4) frequentTotals is present and valid
  const ft = res.body.frequentTotals;
  assert(typeof ft === "object", "Response must have frequentTotals object");
  assert(typeof ft.activeOutflowCount === "number", "frequentTotals.activeOutflowCount must be number");
  assert(typeof ft.merchantCount === "number", "frequentTotals.merchantCount must be number");
  pass("frequentTotals structure is valid");

  // 5) At least some streams detected, with both types present
  console.log(`\n  Recurring: ${recurring.length} (${recurring.filter(s=>s.direction==="outflow").length} out + ${recurring.filter(s=>s.direction==="inflow").length} in)`);
  console.log(`  Frequent:  ${frequent.length} (${frequent.filter(s=>s.direction==="outflow").length} out + ${frequent.filter(s=>s.direction==="inflow").length} in)`);
  console.log(`  Active recurring: ${t.activeOutflowCount} outflows, ${t.activeInflowCount} inflows`);
  console.log(`  Frequent merchants: ${ft.merchantCount}, active: ${ft.activeOutflowCount}`);
  if (t.estimatedMonthlyOutflow != null) {
    console.log(`  Est. monthly outflow: $${t.estimatedMonthlyOutflow.toFixed(2)}`);
  }
  if (t.estimatedMonthlyInflow != null) {
    console.log(`  Est. monthly inflow: $${t.estimatedMonthlyInflow.toFixed(2)}`);
  }
  if (ft.totalWindowOutflow != null) {
    console.log(`  Frequent window spend: $${ft.totalWindowOutflow.toFixed(2)}`);
  }

  assert(res.body.streams.length > 0,
    "At least one stream should be detected from real transaction data");
  assert(recurring.length > 0, "At least one recurring stream should exist");
  assert(frequent.length > 0, "At least one frequent stream should exist");
  assert(recurring.length + frequent.length === res.body.streams.length,
    "All streams must be classified as recurring or frequent");
  pass(`${recurring.length} recurring + ${frequent.length} frequent streams detected`);

  // 5) Frequency classification is valid
  const validFrequencies = new Set(["FREQUENT", "WEEKLY", "BIWEEKLY", "MONTHLY", "BIMONTHLY", "ANNUALLY", "IRREGULAR"]);
  for (const stream of res.body.streams) {
    assert(validFrequencies.has(stream.frequency),
      `Invalid frequency "${stream.frequency}" for stream "${stream.name}"`);
  }
  pass("All streams have valid frequency classification");

  // 6) Recurring export endpoint works
  const exportRes = await requestJson("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recurring-streams", from: null, to: null }),
  });
  assert(exportRes.status === 200, `Export endpoint should return 200, got ${exportRes.status}`);
  assert(typeof exportRes.body?.filePath === "string", "Export should return filePath");
  assert(typeof exportRes.body?.rowCount === "number", "Export should return rowCount");
  assert(exportRes.body.rowCount > 0, "Export should have at least one row");
  pass(`Recurring streams export produced ${exportRes.body.rowCount} rows`);

  // 7) Stream transactions drill-down
  const sampleStream = res.body.streams[0];
  const txnUrl = `/api/recurring/transactions?streamKey=${encodeURIComponent(sampleStream.streamKey)}`;
  const txnRes = await requestJson(txnUrl);
  assert(txnRes.status === 200, `Transactions endpoint should return 200, got ${txnRes.status}`);
  assert(Array.isArray(txnRes.body?.transactions), "Response must have transactions array");
  assert(txnRes.body.transactions.length > 0, "Should have at least one transaction");
  const txn = txnRes.body.transactions[0];
  assert(typeof txn.date === "string", "transaction.date must be string");
  assert(typeof txn.amount === "number", "transaction.amount must be number");
  assert(typeof txn.name === "string", "transaction.name must be string");
  pass(`Stream transactions endpoint returns ${txnRes.body.transactions.length} rows for "${sampleStream.name}"`);

  // 7.5) Window-filtered transactions should be <= all transactions
  const windowTxnUrl = `${txnUrl}&from=${res.body.period.from}&to=${res.body.period.to}`;
  const windowTxnRes = await requestJson(windowTxnUrl);
  assert(windowTxnRes.status === 200, "Window transactions should return 200");
  assert(windowTxnRes.body.transactions.length <= txnRes.body.transactions.length,
    "Window transactions should be <= all transactions");
  pass("Window-filtered transactions are a subset of all transactions");

  // 8) Health endpoint should NOT leak financial data (security regression)
  const healthItems = health.body.sessions.items;
  for (const item of healthItems) {
    assert(item.accounts === undefined, `Health response should not include accounts for ${item.institutionName}`);
    assert(item.recentTransactions === undefined, `Health response should not include recentTransactions for ${item.institutionName}`);
  }
  pass("Health endpoint does not leak account/transaction data");

  // 8) File endpoint should be gated (security regression)
  const filesRes = await requestJson("/api/files");
  assert(filesRes.status === 403, `File endpoint should return 403 without DEBUG_FILES, got ${filesRes.status}`);
  pass("File endpoint returns 403 without DEBUG_FILES");

  console.log(`\nBL09 recurring regression passed (${results.length} checks):`);
  for (const line of results) {
    console.log(` - ${line}`);
  }
}

run().catch((error) => {
  console.error("\nBL09 recurring regression FAILED:");
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
