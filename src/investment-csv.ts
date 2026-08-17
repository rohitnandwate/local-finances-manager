import type { CsvHoldingInput } from "./investment-store.js";

type ParsedFile = {
  delimiter: "," | "\t";
  rows: string[][];
};

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\(/g, "-")
    .replace(/\)/g, "")
    .replace(/%/g, "")
    .trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDelimited(content: string, delimiter: "," | "\t"): ParsedFile {
  const rows: string[][] = [];
  let currentField = "";
  let currentRow: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    currentRow.push(currentField.trim());
    currentField = "";
  };
  const pushRow = () => {
    if (currentRow.length > 1 || currentRow[0] !== "") {
      rows.push(currentRow);
    }
    currentRow = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    const nextChar = index + 1 < content.length ? content[index + 1] : "";

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        currentField += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      pushField();
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      pushField();
      pushRow();
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    pushField();
    pushRow();
  }

  return {
    delimiter,
    rows,
  };
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function detectDelimiter(content: string): "," | "\t" {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function findHeaderRow(rows: string[][]): {
  headerRowIndex: number;
  headerMap: Map<string, number>;
} {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const headerMap = new Map<string, number>();
    row.forEach((value, colIndex) => {
      headerMap.set(normalizeHeader(value), colIndex);
    });
    const hasSymbol = headerMap.has("symbol");
    const hasDescription = headerMap.has("description");
    const hasQuantity = headerMap.has("quantity");
    const hasAccount = headerMap.has("account") || headerMap.has("account name");
    const hasValue = headerMap.has("total value") || headerMap.has("current value");
    const hasPrice = headerMap.has("price") || headerMap.has("last price");

    if (hasSymbol && hasDescription && hasQuantity && hasAccount && (hasValue || hasPrice)) {
      return { headerRowIndex: index, headerMap };
    }
  }

  throw new Error(
    "Could not detect Fidelity holdings header row. Expected columns like Symbol, Description, Account, Quantity, Price/Last Price, and Total Value/Current Value.",
  );
}

function getHeaderValue(
  row: string[],
  headerMap: Map<string, number>,
  aliases: string[],
): string {
  for (const alias of aliases) {
    const index = headerMap.get(alias);
    if (typeof index === "number") {
      return row[index] ?? "";
    }
  }
  return "";
}

export function parseFidelityHoldingsFile(content: string, institutionName?: string): {
  rows: CsvHoldingInput[];
  warnings: string[];
} {
  const delimiter = detectDelimiter(content);
  const parsed = parseDelimited(content, delimiter);
  if (parsed.rows.length === 0) {
    throw new Error("CSV file appears empty or missing headers.");
  }

  const { headerRowIndex, headerMap } = findHeaderRow(parsed.rows);

  const warnings: string[] = [];
  const rows: CsvHoldingInput[] = [];

  for (let rowIndex = headerRowIndex + 1; rowIndex < parsed.rows.length; rowIndex += 1) {
    const row = parsed.rows[rowIndex]!;
    const symbol = getHeaderValue(row, headerMap, ["symbol"]).trim();
    const description = getHeaderValue(row, headerMap, ["description"]).trim();
    const accountName = getHeaderValue(row, headerMap, ["account name", "account"]).trim();
    const quantity = parseNumber(getHeaderValue(row, headerMap, ["quantity"]));
    const lastPrice = parseNumber(getHeaderValue(row, headerMap, ["last price", "price"]));
    const currentValue = parseNumber(getHeaderValue(row, headerMap, ["current value", "total value"]));
    const costBasisPerShare = parseNumber(
      getHeaderValue(row, headerMap, ["cost basis per share", "average cost basis"]),
    );
    const totalCostBasisRaw = parseNumber(
      getHeaderValue(row, headerMap, ["cost basis total"]),
    );
    const totalGainLoss = parseNumber(getHeaderValue(row, headerMap, ["total gain loss", "total gain loss dollar"]));
    const investmentType = getHeaderValue(row, headerMap, ["investment type"]).trim();

    if (!symbol && !description && !accountName) {
      continue;
    }
    if (
      symbol.toLowerCase().includes("the data and information in this spreadsheet") ||
      description.toLowerCase().includes("the data and information in this spreadsheet")
    ) {
      continue;
    }

    if (!accountName) {
      warnings.push(`Row ${rowIndex + 1} skipped: Account is empty.`);
      continue;
    }
    if (!symbol && !description) {
      warnings.push(`Row ${rowIndex + 1} skipped: Symbol and Description are both empty.`);
      continue;
    }
    if (
      quantity === null &&
      lastPrice === null &&
      currentValue === null &&
      !investmentType
    ) {
      warnings.push(`Row ${rowIndex + 1} skipped: no numeric position values found.`);
      continue;
    }

    let totalCostBasis: number | null = null;
    if (totalCostBasisRaw !== null) {
      totalCostBasis = totalCostBasisRaw;
    } else if (currentValue !== null && totalGainLoss !== null) {
      totalCostBasis = currentValue - totalGainLoss;
    } else if (costBasisPerShare !== null && quantity !== null) {
      totalCostBasis = costBasisPerShare * quantity;
    }

    rows.push({
      institutionName: institutionName ?? "Fidelity",
      accountName,
      accountMask: null,
      symbol: symbol || null,
      securityName: description || null,
      quantity,
      currentPrice: lastPrice,
      currentValue,
      costBasisPerShare,
      totalCostBasis,
      isoCurrencyCode: "USD",
    });
  }

  if (rows.length === 0) {
    throw new Error(
      "No valid holdings rows found after parsing. Check Fidelity export headers and values.",
    );
  }

  return { rows, warnings };
}
