import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from "plaid";

import { assertPlaidConfigured, config } from "./config.js";

const MAX_TRANSACTIONS_GET_PAGES = 50;
const MAX_TRANSACTIONS_SYNC_PAGES = 50;
const TRANSACTIONS_GET_PAGE_SIZE = 500;

/** Stable Plaid Link `client_user_id` for local installs (not tied to an individual). */
const PLAID_CLIENT_USER_ID = "budget-expense-tracker-local-user";

type TransactionSummary = {
  added: unknown[];
  modified: unknown[];
  removed: unknown[];
  cursor: string;
  hasMore: boolean;
};

export type HistoricalTransactionsSummary = {
  transactions: unknown[];
  startDate: string;
  endDate: string;
  totalCount: number;
};

export type InvestmentHoldingsSummary = {
  itemId: string | null;
  accounts: unknown[];
  holdings: unknown[];
  securities: unknown[];
};

export type InvestmentTransactionsSummary = {
  transactions: unknown[];
};

function mapCountryCode(code: string): CountryCode {
  const upper = code.toUpperCase();
  const match = Object.values(CountryCode).find((value) => value === upper);
  if (!match) {
    throw new Error(`Unsupported PLAID_COUNTRY_CODES value: ${code}`);
  }

  return match as CountryCode;
}

function mapProduct(product: string): Products {
  const normalized = product.trim().toLowerCase();
  const match = Object.values(Products).find((value) => value === normalized);
  if (!match) {
    throw new Error(`Unsupported PLAID_PRODUCTS value: ${product}`);
  }

  return match as Products;
}

function createClient(): PlaidApi {
  assertPlaidConfigured();

  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[config.plaid.environment],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": config.plaid.clientId,
          "PLAID-SECRET": config.plaid.secret,
        },
      },
    }),
  );
}

export async function createLinkToken(): Promise<string> {
  const client = createClient();
  const response = await client.linkTokenCreate({
    client_name: "Budget and Expense Tracker",
    country_codes: config.plaid.countryCodes.map(mapCountryCode),
    language: "en",
    products: config.plaid.products.map(mapProduct),
    transactions: {
      days_requested: config.plaid.daysRequested,
    },
    user: {
      client_user_id: PLAID_CLIENT_USER_ID,
    },
  });

  return response.data.link_token;
}

export async function createUpdateLinkToken(accessToken: string): Promise<string> {
  const client = createClient();
  const configuredProducts = config.plaid.products.map(mapProduct);
  const additionalConsentedProducts = configuredProducts.filter(
    (product) => product === Products.Investments,
  );
  const baseProducts = configuredProducts.filter(
    (product) => product !== Products.Investments,
  );
  const response = await client.linkTokenCreate({
    client_name: "Budget and Expense Tracker",
    country_codes: config.plaid.countryCodes.map(mapCountryCode),
    language: "en",
    access_token: accessToken,
    products: baseProducts,
    additional_consented_products: additionalConsentedProducts,
    user: {
      client_user_id: PLAID_CLIENT_USER_ID,
    },
  });

  return response.data.link_token;
}

export async function exchangePublicToken(publicToken: string): Promise<{
  accessToken: string;
  itemId: string;
}> {
  const client = createClient();
  const response = await client.itemPublicTokenExchange({
    public_token: publicToken,
  });

  return {
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  };
}

export async function getAccountBalances(accessToken: string) {
  const client = createClient();
  const response = await client.accountsGet({
    access_token: accessToken,
  });

  return response.data.accounts.map((account) => ({
    id: account.account_id,
    name: account.name,
    mask: account.mask,
    subtype: account.subtype,
    type: account.type,
    available: account.balances.available,
    current: account.balances.current,
    isoCurrencyCode: account.balances.iso_currency_code,
  }));
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function getHistoricalWindow(daysRequested: number): {
  startDate: string;
  endDate: string;
} {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - daysRequested);

  return {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
  };
}

export async function getHistoricalTransactions(
  accessToken: string,
  daysRequested: number,
): Promise<HistoricalTransactionsSummary> {
  const client = createClient();
  const { startDate, endDate } = getHistoricalWindow(daysRequested);
  const transactions: unknown[] = [];

  let offset = 0;
  let pageCount = 0;
  let totalCount = 0;

  while (true) {
    const response = await client.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: {
        count: TRANSACTIONS_GET_PAGE_SIZE,
        offset,
        include_personal_finance_category: true,
      },
    });

    transactions.push(...response.data.transactions);
    totalCount = response.data.total_transactions;
    offset += response.data.transactions.length;
    pageCount += 1;

    if (offset >= totalCount) {
      break;
    }

    if (pageCount >= MAX_TRANSACTIONS_GET_PAGES) {
      throw new Error(
        `Historical transactions fetch exceeded ${MAX_TRANSACTIONS_GET_PAGES} pages before completion.`,
      );
    }
  }

  return {
    transactions,
    startDate,
    endDate,
    totalCount,
  };
}

export async function syncTransactions(
  accessToken: string,
  cursor: string | null,
): Promise<TransactionSummary> {
  const client = createClient();
  const added: unknown[] = [];
  const modified: unknown[] = [];
  const removed: unknown[] = [];

  let nextCursor = cursor ?? "";
  let hasMore = true;
  let pageCount = 0;

  while (hasMore) {
    const response = await client.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor,
      count: 100,
      options: {
        include_personal_finance_category: true,
      },
    });

    added.push(...response.data.added);
    modified.push(...response.data.modified);
    removed.push(...response.data.removed);

    nextCursor = response.data.next_cursor;
    hasMore = response.data.has_more;
    pageCount += 1;

    if (hasMore && pageCount >= MAX_TRANSACTIONS_SYNC_PAGES) {
      throw new Error(
        `Transaction sync exceeded ${MAX_TRANSACTIONS_SYNC_PAGES} pages before completion.`,
      );
    }
  }

  return {
    added,
    modified,
    removed,
    cursor: nextCursor,
    hasMore,
  };
}

export async function getInvestmentHoldings(
  accessToken: string,
): Promise<InvestmentHoldingsSummary> {
  const client = createClient();
  const response = await client.investmentsHoldingsGet({
    access_token: accessToken,
  });

  return {
    itemId: response.data.item?.item_id ?? null,
    accounts: response.data.accounts,
    holdings: response.data.holdings,
    securities: response.data.securities,
  };
}

function dateNDaysAgo(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() - days);
  return now.toISOString().slice(0, 10);
}

export async function getInvestmentTransactions(
  accessToken: string,
  daysRequested = 120,
): Promise<InvestmentTransactionsSummary> {
  const client = createClient();
  const transactions: unknown[] = [];
  const startDate = dateNDaysAgo(daysRequested);
  const endDate = new Date().toISOString().slice(0, 10);
  let offset = 0;

  while (true) {
    const response = await client.investmentsTransactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: {
        count: 100,
        offset,
      },
    });

    transactions.push(...response.data.investment_transactions);
    offset += response.data.investment_transactions.length;
    if (offset >= response.data.total_investment_transactions) {
      break;
    }
  }

  return {
    transactions,
  };
}

