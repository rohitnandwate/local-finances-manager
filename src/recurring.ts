import { type RecurringStreamRow, runRecurringDetection } from "./query.js";

export type RecurringStream = {
  streamKey: string;
  name: string;
  merchantName: string | null;
  institution: string | null;
  accountId: string;
  direction: string;
  frequency: string;
  medianIntervalDays: number;
  averageAmount: number;
  lastAmount: number;
  firstDate: string;
  lastDate: string;
  transactionCount: number;
  isActive: boolean;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  windowTxnCount: number;
  windowAvgAmount: number;
  windowLastAmount: number;
  streamType: "recurring" | "frequent";
};

export type RecurringSummary = {
  streams: RecurringStream[];
  totals: {
    activeInflowCount: number;
    activeOutflowCount: number;
    estimatedMonthlyInflow: number | null;
    estimatedMonthlyOutflow: number | null;
  };
  frequentTotals: {
    activeOutflowCount: number;
    totalWindowOutflow: number | null;
    merchantCount: number;
  };
  period: { from: string; to: string };
  detectedAt: string;
};

const FREQUENCY_MONTHLY_FACTOR: Record<string, number> = {
  FREQUENT: 15,
  WEEKLY: 4.33,
  BIWEEKLY: 2.17,
  MONTHLY: 1,
  BIMONTHLY: 0.5,
  ANNUALLY: 1 / 12,
  IRREGULAR: 1,
};

function estimateMonthlyTotal(streams: RecurringStream[]): number | null {
  const active = streams.filter((s) => s.isActive);
  if (active.length === 0) return null;

  return active.reduce((total, s) => {
    const amt = s.windowAvgAmount > 0 ? s.windowAvgAmount : s.averageAmount;
    const factor = FREQUENCY_MONTHLY_FACTOR[s.frequency] ?? 1;
    return total + Math.abs(amt) * factor;
  }, 0);
}

function computeFrequentTotals(streams: RecurringStream[]): RecurringSummary["frequentTotals"] {
  const freqOutflows = streams.filter(
    (s) => s.streamType === "frequent" && s.direction === "outflow",
  );
  const activeFreq = freqOutflows.filter((s) => s.isActive);

  let totalWindowOutflow: number | null = null;
  if (activeFreq.length > 0) {
    totalWindowOutflow = activeFreq.reduce((sum, s) => {
      const amt = s.windowAvgAmount > 0 ? s.windowAvgAmount : s.averageAmount;
      return sum + Math.abs(amt) * s.windowTxnCount;
    }, 0);
  }

  return {
    activeOutflowCount: activeFreq.length,
    totalWindowOutflow,
    merchantCount: freqOutflows.length,
  };
}

function rowToStream(row: RecurringStreamRow): RecurringStream {
  return {
    streamKey: row.stream_key,
    name: row.name,
    merchantName: row.merchant_name || null,
    institution: row.institution || null,
    accountId: row.account_id,
    direction: row.direction,
    frequency: row.frequency,
    medianIntervalDays: row.median_interval_days,
    averageAmount: row.avg_amount,
    lastAmount: row.last_amount,
    firstDate: row.first_date,
    lastDate: row.last_date,
    transactionCount: row.txn_count,
    isActive: row.is_active,
    categoryPrimary: row.pfc_primary || null,
    categoryDetailed: row.pfc_detailed || null,
    windowTxnCount: row.window_txn_count,
    windowAvgAmount: row.window_avg_amount,
    windowLastAmount: row.window_last_amount,
    streamType: row.stream_type,
  };
}

export async function detectRecurringStreams(
  masterTsvFilename: string,
  from?: string | null,
  to?: string | null,
): Promise<RecurringSummary> {
  const effectiveFrom = from ?? defaultFrom();
  const effectiveTo = to ?? defaultTo();

  const rows = await runRecurringDetection(masterTsvFilename, effectiveFrom, effectiveTo);
  const streams = rows.map(rowToStream);

  const recurring = streams.filter((s) => s.streamType === "recurring");
  const recurringInflows = recurring.filter((s) => s.direction === "inflow");
  const recurringOutflows = recurring.filter((s) => s.direction === "outflow");

  return {
    streams,
    totals: {
      activeInflowCount: recurringInflows.filter((s) => s.isActive).length,
      activeOutflowCount: recurringOutflows.filter((s) => s.isActive).length,
      estimatedMonthlyInflow: estimateMonthlyTotal(recurringInflows),
      estimatedMonthlyOutflow: estimateMonthlyTotal(recurringOutflows),
    },
    frequentTotals: computeFrequentTotals(streams),
    period: { from: effectiveFrom, to: effectiveTo },
    detectedAt: new Date().toISOString(),
  };
}

function defaultFrom(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}

function defaultTo(): string {
  return new Date().toISOString().slice(0, 10);
}
