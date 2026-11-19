import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type FetchLike,
  fetchMistralBudget,
  formatBudgetLine,
  formatBudgetSummary,
  type MistralBudget,
  vibeBudgetLevel,
} from "../../src/mistral-budget.ts";
import { mistralOAuth } from "../../src/mistral-oauth.ts";
import { subscriptionModels } from "../../src/mistral-overlay.ts";
import { mistralTransport } from "../../src/mistral-transport.ts";
import {
  MISTRAL_API_ID,
  MISTRAL_BASE_URL,
  MISTRAL_PROVIDER_ID,
  MISTRAL_SUBSCRIPTION_PROVIDER_ID,
  MODELS,
} from "../../src/models.ts";

function warnIfDeprecated(model: ExtensionContext["model"], ctx: ExtensionContext) {
  if (model?.provider !== MISTRAL_SUBSCRIPTION_PROVIDER_ID) return;
  const replacement = model.id === "devstral-small-latest" ? "devstral-latest" : model.id;
  ctx.ui.notify(
    `${MISTRAL_SUBSCRIPTION_PROVIDER_ID} is deprecated. Run /login, sign in to Mistral, and use mistral/${replacement}.`,
    "warning",
  );
}

function usesSignIn(model: ExtensionContext["model"], ctx: ExtensionContext): model is NonNullable<typeof model> {
  return model?.provider === MISTRAL_PROVIDER_ID && ctx.modelRegistry.isUsingOAuth(model);
}

// Both providers bill the plan while a sign-in is active; the deprecated one has
// no API-key path, so it always counts as signed in.
function onSubscription(model: ExtensionContext["model"], ctx: ExtensionContext): boolean {
  return model?.provider === MISTRAL_SUBSCRIPTION_PROVIDER_ID || usesSignIn(model, ctx);
}

export type MistralSubscriptionDependencies = {
  /** Injected by tests; defaults to the global fetch. */
  fetch?: FetchLike;
  /** Injected by tests; defaults to Date.now. */
  now?: () => number;
};

export default function mistralSubscriptionExtension(
  pi: ExtensionAPI,
  dependencies: MistralSubscriptionDependencies = {},
) {
  const fetchLike: FetchLike = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now: () => number = dependencies.now ?? Date.now;
  // The transport gate mirrors onSubscription from the events that see the
  // active model: only requests on the plan carry the plan-attribution metadata,
  // so plain API-key use of `mistral` stays exactly as Pi ships it. The stream
  // itself stays Pi's native implementation.
  const streamSimple = mistralTransport((model) => model.provider === MISTRAL_SUBSCRIPTION_PROVIDER_ID || signInActive);

  pi.registerProvider(MISTRAL_PROVIDER_ID, {
    api: MISTRAL_API_ID,
    streamSimple,
    oauth: { ...mistralOAuth, modifyModels: subscriptionModels },
  });

  // Without this provider, existing settings and sessions silently fall back to
  // another provider or model. It keeps them working until they move to `mistral`.
  pi.registerProvider(MISTRAL_SUBSCRIPTION_PROVIDER_ID, {
    name: "Mistral subscription (deprecated)",
    baseUrl: MISTRAL_BASE_URL,
    api: MISTRAL_API_ID,
    streamSimple,
    authHeader: true,
    models: [...MODELS],
    oauth: { ...mistralOAuth, name: "Mistral subscription (deprecated)" },
  });

  // The plan budget footer line. Refreshed at most once per TTL window; the
  // reads are free platform reads, so the TTL is politeness, not cost.
  const BUDGET_STATUS_KEY = "mistral-budget";
  const BUDGET_CACHE_TTL_MS = 10 * 60 * 1000;
  let budgetCache: { at: number; budget: MistralBudget } | null = null;
  let budgetNotified = false;
  // Whether the active session's mistral requests run on the subscription
  // sign-in; refreshed from the events that see the active model.
  let signInActive = false;

  function refreshSignInState(model: ExtensionContext["model"], ctx: ExtensionContext) {
    signInActive = onSubscription(model, ctx);
  }

  function resetBudgetState() {
    budgetCache = null;
    budgetNotified = false;
  }

  async function readBudget(ctx: ExtensionContext, { force = false } = {}): Promise<MistralBudget | null> {
    // Print and JSON modes have nowhere to show a status, and slash commands need UI anyway.
    if (!ctx.hasUI || !onSubscription(ctx.model, ctx)) return null;
    if (!force && budgetCache && now() - budgetCache.at < BUDGET_CACHE_TTL_MS) return budgetCache.budget;
    // The deprecated provider stores its sign-in under its own id.
    const keyProvider =
      ctx.model?.provider === MISTRAL_SUBSCRIPTION_PROVIDER_ID ? MISTRAL_SUBSCRIPTION_PROVIDER_ID : MISTRAL_PROVIDER_ID;
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(keyProvider);
    if (!apiKey) return null;
    const budget = await fetchMistralBudget(fetchLike, apiKey);
    if (!budget) return null;
    budgetCache = { at: now(), budget };
    return budget;
  }

  async function showBudgetStatus(ctx: ExtensionContext, { force = false } = {}) {
    const budget = await readBudget(ctx, { force });
    if (!budget) return;
    const line = formatBudgetLine(budget);
    // notify travels to Paseo as a timeline notification; setStatus stays in the Pi footer.
    if (line) ctx.ui.setStatus(BUDGET_STATUS_KEY, line);
    const level = vibeBudgetLevel(budget);
    if (level === "ok" || budgetNotified) return;
    budgetNotified = true;
    if (level === "exhausted") {
      ctx.ui.notify(
        "Mistral plan budget is exhausted; requests will fail with 402 until it resets. Pay-as-you-go is off by default.",
        "error",
      );
    } else {
      ctx.ui.notify("Mistral plan budget is almost exhausted.", "warning");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    warnIfDeprecated(ctx.model, ctx);
    refreshSignInState(ctx.model, ctx);
    resetBudgetState();
    await showBudgetStatus(ctx, { force: true });
  });
  pi.on("model_select", async (event, ctx) => {
    warnIfDeprecated(event.model, ctx);
    refreshSignInState(event.model, ctx);
    if (!onSubscription(event.model, ctx)) {
      ctx.ui.setStatus(BUDGET_STATUS_KEY, undefined);
    }
  });
  // Turn ends move the plan budget, so this is the natural refresh point. The
  // cache keeps it to one free read per TTL window.
  pi.on("turn_end", async (_event, ctx) => {
    void showBudgetStatus(ctx);
  });

  pi.registerCommand("mistral-subscription-status", {
    description: "Show the Mistral subscription sign-in state and plan budget",
    handler: async (_args, ctx) => {
      if (!onSubscription(ctx.model, ctx)) {
        ctx.ui.notify("No Mistral sign-in is active. Run /login and choose Mistral to use your plan.", "info");
        return;
      }
      const budget = await readBudget(ctx, { force: true });
      if (!budget) {
        ctx.ui.notify("Mistral did not answer the plan budget reads.", "warning");
        return;
      }
      const summary = formatBudgetSummary(budget);
      ctx.ui.notify(summary ?? "Mistral answered without budget details.", "info");
    },
  });
}
