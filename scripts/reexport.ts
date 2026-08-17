import { readSessions } from "../src/storage.js";
import { generateExport, type ExportType } from "../src/export.js";

async function main() {
  const sessions = await readSessions();
  console.log(
    `Sessions: ${sessions.length}, Total txns: ${sessions.reduce((s, x) => s + x.transactions.length, 0)}`,
  );

  const types: ExportType[] = [
    "transactions-all",
    "category-summary",
    "income-expense-summary",
    "transfer-pairs",
    "transfers-all",
  ];

  for (const type of types) {
    const result = await generateExport(sessions, {
      type,
      from: "2025-07-01",
      to: "2026-04-07",
    });
    console.log(`${type}: ${result.rowCount} rows -> ${result.filePath}`);
  }
}

main();
