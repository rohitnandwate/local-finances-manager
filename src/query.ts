import duckdb from "duckdb";
import path from "node:path";

const EXPORTS_DIR = path.resolve("exports");

type DuckDbRow = Record<string, unknown>;

function getDb(): duckdb.Database {
  return new duckdb.Database(":memory:");
}

function coerceBigInts(row: DuckDbRow): DuckDbRow {
  const out: DuckDbRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out;
}

function query(db: duckdb.Database, sql: string): Promise<DuckDbRow[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (error: Error | null, rows: DuckDbRow[]) => {
      if (error) reject(error);
      else resolve((rows ?? []).map(coerceBigInts));
    });
  });
}

function closeDb(db: duckdb.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function tsvPath(filename: string): string {
  return path.join(EXPORTS_DIR, filename).replace(/\\/g, "/");
}

function dateFilter(
  column: string,
  from: string | null,
  to: string | null,
): string {
  const clauses: string[] = [];
  if (from) clauses.push(`${column} >= '${from}'`);
  if (to) clauses.push(`${column} <= '${to}'`);
  return clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
}

/**
 * Shared WHERE clause for non-transfer, non-pending spending queries.
 * Plaid convention: positive amount = outflow (expense).
 */
function spendWhereClause(from: string | null, to: string | null): string {
  return `
    WHERE amount IS NOT NULL
      AND COALESCE(is_internal_transfer, 'false') != 'true'
      AND pfc_primary NOT IN ('TRANSFER_IN', 'TRANSFER_OUT')
      AND COALESCE(pending, 'false') != 'true'
      ${dateFilter("COALESCE(date, authorized_date)", from, to)}
  `;
}

export type MetricResult = {
  name: string;
  description: string;
  rows: DuckDbRow[];
};

export type BriefingMetrics = {
  period: { from: string; to: string };
  metrics: MetricResult[];
};

function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const from = `${year}-${month}-01`;
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  const to = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function priorMonthRange(): { from: string; to: string } {
  const now = new Date();
  const priorMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = priorMonth.getFullYear();
  const month = String(priorMonth.getMonth() + 1).padStart(2, "0");
  const from = `${year}-${month}-01`;
  const lastDay = new Date(year, priorMonth.getMonth() + 1, 0).getDate();
  const to = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

async function topSpendingCategories(
  db: duckdb.Database,
  tsvFile: string,
  from: string | null,
  to: string | null,
  label: string,
): Promise<MetricResult> {
  const rows = await query(
    db,
    `
    SELECT
      pfc_primary AS category,
      pfc_detailed AS subcategory,
      ROUND(SUM(amount), 2) AS total_spend,
      COUNT(*) AS txn_count
    FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
    ${spendWhereClause(from, to)}
      AND amount > 0
    GROUP BY pfc_primary, pfc_detailed
    ORDER BY total_spend DESC
    LIMIT 15
    `,
  );
  return {
    name: `top_spending_categories_${label}`,
    description: `Top spending categories (${label})`,
    rows,
  };
}

async function monthOverMonthDeltas(
  db: duckdb.Database,
  tsvFile: string,
  currentFrom: string,
  currentTo: string,
  priorFrom: string,
  priorTo: string,
): Promise<MetricResult> {
  const rows = await query(
    db,
    `
    WITH current_month AS (
      SELECT pfc_primary AS category, ROUND(SUM(amount), 2) AS spend
      FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
      ${spendWhereClause(currentFrom, currentTo)}
        AND amount > 0
      GROUP BY pfc_primary
    ),
    prior_month AS (
      SELECT pfc_primary AS category, ROUND(SUM(amount), 2) AS spend
      FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
      ${spendWhereClause(priorFrom, priorTo)}
        AND amount > 0
      GROUP BY pfc_primary
    )
    SELECT
      COALESCE(c.category, p.category) AS category,
      COALESCE(c.spend, 0) AS current_spend,
      COALESCE(p.spend, 0) AS prior_spend,
      ROUND(COALESCE(c.spend, 0) - COALESCE(p.spend, 0), 2) AS delta,
      CASE
        WHEN COALESCE(p.spend, 0) = 0 THEN NULL
        ELSE ROUND((COALESCE(c.spend, 0) - p.spend) / p.spend * 100, 1)
      END AS pct_change
    FROM current_month c
    FULL OUTER JOIN prior_month p ON c.category = p.category
    ORDER BY ABS(COALESCE(c.spend, 0) - COALESCE(p.spend, 0)) DESC
    `,
  );
  return {
    name: "month_over_month_deltas",
    description: "Month-over-month spending changes by category",
    rows,
  };
}

async function largestTransactions(
  db: duckdb.Database,
  tsvFile: string,
  from: string | null,
  to: string | null,
): Promise<MetricResult> {
  const rows = await query(
    db,
    `
    SELECT
      date,
      name,
      merchant_name,
      amount,
      pfc_primary AS category,
      pfc_detailed AS subcategory
    FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
    ${spendWhereClause(from, to)}
      AND amount > 0
    ORDER BY amount DESC
    LIMIT 10
    `,
  );
  return {
    name: "largest_transactions",
    description: "Largest individual transactions in period",
    rows,
  };
}

async function spendingPace(
  db: duckdb.Database,
  tsvFile: string,
  from: string,
  to: string,
): Promise<MetricResult> {
  const rows = await query(
    db,
    `
    WITH period_spend AS (
      SELECT ROUND(SUM(amount), 2) AS total_spend
      FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
      ${spendWhereClause(from, to)}
        AND amount > 0
    ),
    days_info AS (
      SELECT
        DATEDIFF('day', DATE '${from}', CURRENT_DATE) AS days_elapsed,
        DATEDIFF('day', DATE '${from}', DATE '${to}') + 1 AS days_in_period
    )
    SELECT
      p.total_spend,
      d.days_elapsed,
      d.days_in_period,
      CASE WHEN d.days_elapsed > 0
        THEN ROUND(p.total_spend / d.days_elapsed, 2)
        ELSE 0 END AS daily_rate,
      CASE WHEN d.days_elapsed > 0
        THEN ROUND(p.total_spend / d.days_elapsed * d.days_in_period, 2)
        ELSE 0 END AS projected_total
    FROM period_spend p, days_info d
    `,
  );
  return {
    name: "spending_pace",
    description: "Spending pace vs period length — are we on track?",
    rows,
  };
}

async function incomeVsExpenses(
  db: duckdb.Database,
  tsvFile: string,
  from: string | null,
  to: string | null,
): Promise<MetricResult> {
  const dateClause = dateFilter(
    "COALESCE(date, authorized_date)",
    from,
    to,
  );
  const rows = await query(
    db,
    `
    SELECT
      ROUND(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 2) AS total_income,
      ROUND(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) AS total_expenses,
      ROUND(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) -
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) AS net,
      COUNT(CASE WHEN amount < 0 THEN 1 END) AS income_txn_count,
      COUNT(CASE WHEN amount > 0 THEN 1 END) AS expense_txn_count
    FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
    WHERE amount IS NOT NULL
      AND COALESCE(is_internal_transfer, 'false') != 'true'
      AND pfc_primary NOT IN ('TRANSFER_IN', 'TRANSFER_OUT')
      AND COALESCE(pending, 'false') != 'true'
      ${dateClause}
    `,
  );
  return {
    name: "income_vs_expenses",
    description: "Income vs expenses summary",
    rows,
  };
}

async function transferSummary(
  db: duckdb.Database,
  tsvFile: string,
  from: string | null,
  to: string | null,
): Promise<MetricResult> {
  const dateClause = dateFilter(
    "COALESCE(date, authorized_date)",
    from,
    to,
  );
  const rows = await query(
    db,
    `
    SELECT
      direction,
      COUNT(*) AS txn_count,
      ROUND(SUM(ABS(amount)), 2) AS total_amount
    FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
    WHERE (pfc_primary IN ('TRANSFER_IN', 'TRANSFER_OUT')
           OR COALESCE(is_internal_transfer, 'false') = 'true')
      AND amount IS NOT NULL
      ${dateClause}
    GROUP BY direction
    `,
  );
  return {
    name: "transfer_summary",
    description: "Transfer activity summary",
    rows,
  };
}

async function anomalies(
  db: duckdb.Database,
  tsvFile: string,
  from: string | null,
  to: string | null,
): Promise<MetricResult> {
  const rows = await query(
    db,
    `
    WITH category_stats AS (
      SELECT
        pfc_primary AS category,
        AVG(amount) AS avg_amount,
        STDDEV(amount) AS std_amount
      FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
      WHERE amount IS NOT NULL AND amount > 0
        AND COALESCE(is_internal_transfer, 'false') != 'true'
        AND pfc_primary NOT IN ('TRANSFER_IN', 'TRANSFER_OUT')
      GROUP BY pfc_primary
      HAVING COUNT(*) >= 3
    )
    SELECT
      t.date,
      t.name,
      t.merchant_name,
      t.amount,
      t.pfc_primary AS category,
      ROUND(cs.avg_amount, 2) AS category_avg,
      ROUND(t.amount / NULLIF(cs.avg_amount, 0), 1) AS times_avg
    FROM read_csv_auto('${tsvFile}', delim='\t', header=true) t
    JOIN category_stats cs ON t.pfc_primary = cs.category
    WHERE t.amount > cs.avg_amount * 2
      AND t.amount > 0
      AND COALESCE(t.is_internal_transfer, 'false') != 'true'
      AND COALESCE(t.pending, 'false') != 'true'
      ${dateFilter("COALESCE(t.date, t.authorized_date)", from, to)}
    ORDER BY t.amount DESC
    LIMIT 10
    `,
  );
  return {
    name: "anomalies",
    description: "Anomalous transactions (> 2x category average)",
    rows,
  };
}

async function categoryBreakdown(
  db: duckdb.Database,
  tsvFile: string,
  from: string | null,
  to: string | null,
): Promise<MetricResult> {
  const rows = await query(
    db,
    `
    WITH totals AS (
      SELECT SUM(amount) AS grand_total
      FROM read_csv_auto('${tsvFile}', delim='\t', header=true)
      ${spendWhereClause(from, to)}
        AND amount > 0
    )
    SELECT
      pfc_primary AS category,
      ROUND(SUM(amount), 2) AS total_spend,
      COUNT(*) AS txn_count,
      ROUND(SUM(amount) / NULLIF(t.grand_total, 0) * 100, 1) AS pct_of_total
    FROM read_csv_auto('${tsvFile}', delim='\t', header=true), totals t
    ${spendWhereClause(from, to)}
      AND amount > 0
    GROUP BY pfc_primary, t.grand_total
    ORDER BY total_spend DESC
    `,
  );
  return {
    name: "category_breakdown",
    description: "Category breakdown with percentages of total spend",
    rows,
  };
}

/**
 * Run all pre-built metric queries and return structured results.
 * Expects a `transactions-all` TSV to exist in the exports directory.
 */
export async function runBriefingMetrics(
  masterTsvFilename: string,
  from?: string | null,
  to?: string | null,
): Promise<BriefingMetrics> {
  const current = currentMonthRange();
  const prior = priorMonthRange();
  const effectiveFrom = from ?? current.from;
  const effectiveTo = to ?? current.to;
  const file = tsvPath(masterTsvFilename);

  const db = getDb();
  try {
    const metrics = await Promise.all([
      topSpendingCategories(db, file, effectiveFrom, effectiveTo, "current_month"),
      topSpendingCategories(db, file, prior.from, prior.to, "prior_month"),
      monthOverMonthDeltas(db, file, effectiveFrom, effectiveTo, prior.from, prior.to),
      largestTransactions(db, file, effectiveFrom, effectiveTo),
      spendingPace(db, file, effectiveFrom, effectiveTo),
      incomeVsExpenses(db, file, effectiveFrom, effectiveTo),
      transferSummary(db, file, effectiveFrom, effectiveTo),
      anomalies(db, file, effectiveFrom, effectiveTo),
      categoryBreakdown(db, file, effectiveFrom, effectiveTo),
    ]);

    return {
      period: { from: effectiveFrom, to: effectiveTo },
      metrics,
    };
  } finally {
    await closeDb(db);
  }
}

export type RecurringStreamRow = {
  stream_key: string;
  name: string;
  merchant_name: string | null;
  institution: string | null;
  account_id: string;
  direction: string;
  frequency: string;
  median_interval_days: number;
  avg_amount: number;
  last_amount: number;
  first_date: string;
  last_date: string;
  txn_count: number;
  is_active: boolean;
  pfc_primary: string | null;
  pfc_detailed: string | null;
  window_txn_count: number;
  window_avg_amount: number;
  window_last_amount: number;
  iqr_ratio: number;
  stream_type: "recurring" | "frequent";
};

export type StreamTransactionRow = {
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  account_id: string;
  institution: string | null;
  pfc_primary: string | null;
  pfc_detailed: string | null;
};

/**
 * Detect recurring transaction streams from the master TSV.
 *
 * Pattern detection always runs against the full history for quality.
 * When from/to are provided, an additional window_stats CTE computes
 * in-window counts and averages, and only streams with last_date >= from
 * are returned.
 */
export async function runRecurringDetection(
  masterTsvFilename: string,
  from?: string | null,
  to?: string | null,
): Promise<RecurringStreamRow[]> {
  const file = tsvPath(masterTsvFilename);
  const hasWindow = Boolean(from && to);
  const windowFilter = hasWindow
    ? `WHERE txn_date >= '${from}' AND txn_date <= '${to}'`
    : "";
  const visibilityFilter = from
    ? `AND last_date >= '${from}'`
    : "";

  const db = getDb();
  try {
    const rows = await query(
      db,
      `
      WITH base AS (
        SELECT
          COALESCE(NULLIF(merchant_name, ''), name) AS effective_name,
          name AS txn_name,
          merchant_name,
          institution,
          account_id,
          direction,
          amount,
          COALESCE(date, authorized_date) AS txn_date,
          pfc_primary,
          pfc_detailed
        FROM read_csv_auto('${file}', delim='\t', header=true)
        WHERE amount IS NOT NULL
          AND COALESCE(pending, 'false') != 'true'
          AND COALESCE(date, authorized_date) IS NOT NULL
          AND COALESCE(is_internal_transfer, 'false') != 'true'
          AND pfc_primary NOT IN ('TRANSFER_IN', 'TRANSFER_OUT')
      ),
      keyed AS (
        SELECT *,
          TRIM(REGEXP_REPLACE(
            REGEXP_REPLACE(effective_name,
              '\\s*(DIRECT DEP|PAYROLL|SALARY|BONUS)\\s*', ' ', 'gi'),
            '\\s*(PPD|CCD)\\s+ID:\\s*\\S+', '', 'gi'
          )) || '::' || direction || '::' || account_id AS stream_key
        FROM base
      ),
      with_prev AS (
        SELECT *,
          LAG(txn_date) OVER (PARTITION BY stream_key ORDER BY txn_date) AS prev_date
        FROM keyed
      ),
      intervals AS (
        SELECT
          stream_key,
          DATEDIFF('day', prev_date, txn_date) AS gap_days
        FROM with_prev
        WHERE prev_date IS NOT NULL
      ),
      interval_medians AS (
        SELECT stream_key, MEDIAN(gap_days) AS median_interval_days
        FROM intervals
        GROUP BY stream_key
      ),
      stream_agg AS (
        SELECT
          stream_key,
          MODE(txn_name) AS name,
          MODE(merchant_name) AS merchant_name,
          MODE(institution) AS institution,
          account_id,
          direction,
          COUNT(*) AS txn_count,
          ROUND(AVG(ABS(amount)), 2) AS avg_amount,
          ROUND((ARRAY_AGG(ABS(amount) ORDER BY txn_date DESC))[1], 2) AS last_amount,
          MIN(txn_date) AS first_date,
          MAX(txn_date) AS last_date,
          MODE(pfc_primary) AS pfc_primary,
          MODE(pfc_detailed) AS pfc_detailed,
          ROUND((QUANTILE_CONT(ABS(amount), 0.75) - QUANTILE_CONT(ABS(amount), 0.25))
            / NULLIF(QUANTILE_CONT(ABS(amount), 0.5), 0), 3) AS iqr_ratio
        FROM keyed
        GROUP BY stream_key, account_id, direction
        HAVING COUNT(*) >= 3
      ),
      stream_stats AS (
        SELECT
          s.*,
          COALESCE(m.median_interval_days, 0) AS median_interval_days
        FROM stream_agg s
        LEFT JOIN interval_medians m ON s.stream_key = m.stream_key
      ),
      window_stats AS (
        SELECT
          stream_key,
          COUNT(*) AS window_txn_count,
          ROUND(AVG(ABS(amount)), 2) AS window_avg_amount,
          ROUND((ARRAY_AGG(ABS(amount) ORDER BY txn_date DESC))[1], 2) AS window_last_amount
        FROM keyed
        ${windowFilter}
        GROUP BY stream_key
      )
      SELECT
        ss.stream_key,
        ss.name,
        ss.merchant_name,
        ss.institution,
        ss.account_id,
        ss.direction,
        ss.txn_count,
        ss.avg_amount,
        ss.last_amount,
        ss.first_date,
        ss.last_date,
        ss.pfc_primary,
        ss.pfc_detailed,
        CAST(ss.median_interval_days AS INTEGER) AS median_interval_days,
        CASE
          WHEN ss.median_interval_days BETWEEN 0 AND 4 THEN 'FREQUENT'
          WHEN ss.median_interval_days BETWEEN 5 AND 9 THEN 'WEEKLY'
          WHEN ss.median_interval_days BETWEEN 10 AND 18 THEN 'BIWEEKLY'
          WHEN ss.median_interval_days BETWEEN 25 AND 38 THEN 'MONTHLY'
          WHEN ss.median_interval_days BETWEEN 55 AND 70 THEN 'BIMONTHLY'
          WHEN ss.median_interval_days BETWEEN 340 AND 400 THEN 'ANNUALLY'
          ELSE 'IRREGULAR'
        END AS frequency,
        CASE
          WHEN DATEDIFF('day', ss.last_date, CURRENT_DATE) <= GREATEST(ss.median_interval_days * 1.5, 14)
            THEN true
          ELSE false
        END AS is_active,
        COALESCE(w.window_txn_count, 0) AS window_txn_count,
        COALESCE(w.window_avg_amount, 0) AS window_avg_amount,
        COALESCE(w.window_last_amount, 0) AS window_last_amount,
        COALESCE(ss.iqr_ratio, 0) AS iqr_ratio,
        CASE WHEN COALESCE(ss.iqr_ratio, 0) < 1.0 THEN 'recurring' ELSE 'frequent' END AS stream_type
      FROM stream_stats ss
      LEFT JOIN window_stats w ON ss.stream_key = w.stream_key
      WHERE frequency != 'IRREGULAR'
        ${visibilityFilter}
      ORDER BY is_active DESC, COALESCE(w.window_avg_amount, ss.avg_amount) DESC
      `,
    );
    return rows as unknown as RecurringStreamRow[];
  } finally {
    await closeDb(db);
  }
}

/**
 * Fetch individual transactions for a specific recurring stream key.
 * Used by the drill-down UI to show actual transaction rows.
 */
export async function queryStreamTransactions(
  masterTsvFilename: string,
  streamKey: string,
  from?: string | null,
  to?: string | null,
): Promise<StreamTransactionRow[]> {
  const file = tsvPath(masterTsvFilename);
  const dateFilter: string[] = [];
  if (from) dateFilter.push(`COALESCE(date, authorized_date) >= '${from}'`);
  if (to) dateFilter.push(`COALESCE(date, authorized_date) <= '${to}'`);
  const dateClause = dateFilter.length > 0 ? `AND ${dateFilter.join(" AND ")}` : "";

  const db = getDb();
  try {
    const rows = await query(
      db,
      `
      SELECT
        COALESCE(date, authorized_date) AS date,
        name,
        merchant_name,
        amount,
        account_id,
        institution,
        pfc_primary,
        pfc_detailed
      FROM read_csv_auto('${file}', delim='\t', header=true)
      WHERE amount IS NOT NULL
        AND COALESCE(pending, 'false') != 'true'
        AND COALESCE(date, authorized_date) IS NOT NULL
        AND COALESCE(is_internal_transfer, 'false') != 'true'
        AND (TRIM(REGEXP_REPLACE(
              REGEXP_REPLACE(COALESCE(NULLIF(merchant_name, ''), name),
                '\\s*(DIRECT DEP|PAYROLL|SALARY|BONUS)\\s*', ' ', 'gi'),
              '\\s*(PPD|CCD)\\s+ID:\\s*\\S+', '', 'gi'
            )) || '::' || direction || '::' || account_id) = '${streamKey.replace(/'/g, "''")}'
        ${dateClause}
      ORDER BY COALESCE(date, authorized_date) DESC
      `,
    );
    return rows as unknown as StreamTransactionRow[];
  } finally {
    await closeDb(db);
  }
}

/**
 * Execute an arbitrary DuckDB SQL query against the master TSV.
 * Used by the conversational ask flow when the LLM generates SQL.
 */
export async function executeArbitraryQuery(
  masterTsvFilename: string,
  sql: string,
): Promise<DuckDbRow[]> {
  const file = tsvPath(masterTsvFilename);
  const safeSql = sql.replace(/__TSV_FILE__/g, `'${file}'`);
  const db = getDb();
  try {
    return await query(db, safeSql);
  } finally {
    await closeDb(db);
  }
}
