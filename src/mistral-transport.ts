import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import { isRecord } from "./type-guards.ts";

// Mistral meters a completion against a plan's included Vibe Code budget only
// when the request body carries client telemetry metadata; a request without it
// is billed as pay-as-you-go API usage, which the API answers with 402 once
// that budget is exhausted. A live check (2026-11-19, owner-approved) showed a
// non-empty `metadata.call_type` is the switch and that Mistral does not
// validate its value. Mistral Vibe sends `call_type: "main_call"` with the
// constants `call_source: "vibe_code"` and `host_kind: "local"` on every
// completion, so this package mirrors those exact fields.
const ATTRIBUTION_METADATA = {
  call_type: "main_call",
  call_source: "vibe_code",
  host_kind: "local",
} as const;

// Pi's extension loader virtualizes only pi-ai's root, compat, models, oauth
// and providers/all entrypoints, so an installed extension cannot resolve
// `@earendil-works/pi-ai/api/mistral-conversations` directly. The built-in
// mistral provider exposes the same native implementation through
// providers/all, which resolves both installed and from a checkout.
const nativeMistral = builtinProviders().find((provider) => provider.id === "mistral");
if (!nativeMistral) {
  throw new Error("Pi has no built-in mistral provider to stream through.");
}
// The native dispatcher is a lexical arrow, so the bind is typing only.
const nativeMistralStreamSimple = nativeMistral.streamSimple.bind(nativeMistral);

/** Whether a request for `model` should carry the plan-attribution metadata. */
export type AttributionGate = (model: Model<Api>) => boolean;

function withAttributionMetadata(options: SimpleStreamOptions | undefined): SimpleStreamOptions {
  const onPayload = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      // Pi's own request-inspection hook runs first, so its replacement is
      // what the attribution metadata is added to.
      const next = await onPayload?.(payload, model);
      const base = next ?? payload;
      if (!isRecord(base)) return base;
      return { ...base, metadata: { ...(isRecord(base.metadata) ? base.metadata : {}), ...ATTRIBUTION_METADATA } };
    },
  };
}

/**
 * Pi's native mistral-conversations streaming, with Mistral's plan-attribution
 * metadata added when `gate` admits the model. Request conversion, SSE parsing,
 * tool handling, usage accounting and cancellation all stay in Pi's
 * implementation; this never reimplements or proxies them. While the gate
 * rejects the model, requests go out exactly as Pi ships them.
 */
export function mistralTransport(gate: AttributionGate) {
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream =>
    nativeMistralStreamSimple(model, context, gate(model) ? withAttributionMetadata(options) : options);
}
