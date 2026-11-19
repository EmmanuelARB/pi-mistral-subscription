import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";

import mistralSubscriptionExtension from "../extensions/mistral-subscription/index.ts";
import {
  type FetchLike,
  fetchMistralBudget,
  formatBudgetLine,
  formatBudgetSummary,
  vibeBudgetLevel,
} from "../src/mistral-budget.ts";
import { MISTRAL_PROVIDER_ID } from "../src/models.ts";

function jsonResponse(payload: unknown): Response {
  return Response.json(payload, { status: 200 });
}

function budgetFetch(budget: unknown, subscription: unknown, calls?: { count: number }): FetchLike {
  return async (url) => {
    if (calls) calls.count++;
    if (url.endsWith("/v1/billing/budget")) return jsonResponse(budget);
    if (url.endsWith("/v1/billing/subscription")) return jsonResponse(subscription);
    throw new Error(`unexpected url: ${url}`);
  };
}

const BUDGET_PAYLOAD = {
  vibe_budget: { usage_percentage: 93.34, initial_budget: 255, currency: "EUR", reset_at: "2026-12-01T00:00:00Z" },
  api_budget: { usage_percentage: 100, initial_budget: 25.5, currency: "EUR", reset_at: "2026-12-01T00:00:00Z" },
};
const SUBSCRIPTION_PAYLOAD = { plan_name: "INDIVIDUAL", payg_enabled: false, vibe_payg_enabled: false };

test("fetchMistralBudget parses the plan, both budgets and pay-as-you-go", async () => {
  const budget = await fetchMistralBudget(budgetFetch(BUDGET_PAYLOAD, SUBSCRIPTION_PAYLOAD), "test-key");
  assert.ok(budget);
  assert.equal(budget.plan, "INDIVIDUAL");
  assert.equal(budget.payAsYouGoEnabled, false);
  assert.equal(budget.vibe?.used, 0.9334);
  assert.equal(budget.vibe?.initial, 255);
  assert.equal(budget.vibe?.currency, "EUR");
  assert.equal(budget.api?.used, 1);
});

test("fetchMistralBudget tolerates a missing subscription read", async () => {
  const budget = await fetchMistralBudget(budgetFetch(BUDGET_PAYLOAD, { plan_name: "" }, { count: 0 }), "test-key");
  assert.ok(budget);
  assert.equal(budget.plan, null);
  assert.equal(budget.payAsYouGoEnabled, null);
});

test("fetchMistralBudget returns null when the budget read fails", async () => {
  const failing = (async () => Response.json({}, { status: 403 })) as FetchLike;
  assert.equal(await fetchMistralBudget(failing, "test-key"), null);
});

test("formatBudgetLine shows the remaining plan budget and reset date", () => {
  const budget = {
    plan: "INDIVIDUAL",
    payAsYouGoEnabled: false,
    vibe: { used: 0.9334, initial: 255, currency: "EUR", resetAt: "2026-12-01T00:00:00Z" },
    api: { used: 1, initial: 25.5, currency: "EUR", resetAt: null },
  };
  assert.equal(formatBudgetLine(budget), "Mistral plan: €16.98 of €255 left · resets 1 Dec");
  assert.equal(vibeBudgetLevel(budget), "low");
});

test("formatBudgetLine reports an exhausted plan budget", () => {
  const budget = {
    plan: null,
    payAsYouGoEnabled: null,
    vibe: { used: 1, initial: 255, currency: "EUR", resetAt: "2026-12-01T00:00:00Z" },
    api: null,
  };
  assert.equal(formatBudgetLine(budget), "Mistral plan budget exhausted · resets 1 Dec");
  assert.equal(vibeBudgetLevel(budget), "exhausted");
});

test("formatBudgetSummary lists the plan and both budgets", () => {
  const budget = {
    plan: "INDIVIDUAL",
    payAsYouGoEnabled: false,
    vibe: { used: 0.9334, initial: 255, currency: "EUR", resetAt: "2026-12-01T00:00:00Z" },
    api: { used: 1, initial: 25.5, currency: "EUR", resetAt: null },
  };
  assert.equal(
    formatBudgetSummary(budget),
    [
      "Mistral plan: INDIVIDUAL · pay-as-you-go off",
      "Vibe Code budget: 93.3% of €255 used · resets 1 Dec",
      "API budget: 100.0% of €25.50 used",
    ].join("\n"),
  );
});

type Captured = {
  registrations: Map<string, ProviderConfig>;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>;
  commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  statuses: Map<string, string | undefined>;
  notifications: Array<{ message: string; type?: string }>;
  fetchCount: { count: number };
};

