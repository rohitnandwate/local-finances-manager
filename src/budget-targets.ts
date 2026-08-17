import { readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { getOverridesMap } from "./override-store.js";
import type { StoredSession, StoredTransactionSnapshot } from "./storage.js";

const BUDGET_FILE_PATH = path.resolve("context", "budgets.yml");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type BudgetCadence = "daily" | "weekly" | "monthly" | "yearly";

const KNOWN_PFC_PRIMARY_CATEGORIES = new Set([
  "INCOME",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "LOAN_PAYMENTS",
  "BANK_FEES",
  "ENTERTAINMENT",
  "FOOD_AND_DRINK",
  "GENERAL_MERCHANDISE",
  "HOME_IMPROVEMENT",
  "MEDICAL",
  "PERSONAL_CARE",
  "GENERAL_SERVICES",
  "GOVERNMENT_AND_NON_PROFIT",
  "TRANSPORTATION",
  "TRAVEL",
  "RENT_AND_UTILITIES",
]);

type BudgetDefinition = {
  id: string;
  category: string;
  amount: number;
  cadence: BudgetCadence;
  effectiveStart: string;
  effectiveEnd: string | null;
  note: string | null;
};

type ValidationIssue = {
  level: "error" | "warning";
  code: string;
  path: string;
  message: string;
};

type ParsedBudgetFile = {
  filePath: string;
  definitions: BudgetDefinition[];
  issues: ValidationIssue[];
};

export type BudgetReviewItem = {
  category: string;
  expected: number;
  actual: number;
  variance: number;
  progressPct: number;
  status: "under" | "over" | "on_track";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function parseDateToUtc(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function formatDateUtc(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function dateInRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

function cadenceToDaily(amount: number, cadence: BudgetCadence): number {
  switch (cadence) {
    case "daily":
      return amount;
    case "weekly":
      return amount / 7;
    case "monthly":
      return (amount * 12) / 365;
    case "yearly":
      return amount / 365;
  }
}

function normalizeCategory(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeDefinition(
  raw: unknown,
  index: number,
  issues: ValidationIssue[],
): BudgetDefinition | null {
  const pathPrefix = `budgets[${index}]`;
  if (!isRecord(raw)) {
    issues.push({
      level: "error",
      code: "invalid_item",
      path: pathPrefix,
      message: "Each budget entry must be an object.",
    });
    return null;
  }

  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : `${normalizeCategory(String(raw.category ?? "")) || "UNKNOWN"}-${index + 1}`;
  const category =
    typeof raw.category === "string" ? normalizeCategory(raw.category) : "";
  const amount = typeof raw.amount === "number" ? raw.amount : NaN;
  const cadence = typeof raw.cadence === "string" ? raw.cadence.trim() : "";
  const effectiveStart =
    typeof raw.effectiveStart === "string" ? raw.effectiveStart.trim() : "";
  const effectiveEnd =
    typeof raw.effectiveEnd === "string" ? raw.effectiveEnd.trim() : null;
  const note = typeof raw.note === "string" ? raw.note : null;

  if (!category) {
    issues.push({
      level: "error",
      code: "missing_category",
      path: `${pathPrefix}.category`,
      message: "Category is required.",
    });
  }
  if (!Number.isFinite(amount) || amount < 0) {
    issues.push({
      level: "error",
      code: "invalid_amount",
      path: `${pathPrefix}.amount`,
      message: "Amount must be a non-negative number.",
    });
  }

  const validCadence: BudgetCadence[] = ["daily", "weekly", "monthly", "yearly"];
  if (!validCadence.includes(cadence as BudgetCadence)) {
    issues.push({
      level: "error",
      code: "invalid_cadence",
      path: `${pathPrefix}.cadence`,
      message: "Cadence must be one of: daily, weekly, monthly, yearly.",
    });
  }
  if (!isValidDate(effectiveStart)) {
    issues.push({
      level: "error",
      code: "invalid_effective_start",
      path: `${pathPrefix}.effectiveStart`,
      message: "effectiveStart must be a valid YYYY-MM-DD date.",
    });
  }
  if (effectiveEnd !== null && effectiveEnd !== "" && !isValidDate(effectiveEnd)) {
    issues.push({
      level: "error",
      code: "invalid_effective_end",
      path: `${pathPrefix}.effectiveEnd`,
      message: "effectiveEnd must be a valid YYYY-MM-DD date when provided.",
    });
  }
  if (
    isValidDate(effectiveStart) &&
    effectiveEnd &&
    isValidDate(effectiveEnd) &&
    effectiveStart > effectiveEnd
  ) {
    issues.push({
      level: "error",
      code: "invalid_range",
      path: pathPrefix,
      message: "effectiveStart must be earlier than or equal to effectiveEnd.",
    });
  }

  if (
    !category ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    !validCadence.includes(cadence as BudgetCadence) ||
    !isValidDate(effectiveStart) ||
    (effectiveEnd !== null && effectiveEnd !== "" && !isValidDate(effectiveEnd))
  ) {
    return null;
  }

  return {
    id,
    category,
    amount,
    cadence: cadence as BudgetCadence,
    effectiveStart,
    effectiveEnd: effectiveEnd && effectiveEnd.length > 0 ? effectiveEnd : null,
    note,
  };
}

function detectOverlaps(
  definitions: BudgetDefinition[],
  issues: ValidationIssue[],
): void {
  const byCategory = new Map<string, BudgetDefinition[]>();
  for (const definition of definitions) {
    const current = byCategory.get(definition.category) ?? [];
    current.push(definition);
    byCategory.set(definition.category, current);
  }

  for (const [category, entries] of byCategory.entries()) {
    entries.sort((a, b) => a.effectiveStart.localeCompare(b.effectiveStart));
    let previous: BudgetDefinition | null = null;
    for (const entry of entries) {
      if (!previous) {
        previous = entry;
        continue;
      }
      const previousEnd = previous.effectiveEnd ?? "9999-12-31";
      if (entry.effectiveStart <= previousEnd) {
        issues.push({
          level: "error",
          code: "overlap",
          path: `budgets.${category}`,
          message: `Overlapping windows detected for category ${category} between ${previous.id} and ${entry.id}.`,
        });
      }
      previous = entry;
    }
  }
}

function detectUnknownCategories(
  definitions: BudgetDefinition[],
  issues: ValidationIssue[],
): void {
  for (const definition of definitions) {
    if (!KNOWN_PFC_PRIMARY_CATEGORIES.has(definition.category)) {
      issues.push({
        level: "warning",
        code: "unknown_category",
        path: `budgets.${definition.id}.category`,
        message: `Category ${definition.category} is not in the known Plaid primary category set.`,
      });
    }
  }
}

async function parseBudgetFile(): Promise<ParsedBudgetFile> {
  const issues: ValidationIssue[] = [];
  let raw: string;
  try {
    raw = await readFile(BUDGET_FILE_PATH, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push({
        level: "error",
        code: "file_missing",
        path: "context/budgets.yml",
        message: "Budget file is missing. Create context/budgets.yml first.",
      });
      return { filePath: BUDGET_FILE_PATH, definitions: [], issues };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    issues.push({
      level: "error",
      code: "yaml_parse_error",
      path: "context/budgets.yml",
      message: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { filePath: BUDGET_FILE_PATH, definitions: [], issues };
  }

  if (!isRecord(parsed)) {
    issues.push({
      level: "error",
      code: "invalid_root",
      path: "context/budgets.yml",
      message: "Root document must be an object with a `budgets` array.",
    });
    return { filePath: BUDGET_FILE_PATH, definitions: [], issues };
  }

  const budgets = Array.isArray(parsed.budgets) ? parsed.budgets : null;
  if (!budgets) {
    issues.push({
      level: "error",
      code: "missing_budgets_array",
      path: "budgets",
      message: "Expected top-level `budgets` array.",
    });
    return { filePath: BUDGET_FILE_PATH, definitions: [], issues };
  }

  const definitions = budgets
    .map((item, index) => normalizeDefinition(item, index, issues))
    .filter((item): item is BudgetDefinition => item !== null);

  detectOverlaps(definitions, issues);
  detectUnknownCategories(definitions, issues);

  return {
    filePath: BUDGET_FILE_PATH,
    definitions,
    issues,
  };
}

function transactionCategory(
  transaction: StoredTransactionSnapshot,
  overrideCategory: string | undefined,
): string | null {
  return overrideCategory ?? transaction.personalFinanceCategoryPrimary;
}

function shouldCountAsSpend(transaction: StoredTransactionSnapshot): boolean {
  if (transaction.pending) {
    return false;
  }
  if (typeof transaction.amount !== "number") {
    return false;
  }
  if (transaction.amount <= 0) {
    return false;
  }
  return true;
}

export function getCurrentWeekRange(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setDate(now.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  const end = addDays(start, 6);
  return {
    from: formatDateUtc(start),
    to: formatDateUtc(end),
  };
}

export async function validateBudgetDefinitions(): Promise<{
  valid: boolean;
  filePath: string;
  issues: ValidationIssue[];
  definitions: BudgetDefinition[];
}> {
  const parsed = await parseBudgetFile();
  return {
    valid: !parsed.issues.some((issue) => issue.level === "error"),
    filePath: parsed.filePath,
    issues: parsed.issues,
    definitions: parsed.definitions,
  };
}

function buildExpectedBudgetByCategory(
  definitions: BudgetDefinition[],
  from: string,
  to: string,
): Map<string, number> {
  const totals = new Map<string, number>();
  const start = parseDateToUtc(from);
  const end = parseDateToUtc(to);
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    const currentDate = formatDateUtc(cursor);
    for (const definition of definitions) {
      const rangeEnd = definition.effectiveEnd ?? "9999-12-31";
      if (!dateInRange(currentDate, definition.effectiveStart, rangeEnd)) {
        continue;
      }
      const daily = cadenceToDaily(definition.amount, definition.cadence);
      const running = totals.get(definition.category) ?? 0;
      totals.set(definition.category, running + daily);
    }
  }
  return totals;
}

function hasActiveDefinitionInWindow(
  category: string,
  definitions: BudgetDefinition[],
  from: string,
  to: string,
): boolean {
  return definitions.some((definition) => {
    if (definition.category !== category) {
      return false;
    }
    const end = definition.effectiveEnd ?? "9999-12-31";
    return definition.effectiveStart <= to && end >= from;
  });
}

export async function buildBudgetReview(
  sessions: StoredSession[],
  from: string,
  to: string,
): Promise<{
  from: string;
  to: string;
  validation: {
    valid: boolean;
    filePath: string;
    issues: ValidationIssue[];
    definitionCount: number;
  };
  totals: {
    totalExpected: number;
    totalActual: number;
    overCategories: number;
    onTrackCategories: number;
  };
  items: BudgetReviewItem[];
}> {
  const validation = await validateBudgetDefinitions();
  if (!validation.valid) {
    return {
      from,
      to,
      validation: {
        valid: false,
        filePath: validation.filePath,
        issues: validation.issues,
        definitionCount: validation.definitions.length,
      },
      totals: {
        totalExpected: 0,
        totalActual: 0,
        overCategories: 0,
        onTrackCategories: 0,
      },
      items: [],
    };
  }

  const overrides = await getOverridesMap();
  const actualByCategory = new Map<string, number>();
  for (const session of sessions) {
    for (const transaction of session.transactions) {
      if (!shouldCountAsSpend(transaction)) {
        continue;
      }
      const effectiveDate = transaction.date ?? transaction.authorizedDate;
      if (!effectiveDate || !dateInRange(effectiveDate, from, to)) {
        continue;
      }
      const override = overrides[transaction.id];
      const category = transactionCategory(transaction, override?.overridePrimary);
      if (!category || category === "TRANSFER_IN" || category === "TRANSFER_OUT") {
        continue;
      }
      const running = actualByCategory.get(category) ?? 0;
      actualByCategory.set(category, running + (transaction.amount ?? 0));
    }
  }

  const expectedByCategory = buildExpectedBudgetByCategory(
    validation.definitions,
    from,
    to,
  );
  const runtimeIssues: ValidationIssue[] = [...validation.issues];
  for (const category of actualByCategory.keys()) {
    if (!hasActiveDefinitionInWindow(category, validation.definitions, from, to)) {
      runtimeIssues.push({
        level: "warning",
        code: "unbudgeted_category",
        path: `budgets.${category}`,
        message: `No active budget definition covers category ${category} for the selected window.`,
      });
    }
  }
  const categories = new Set<string>([
    ...expectedByCategory.keys(),
    ...actualByCategory.keys(),
  ]);

  const items = [...categories]
    .map((category) => {
      const expectedRaw = expectedByCategory.get(category) ?? 0;
      const actualRaw = actualByCategory.get(category) ?? 0;
      const expected = Math.round(expectedRaw * 100) / 100;
      const actual = Math.round(actualRaw * 100) / 100;
      const variance = Math.round((actual - expected) * 100) / 100;
      const progressPct =
        expected === 0 ? (actual > 0 ? 100 : 0) : Math.round((actual / expected) * 1000) / 10;
      const status: BudgetReviewItem["status"] =
        variance > 0 ? "over" : variance < 0 ? "under" : "on_track";
      return {
        category,
        expected,
        actual,
        variance,
        progressPct,
        status,
      };
    })
    .sort((a, b) => b.actual - a.actual || a.category.localeCompare(b.category));

  const totalExpected = items.reduce((sum, item) => sum + item.expected, 0);
  const totalActual = items.reduce((sum, item) => sum + item.actual, 0);

  return {
    from,
    to,
    validation: {
      valid: true,
      filePath: validation.filePath,
      issues: runtimeIssues,
      definitionCount: validation.definitions.length,
    },
    totals: {
      totalExpected: Math.round(totalExpected * 100) / 100,
      totalActual: Math.round(totalActual * 100) / 100,
      overCategories: items.filter((item) => item.status === "over").length,
      onTrackCategories: items.filter((item) => item.status !== "over").length,
    },
    items,
  };
}
