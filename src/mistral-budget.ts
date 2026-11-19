import { MISTRAL_BASE_URL } from "./models.ts";
import { isRecord } from "./type-guards.ts";

// The two platform reads Mistral Vibe's usage gauge makes. They cost no
// inference tokens and Mistral documents them as part of the billing surface
// (checked live 2026-11-19: a sign-in key may read both).
const BUDGET_URL = `${MISTRAL_BASE_URL}/v1/billing/budget`;
const SUBSCRIPTION_URL = `${MISTRAL_BASE_URL}/v1/billing/subscription`;

// Past this used fraction the extension warns that the plan budget is ending.
export const BUDGET_LOW_THRESHOLD = 0.9;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type BudgetUsage = {
  /** Share of the budget already used, 0..1. */
  used: number;
  initial: number;
  currency: string;
  resetAt: string | null;
};

export type MistralBudget = {
  plan: string | null;
  payAsYouGoEnabled: boolean | null;
  vibe: BudgetUsage | null;
  api: BudgetUsage | null;
};

export type BudgetLevel = "ok" | "low" | "exhausted";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUsage(record: Record<string, unknown>): BudgetUsage | null {
  const used = finiteNumber(record.usage_percentage);
  const initial = finiteNumber(record.initial_budget);
  if (used === null || initial === null) return null;
  return {
    used: used / 100,
    initial,
    currency: typeof record.currency === "string" ? record.currency : "",
    resetAt: typeof record.reset_at === "string" ? record.reset_at : null,
  };
}

async function readJson(fetchLike: FetchLike, url: string, apiKey: string): Promise<unknown> {
  try {
    const response = await fetchLike(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The plan's current budget state, or null when either read fails or carries
 * nothing usable. The budget read is the one that matters; a failing
 * subscription read only costs the plan name.
 */
export async function fetchMistralBudget(fetchLike: FetchLike, apiKey: string): Promise<MistralBudget | null> {
  const [budgetPayload, subscriptionPayload] = await Promise.all([
    readJson(fetchLike, BUDGET_URL, apiKey),
    readJson(fetchLike, SUBSCRIPTION_URL, apiKey),
  ]);
  if (!isRecord(budgetPayload)) return null;
  const vibe = isRecord(budgetPayload.vibe_budget) ? parseUsage(budgetPayload.vibe_budget) : null;
  const api = isRecord(budgetPayload.api_budget) ? parseUsage(budgetPayload.api_budget) : null;
  if (!vibe && !api) return null;
  const subscription = isRecord(subscriptionPayload) ? subscriptionPayload : null;
  const planName = subscription?.plan_name;
  return {
    plan: typeof planName === "string" && planName.length > 0 ? planName : null,
    payAsYouGoEnabled: typeof subscription?.vibe_payg_enabled === "boolean" ? subscription.vibe_payg_enabled : null,
    vibe,
    api,
  };
}

/** The plan budget's state, from the share already used. */
export function vibeBudgetLevel(budget: MistralBudget): BudgetLevel {
  const used = budget.vibe?.used ?? 0;
  if (used >= 1) return "exhausted";
  if (used >= BUDGET_LOW_THRESHOLD) return "low";
  return "ok";
}

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

function formatAmount(amount: number, currency: string): string {
  const rounded = amount >= 100 ? amount.toFixed(0) : amount.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${rounded}` : `${rounded} ${currency}`.trim();
}

function formatResetDate(resetAt: string | null): string {
  if (!resetAt) return "";
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "";
  const formatted = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
  return ` · resets ${formatted}`;
}

/** One footer line with the plan budget, or null when no budget parsed. */
export function formatBudgetLine(budget: MistralBudget): string | null {
  if (!budget.vibe) return null;
  if (budget.vibe.used >= 1) {
    return `Mistral plan budget exhausted${formatResetDate(budget.vibe.resetAt)}`;
  }
  const remaining = budget.vibe.initial * (1 - budget.vibe.used);
  return `Mistral plan: ${formatAmount(remaining, budget.vibe.currency)} of ${formatAmount(
    budget.vibe.initial,
    budget.vibe.currency,
  )} left${formatResetDate(budget.vibe.resetAt)}`;
}

/** The multi-line summary the status command shows. */
export function formatBudgetSummary(budget: MistralBudget): string | null {
  const lines: string[] = [];
  if (budget.plan) {
    const payg = budget.payAsYouGoEnabled === false ? " · pay-as-you-go off" : "";
    lines.push(`Mistral plan: ${budget.plan}${payg}`);
  }
  if (budget.vibe) {
    lines.push(
      `Vibe Code budget: ${(budget.vibe.used * 100).toFixed(1)}% of ${formatAmount(
        budget.vibe.initial,
        budget.vibe.currency,
      )} used${formatResetDate(budget.vibe.resetAt)}`,
    );
  }
  if (budget.api) {
    lines.push(
      `API budget: ${(budget.api.used * 100).toFixed(1)}% of ${formatAmount(
        budget.api.initial,
        budget.api.currency,
      )} used`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