function loadExtension(budget: unknown, subscription: unknown, clock: { at: number }): Captured {
  const captured: Captured = {
    registrations: new Map(),
    handlers: new Map(),
    commands: new Map(),
    statuses: new Map(),
    notifications: [],
    fetchCount: { count: 0 },
  };
  mistralSubscriptionExtension(
    {
      registerProvider: (id: string, config: ProviderConfig) => captured.registrations.set(id, config),
      registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
        captured.commands.set(name, command),
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
        captured.handlers.set(event, handler),
      getThinkingLevel: () => "high",
      setModel: async () => {},
      setThinkingLevel: () => {},
    } as unknown as ExtensionAPI,
    { fetch: budgetFetch(budget, subscription, captured.fetchCount), now: () => clock.at },
  );
  return captured;
}

function fakeContext(captured: Captured, provider = MISTRAL_PROVIDER_ID): ExtensionContext {
  return {
    hasUI: true,
    model: { provider, id: "mistral-large-4" },
    modelRegistry: {
      isUsingOAuth: (model: { provider?: string }) => model?.provider === MISTRAL_PROVIDER_ID,
      getApiKeyForProvider: async () => "test-key",
      find: () => undefined,
    },
    ui: {
      notify: (message: string, type?: string) => captured.notifications.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => captured.statuses.set(key, text),
    },
  } as unknown as ExtensionContext;
}

test("session_start shows the plan budget in the footer while signed in", async () => {
  const clock = { at: 0 };
  const calm = {
    ...BUDGET_PAYLOAD,
    vibe_budget: { ...BUDGET_PAYLOAD.vibe_budget, usage_percentage: 53.34 },
  };
  const captured = loadExtension(calm, SUBSCRIPTION_PAYLOAD, clock);
  await captured.handlers.get("session_start")?.({ reason: "new" }, fakeContext(captured));
  assert.equal(captured.fetchCount.count, 2, "budget and subscription reads");
  assert.equal(captured.statuses.get("mistral-budget"), "Mistral plan: €119 of €255 left · resets 1 Dec");
  assert.equal(captured.notifications.length, 0, "53.3% used stays below the warning threshold");
});

test("session_start fetches nothing without a sign-in and clears the footer", async () => {
  const clock = { at: 0 };
  const captured = loadExtension(BUDGET_PAYLOAD, SUBSCRIPTION_PAYLOAD, clock);
  const ctx = fakeContext(captured, "another-provider");
  await captured.handlers.get("session_start")?.({ reason: "new" }, ctx);
  await captured.handlers.get("model_select")?.({ model: ctx.model }, ctx);
  assert.equal(captured.fetchCount.count, 0);
  assert.equal(captured.statuses.get("mistral-budget"), undefined);
});

test("an exhausted plan budget notifies once per session", async () => {
  const clock = { at: 0 };
  const exhausted = {
    vibe_budget: { usage_percentage: 100, initial_budget: 255, currency: "EUR", reset_at: "2026-12-01T00:00:00Z" },
  };
  const captured = loadExtension(exhausted, SUBSCRIPTION_PAYLOAD, clock);
  await captured.handlers.get("session_start")?.({ reason: "new" }, fakeContext(captured));
  assert.equal(captured.statuses.get("mistral-budget"), "Mistral plan budget exhausted · resets 1 Dec");
  assert.equal(captured.notifications.length, 1);
  assert.equal(captured.notifications[0]?.type, "error");
  await captured.handlers.get("turn_end")?.({}, fakeContext(captured));
  assert.equal(captured.notifications.length, 1, "the exhaustion notice fires once per session");
});

test("turn_end refreshes at most once per cache window", async () => {
  const clock = { at: 0 };
  const captured = loadExtension(BUDGET_PAYLOAD, SUBSCRIPTION_PAYLOAD, clock);
  const ctx = fakeContext(captured);
  await captured.handlers.get("session_start")?.({ reason: "new" }, ctx);
  await captured.handlers.get("turn_end")?.({}, ctx);
  clock.at = 10 * 60 * 1000;
  await captured.handlers.get("turn_end")?.({}, ctx);
  assert.equal(captured.fetchCount.count, 4, "one refresh per cache window");
});

test("the status command reports the plan budget while signed in", async () => {
  const clock = { at: 0 };
  const captured = loadExtension(BUDGET_PAYLOAD, SUBSCRIPTION_PAYLOAD, clock);
  await captured.commands.get("mistral-subscription-status")?.handler("", fakeContext(captured));
  assert.equal(captured.notifications.length, 1);
  assert.match(captured.notifications[0]?.message ?? "", /^Mistral plan: INDIVIDUAL/);
  assert.match(captured.notifications[0]?.message ?? "", /Vibe Code budget: 93\.3% of €255 used/);
});

test("the status command explains a missing sign-in", async () => {
  const clock = { at: 0 };
  const captured = loadExtension(BUDGET_PAYLOAD, SUBSCRIPTION_PAYLOAD, clock);
  await captured.commands.get("mistral-subscription-status")?.handler("", fakeContext(captured, "another-provider"));
  assert.equal(captured.fetchCount.count, 0);
  assert.match(captured.notifications[0]?.message ?? "", /No Mistral sign-in is active/);
});
