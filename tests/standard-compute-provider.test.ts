import assert from "node:assert/strict";
import test from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import {
	createStandardComputeProviderConfig,
	STANDARDCOMPUTE_BASE_URL,
	STANDARDCOMPUTE_MODEL_ID,
	STANDARDCOMPUTE_PROVIDER_ID,
} from "../lib/standard-compute-provider.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function refreshContext(credential?: RefreshModelsContext["credential"]): RefreshModelsContext {
	return {
		credential,
		stored: undefined,
		allowNetwork: true,
		signal: new AbortController().signal,
		async publish(publication) {
			publication.update?.();
			return true;
		},
	};
}

test("standard compute refresh publishes discovered models with their validated context and modalities", async () => {
	const provider = createStandardComputeProviderConfig({
		fetchImpl: async () =>
			jsonResponse({
				data: [
					{
						id: "gpt-standard-9",
						context_length: 123456,
						architecture: { input_modalities: ["text", "image"] },
						reasoning: true,
						supported_parameters: ["max_tokens"],
					},
					{ id: STANDARDCOMPUTE_MODEL_ID, context_length: 999 },
				],
			}),
	});

	await provider.refreshModels(refreshContext({ type: "api_key", key: "sk-test" }));

	const discovered = provider.getModels().find((model) => model.id === "gpt-standard-9");
	assert.ok(discovered, "expected the discovered model to be advertised");
	assert.equal(discovered.contextWindow, 123456);
	assert.deepEqual(discovered.input, ["text", "image"]);
	assert.equal(discovered.reasoning, true);
});

test("standard compute keeps the discovered catalog when a refresh with an unchanged credential fails", async () => {
	const modelsPayload = {
		data: [
			{
				id: "gpt-standard-9",
				context_length: 123456,
				architecture: { input_modalities: ["text", "image"] },
				reasoning: true,
			},
		],
	};
	let mode: "ok" | "fail" = "ok";
	const provider = createStandardComputeProviderConfig({
		fetchImpl: async () => (mode === "ok" ? jsonResponse(modelsPayload) : jsonResponse({ error: "boom" }, 500)),
	});

	await provider.refreshModels(refreshContext({ type: "api_key", key: "sk-test" }));
	mode = "fail";
	await provider.refreshModels(refreshContext({ type: "api_key", key: "sk-test" }));

	const discovered = provider.getModels().find((model) => model.id === "gpt-standard-9");
	assert.ok(discovered, "expected the discovered model to survive a failed refresh");
	assert.equal(discovered.contextWindow, 123456);
});

test("standard compute smart routing keeps the documented ceiling context window", async () => {
	const provider = createStandardComputeProviderConfig();
	await provider.refreshModels(refreshContext({ type: "api_key", key: "sk-test" }));

	const routing = provider.getModels().find((model) => model.id === STANDARDCOMPUTE_MODEL_ID);
	assert.ok(routing, "expected the smart routing model to be advertised");
	assert.equal(routing.contextWindow, 1_000_000);
	assert.equal(routing.maxTokens, 1_000_000);
	assert.equal(provider.id, STANDARDCOMPUTE_PROVIDER_ID);
	assert.equal(provider.baseUrl, STANDARDCOMPUTE_BASE_URL);
});
