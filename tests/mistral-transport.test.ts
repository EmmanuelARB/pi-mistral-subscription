import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { type Model, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";

import mistralSubscriptionExtension from "../extensions/mistral-subscription/index.ts";
import { mistralTransport } from "../src/mistral-transport.ts";
import { MISTRAL_PROVIDER_ID, MISTRAL_SUBSCRIPTION_PROVIDER_ID, MODELS } from "../src/models.ts";

const ATTRIBUTION_METADATA = { call_type: "main_call", call_source: "vibe_code", host_kind: "local" };

async function requestPayload(
  streamSimple: NonNullable<ProviderConfig["streamSimple"]>,
  provider: string,
  options?: SimpleStreamOptions,
): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    payload = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = MODELS.find((model) => model.id === "mistral-medium-3.5");
    assert.ok(config, "mistral-medium-3.5 is registered");
    const model = {
      ...config,
      api: "mistral-conversations",
      compat: undefined,
      provider,
      baseUrl: `http://127.0.0.1:${address.port}`,
    } as unknown as Model<"mistral-conversations">;
    const context = normalizeContext({
      systemPrompt: "You are running a connectivity test.",
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    });
    const result = await streamSimple(model, context, {
      apiKey: "placeholder-test-key",
      ...options,
    }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.ok(payload, "request reached the local test server");
    return payload;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function registerExtension(): {
  registrations: Map<string, ProviderConfig>;
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
} {
  const registrations = new Map<string, ProviderConfig>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  mistralSubscriptionExtension({
    registerProvider: (id: string, config: ProviderConfig) => registrations.set(id, config),
    registerCommand: () => {},
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(event, handler),
  } as unknown as ExtensionAPI);
  return { registrations, handlers };
}

function fakeContext(signedIn: boolean): ExtensionContext {
  return {
    model: { provider: MISTRAL_PROVIDER_ID, id: "mistral-medium-3.5" },
    modelRegistry: { isUsingOAuth: () => signedIn },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
}

test("an admitted model carries the plan-attribution metadata", async () => {
  const streamSimple = mistralTransport(() => true);
  const payload = await requestPayload(streamSimple, MISTRAL_PROVIDER_ID);
  assert.deepEqual(payload.metadata, ATTRIBUTION_METADATA);
});

test("a rejected model goes out exactly as Pi ships it", async () => {
  const streamSimple = mistralTransport(() => false);
  const payload = await requestPayload(streamSimple, MISTRAL_PROVIDER_ID);
  assert.equal(payload.metadata, undefined);
});

test("Pi's own payload hook runs first and its replacement keeps the metadata", async () => {
  let hookCalled = false;
  const streamSimple = mistralTransport(() => true);
  const payload = await requestPayload(streamSimple, MISTRAL_PROVIDER_ID, {
    temperature: 0.2,
    onPayload: async (value, model) => {
      hookCalled = true;
      assert.equal(model.id, "mistral-medium-3.5");
      const original = value as Record<string, unknown>;
      return { ...original, temperature: 0.3, metadata: { session_id: "kept" } };
    },
  });
  assert.ok(hookCalled);
  assert.equal(payload.temperature, 0.3);
  assert.deepEqual(payload.metadata, { session_id: "kept", ...ATTRIBUTION_METADATA });
});

test("the extension gates the metadata on the active sign-in", async () => {
  const { registrations, handlers } = registerExtension();
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start is handled");
  const mistral = registrations.get(MISTRAL_PROVIDER_ID)?.streamSimple;
  assert.ok(mistral, "the built-in provider streams through the extension transport");

  await sessionStart({}, fakeContext(true));
  assert.deepEqual(
    (await requestPayload(mistral, MISTRAL_PROVIDER_ID)).metadata,
    ATTRIBUTION_METADATA,
    "signed-in requests carry the metadata",
  );

  await sessionStart({}, fakeContext(false));
  assert.equal(
    (await requestPayload(mistral, MISTRAL_PROVIDER_ID)).metadata,
    undefined,
    "API-key requests stay exactly as Pi ships them",
  );
});

test("the deprecated provider is always signed in", async () => {
  const { registrations, handlers } = registerExtension();
  await handlers.get("session_start")?.({}, fakeContext(false));
  const deprecated = registrations.get(MISTRAL_SUBSCRIPTION_PROVIDER_ID)?.streamSimple;
  assert.ok(deprecated, "the deprecated provider streams through the extension transport");
  assert.deepEqual((await requestPayload(deprecated, MISTRAL_SUBSCRIPTION_PROVIDER_ID)).metadata, ATTRIBUTION_METADATA);
});

test("both registrations declare the api their transport replaces", () => {
  const { registrations } = registerExtension();
  for (const id of [MISTRAL_PROVIDER_ID, MISTRAL_SUBSCRIPTION_PROVIDER_ID]) {
    const config = registrations.get(id);
    assert.ok(config, `${id} is registered`);
    assert.equal(config.api, "mistral-conversations");
    assert.equal(typeof config.streamSimple, "function");
  }
});
