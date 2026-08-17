import type { StoredTransactionSnapshot } from "./storage.js";

const TRANSFER_PRIMARY_CATEGORIES = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);
const CC_PAYMENT_DETAILED = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";
const DATE_PROXIMITY_DAYS = 3;
const AMOUNT_TOLERANCE = 0.02;

export type TransferAnnotation = {
  isInternalTransfer: boolean;
  transferPairId: string | null;
};

export type AnnotatedTransaction = StoredTransactionSnapshot & TransferAnnotation;

function isTransferCategory(primary: string | null): boolean {
  return primary !== null && TRANSFER_PRIMARY_CATEGORIES.has(primary);
}

function isCreditCardPayment(txn: StoredTransactionSnapshot): boolean {
  return txn.personalFinanceCategoryDetailed === CC_PAYMENT_DETAILED;
}

/**
 * True when the PFC primary is TRANSFER_IN, TRANSFER_OUT, or the detailed
 * category is LOAN_PAYMENTS_CREDIT_CARD_PAYMENT. Used by export modules
 * to filter transfer-like transactions out of spend summaries.
 */
export function isTransferLikeCategory(txn: StoredTransactionSnapshot): boolean {
  return (
    isTransferCategory(txn.personalFinanceCategoryPrimary) ||
    isCreditCardPayment(txn)
  );
}

function oppositeDirection(primary: string): string {
  return primary === "TRANSFER_IN" ? "TRANSFER_OUT" : "TRANSFER_IN";
}

function parseDate(dateString: string | null): number | null {
  if (!dateString) return null;
  const ms = Date.parse(dateString);
  return Number.isNaN(ms) ? null : ms;
}

const MS_PER_DAY = 86_400_000;

function withinDateProximity(
  dateA: string | null,
  dateB: string | null,
): boolean {
  const msA = parseDate(dateA);
  const msB = parseDate(dateB);
  if (msA === null || msB === null) return false;
  return Math.abs(msA - msB) <= DATE_PROXIMITY_DAYS * MS_PER_DAY;
}

function amountsMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(Math.abs(a) - Math.abs(b)) <= AMOUNT_TOLERANCE;
}

/**
 * Boost score when a counterparty is a financial institution whose name
 * matches the institution name of the other transaction's account.
 */
function counterpartyInstitutionBoost(
  txn: StoredTransactionSnapshot,
  otherInstitutionName: string | null,
): number {
  if (!otherInstitutionName) return 0;
  const lowerInst = otherInstitutionName.toLowerCase();
  for (const cp of txn.counterparties) {
    if (
      cp.type === "financial_institution" &&
      cp.name &&
      cp.name.toLowerCase().includes(lowerInst)
    ) {
      return 1;
    }
  }
  return 0;
}

type TransactionWithMeta = {
  transaction: StoredTransactionSnapshot;
  institutionName: string | null;
};

function markPair(
  annotations: Map<string, TransferAnnotation>,
  paired: Set<string>,
  pairCounter: number,
  a: TransactionWithMeta,
  b: TransactionWithMeta,
): number {
  const pairId = `transfer-pair-${pairCounter + 1}`;
  paired.add(a.transaction.id);
  paired.add(b.transaction.id);
  annotations.set(a.transaction.id, {
    isInternalTransfer: true,
    transferPairId: pairId,
  });
  annotations.set(b.transaction.id, {
    isInternalTransfer: true,
    transferPairId: pairId,
  });
  return pairCounter + 1;
}

/**
 * Detect internal transfers across all sessions' transactions.
 *
 * Two pairing passes:
 * 1. TRANSFER_IN ↔ TRANSFER_OUT by PFC primary (existing bank-transfer logic)
 * 2. LOAN_PAYMENTS_CREDIT_CARD_PAYMENT outflow ↔ inflow (credit card payments)
 *
 * Returns a Map from transaction ID to TransferAnnotation.
 */
