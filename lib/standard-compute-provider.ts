import * as piAi from "@earendil-works/pi-ai";
import type { Provider, ProviderStreams, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// Standard Compute Provider ID
export const STANDARDCOMPUTE_PROVIDER_ID = "standardcompute";
// Standard Compute Base URL (OpenAI-compatible endpoint)
export const STANDARDCOMPUTE_BASE_URL = "https://api.stdcmpt.com/v1";
// Smart routing entry model id accepted by the OpenAI-compatible endpoints
export const STANDARDCOMPUTE_MODEL_ID = "standardcompute";
export const STANDARDCOMPUTE_MODELS_TIMEOUT_MS = 3_000;

export interface StandardComputeProviderOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

type StandardComputeChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

// Pi requires numeric rates; Standard Compute does not publish per-token prices.
// Zero is a placeholder, not a claim that usage is free.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Smart routing picks the enabled model per request, so the fallback declares the
// documented ceiling (context windows up to ~1M tokens) instead of a pinned model.
const SMART_ROUTING_MODEL_ID = STANDARDCOMPUTE_MODEL_ID;

// Pi thinking levels pass through as OpenAI-style reasoning_effort; off omits the
// effort (the provider default), so no explicit off mapping is required.
const SMART_THINKING_LEVEL_MAP: StandardComputeChatModelConfig["thinkingLevelMap"] = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const SMART_ROUTING_MODEL: StandardComputeChatModelConfig = {
	id: SMART_ROUTING_MODEL_ID,
	name: "StandardCompute",
	input: ["text", "image"],
	contextWindow: 1_000_000,
	reasoning: true,
	maxTokens: 1_000_000,
	thinkingLevelMap: SMART_THINKING_LEVEL_MAP,
	cost: ZERO_COST,
};

function cloneModel(model: StandardComputeChatModelConfig): StandardComputeChatModelConfig {
	return {
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		thinkingLevelMap: model.thinkingLevelMap ? structuredClone(model.thinkingLevelMap) : undefined,
		...(model.compat ? { compat: { ...model.compat } } : {}),
	};
}

function cloneCatalog(models: readonly StandardComputeChatModelConfig[]): StandardComputeChatModelConfig[] {
	return models.map(cloneModel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Live model rows keep the capabilities and context limit validated by the gateway.
export interface StandardComputeModelRow {
	id: string;
	contextLength?: number;
	inputModalities?: string[];
	reasoning?: boolean;
	supportedParameters?: string[];
}

function buildCatalog(rows: readonly StandardComputeModelRow[]): StandardComputeChatModelConfig[] {
	const models = new Map<string, StandardComputeChatModelConfig>();
	for (const row of rows) {
		const id = row.id.trim();
		if (!id) continue;
		if (id.toLowerCase() === SMART_ROUTING_MODEL_ID) {
			models.set(SMART_ROUTING_MODEL_ID, cloneModel(SMART_ROUTING_MODEL));
			continue;
		}
		const contextLength = typeof row.contextLength === "number" && row.contextLength > 0 ? row.contextLength : 1_000_000;
		models.set(id, {
			id,
			name: id,
			input: row.inputModalities && row.inputModalities.length > 0 ? row.inputModalities : ["text", "image"],
			contextWindow: contextLength,
			reasoning: row.reasoning ?? true,
			maxTokens: contextLength,
			api: "openai-completions",
			cost: ZERO_COST,
		} as StandardComputeChatModelConfig);
	}
	return [...models.values()];
}

/** Returns undefined on an unusable response; an empty data array is authoritative. */
async function fetchLiveModelIds(options: {
	apiKey?: string;
	signal: AbortSignal;
	fetchImpl: typeof fetch;
	timeoutMs: number;
}): Promise<StandardComputeModelRow[] | undefined> {
	const { apiKey, signal, fetchImpl, timeoutMs } = options;
	if (signal.aborted) return undefined;

	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const response = await fetchImpl(`${STANDARDCOMPUTE_BASE_URL}/models`, {
			method: "GET",
			headers,
			signal: controller.signal,
			redirect: "error",
			cache: "no-store",
		});
		if (!response.ok) return undefined;

		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
		if (payload.data.length === 0) return [];

		const rows: StandardComputeModelRow[] = [];
		for (const row of payload.data) {
			if (!isRecord(row) || typeof row.id !== "string") continue;
			const id = row.id.trim();
			if (!id) continue;
			const architecture = isRecord(row.architecture) ? row.architecture : undefined;
			rows.push({
				id,
			contextLength: typeof row.context_length === "number" ? row.context_length : undefined,
				inputModalities: Array.isArray(architecture?.input_modalities) ? architecture.input_modalities.filter((m): m is string => typeof m === "string") : undefined,
				reasoning: typeof row.reasoning === "boolean" ? row.reasoning : undefined,
				supportedParameters: Array.isArray(row.supported_parameters) ? row.supported_parameters.filter((p): p is string => typeof p === "string") : undefined,
			});
		}
		return rows.length > 0 ? rows : undefined;
	} catch {
		// Discovery is best-effort. Never log request or response data: it may contain credentials.
		return undefined;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
}

function createCatalogConfig(options: StandardComputeProviderOptions = {}): {
	getModels(): StandardComputeChatModelConfig[];
	refreshModels(context: RefreshModelsContext): Promise<void>;
} {
	let catalog = cloneCatalog([SMART_ROUTING_MODEL]);
	let catalogKey: string | undefined;
	let credentialRevision = 0;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	return {
		getModels: () => cloneCatalog(catalog),
		refreshModels: async (context: RefreshModelsContext) => {
			const storedKey = context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined;
			// Effective authentication: an explicit stored key wins, otherwise the provider env key applies.
			const effectiveKey = storedKey || (process.env.STANDARDCOMPUTE_API_KEY ?? "").trim() || undefined;
			if (effectiveKey !== catalogKey) {
				// A live catalog is authoritative only for the credential that discovered it.
				catalogKey = effectiveKey;
				credentialRevision++;
				catalog = cloneCatalog([SMART_ROUTING_MODEL]);
			}
			const revision = credentialRevision;
			if (!context.allowNetwork || context.signal.aborted || typeof fetchImpl !== "function") {
				return;
			}

			const rows = await fetchLiveModelIds({
				apiKey: effectiveKey,
				signal: context.signal,
				fetchImpl,
				timeoutMs: options.timeoutMs ?? STANDARDCOMPUTE_MODELS_TIMEOUT_MS,
			});
			if (revision !== credentialRevision || rows === undefined || context.signal.aborted) {
				// Preserve the discovered catalog when the credential identity is unchanged and the refresh failed.
				return;
			}

			await context.publish({ update: () => {
				if (revision === credentialRevision && !context.signal.aborted) catalog = buildCatalog(rows);
			} });
		},
	};
}

/** Native auth belongs to the provider; Pi persists only a successful login result. */
export function createStandardComputeProviderConfig(options: StandardComputeProviderOptions = {}): Provider<"openai-completions"> {
	const config = createCatalogConfig(options);
	// Pi's extension loader aliases the bare root to compat, which exposes this
	// host-owned lazy API factory.
	const api = piAi.lazyApi(async () => {
		const runtime = piAi as typeof piAi & { openAICompletionsApi?: () => ProviderStreams };
		if (!runtime.openAICompletionsApi) throw new Error("Standard Compute requires Pi's OpenAI completions API factory");
		return runtime.openAICompletionsApi();
	});

	return {
		id: STANDARDCOMPUTE_PROVIDER_ID,
		name: "Standard Compute",
		baseUrl: STANDARDCOMPUTE_BASE_URL,
		auth: {
			apiKey: {
				name: "Standard Compute API key",
				async login(interaction) {
					interaction.signal.throwIfAborted();
					const entered = await interaction.prompt({
						type: "secret", message: "Enter Standard Compute API Key", signal: interaction.signal,
					});
					interaction.signal.throwIfAborted();
					const key = entered.trim();
					if (!key) throw new Error("Standard Compute requires a non-empty API key");
					return { type: "api_key", key };
				},
				async resolve({ ctx, credential, signal }) {
					signal.throwIfAborted();
					const stored = credential?.key?.trim();
					const key = stored || (await ctx.env("STANDARDCOMPUTE_API_KEY"))?.trim();
					signal.throwIfAborted();
					return key ? { auth: { apiKey: key }, source: stored ? "API key" : "STANDARDCOMPUTE_API_KEY" } : undefined;
				},
			},
		},
		getModels: () => config.getModels().map((model) => ({
			...cloneModel(model), provider: STANDARDCOMPUTE_PROVIDER_ID,
			baseUrl: STANDARDCOMPUTE_BASE_URL, api: "openai-completions" as const,
		})),
		refreshModels: (context) => config.refreshModels(context),
		stream: api.stream,
		streamSimple: api.streamSimple,
	};
}
