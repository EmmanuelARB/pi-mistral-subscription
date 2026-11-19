import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mistralOAuth } from "../../src/mistral-oauth.ts";
import { subscriptionModels } from "../../src/mistral-overlay.ts";
import { mistralTransport } from "../../src/mistral-transport.ts";
import { MISTRAL_API_ID, MISTRAL_BASE_URL, MISTRAL_PROVIDER_ID, MISTRAL_SUBSCRIPTION_PROVIDER_ID, MODELS } from "../../src/models.ts";

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

export default function mistralSubscriptionExtension(pi: ExtensionAPI) {
  // Whether the active session's mistral requests run on the subscription
  // sign-in; refreshed from the events that see the active model. The transport
  // adds Mistral's plan-attribution metadata only while this is set, so plain
  // API-key use of `mistral` stays exactly as Pi ships it. The deprecated
  // provider has no API-key path, so it always counts as signed in.
  let signInActive = false;
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

  pi.on("session_start", (_event, ctx) => {
    warnIfDeprecated(ctx.model, ctx);
    signInActive = usesSignIn(ctx.model, ctx);
  });
  pi.on("model_select", (event, ctx) => {
    warnIfDeprecated(event.model, ctx);
    signInActive = usesSignIn(event.model, ctx);
  });

  pi.registerCommand("mistral-subscription-status", {
    description: "Show how the Mistral subscription sign-in is wired into Pi",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `${MISTRAL_PROVIDER_ID} accepts Mistral AI Studio browser sign-in through /login and uses Pi's built-in models and streaming.`,
        "info",
      );
    },
  });
}