export function detectTransfers(
  sessionTransactions: Array<{
    institutionName: string | null;
    transactions: StoredTransactionSnapshot[];
  }>,
): Map<string, TransferAnnotation> {
  const annotations = new Map<string, TransferAnnotation>();

  const transferCandidates: TransactionWithMeta[] = [];
  const ccPaymentCandidates: TransactionWithMeta[] = [];
  const allTransactions: TransactionWithMeta[] = [];

  for (const session of sessionTransactions) {
    for (const txn of session.transactions) {
      const meta: TransactionWithMeta = {
        transaction: txn,
        institutionName: session.institutionName,
      };
      allTransactions.push(meta);
      if (isTransferCategory(txn.personalFinanceCategoryPrimary)) {
        transferCandidates.push(meta);
      }
      if (isCreditCardPayment(txn)) {
        ccPaymentCandidates.push(meta);
      }
    }
  }

  for (const { transaction } of allTransactions) {
    annotations.set(transaction.id, {
      isInternalTransfer: false,
      transferPairId: null,
    });
  }

  const paired = new Set<string>();
  let pairCounter = 0;

  // Pass 1: TRANSFER_IN ↔ TRANSFER_OUT
  for (let i = 0; i < transferCandidates.length; i++) {
    const candidateA = transferCandidates[i]!;
    const txnA = candidateA.transaction;
    if (paired.has(txnA.id)) continue;

    const targetDirection = oppositeDirection(
      txnA.personalFinanceCategoryPrimary!,
    );

    let bestMatch: TransactionWithMeta | null = null;
    let bestScore = -1;

    for (let j = 0; j < transferCandidates.length; j++) {
      if (i === j) continue;
      const candidateB = transferCandidates[j]!;
      const txnB = candidateB.transaction;

      if (paired.has(txnB.id)) continue;
      if (txnB.personalFinanceCategoryPrimary !== targetDirection) continue;
      if (txnA.accountId === txnB.accountId) continue;
      if (!amountsMatch(txnA.amount, txnB.amount)) continue;

      const dateA = txnA.date ?? txnA.authorizedDate;
      const dateB = txnB.date ?? txnB.authorizedDate;
      if (!withinDateProximity(dateA, dateB)) continue;

      let score = 1;
      score += counterpartyInstitutionBoost(txnA, candidateB.institutionName);
      score += counterpartyInstitutionBoost(txnB, candidateA.institutionName);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidateB;
      }
    }

    if (bestMatch) {
      pairCounter = markPair(
        annotations,
        paired,
        pairCounter,
        candidateA,
        bestMatch,
      );
    }
  }

  // Pass 2: Credit card payments — outflow (checking) ↔ inflow (card)
  // Direction is determined by amount sign: positive = outflow, negative = inflow.
  for (let i = 0; i < ccPaymentCandidates.length; i++) {
    const candidateA = ccPaymentCandidates[i]!;
    const txnA = candidateA.transaction;
    if (paired.has(txnA.id)) continue;
    if (txnA.amount === null || txnA.amount <= 0) continue;

    let bestMatch: TransactionWithMeta | null = null;
    let bestScore = -1;

    for (let j = 0; j < ccPaymentCandidates.length; j++) {
      if (i === j) continue;
      const candidateB = ccPaymentCandidates[j]!;
      const txnB = candidateB.transaction;

      if (paired.has(txnB.id)) continue;
      if (txnB.amount === null || txnB.amount >= 0) continue;
      if (txnA.accountId === txnB.accountId) continue;
      if (!amountsMatch(txnA.amount, txnB.amount)) continue;

      const dateA = txnA.date ?? txnA.authorizedDate;
      const dateB = txnB.date ?? txnB.authorizedDate;
      if (!withinDateProximity(dateA, dateB)) continue;

      let score = 1;
      score += counterpartyInstitutionBoost(txnA, candidateB.institutionName);
      score += counterpartyInstitutionBoost(txnB, candidateA.institutionName);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidateB;
      }
    }

    if (bestMatch) {
      pairCounter = markPair(
        annotations,
        paired,
        pairCounter,
        candidateA,
        bestMatch,
      );
    }
  }

  return annotations;
}

export function annotateTransactions(
  transactions: StoredTransactionSnapshot[],
  annotations: Map<string, TransferAnnotation>,
): AnnotatedTransaction[] {
  return transactions.map((txn) => ({
    ...txn,
    ...(annotations.get(txn.id) ?? {
      isInternalTransfer: false,
      transferPairId: null,
    }),
  }));
}
