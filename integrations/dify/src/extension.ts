/**
 * pi extension for a self-hosted Dify instance.
 *
 * Registers one tool per configured Dify app so the coding agent can call
 * chat apps, completion apps and workflows mid-session, adds a `/dify`
 * connectivity check, and optionally exposes chat apps as pi models.
 *
 * Loaded from `.pi/extensions/dify.ts` in this repo; configured through
 * `integrations/dify/dify.config.json` or `DIFY_BASE_URL` + `DIFY_API_KEY`.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chatAnswerDelta, DifyClient } from "./client.ts";
import { type DifyAppConfig, type DifyConfig, DifyConfigError, loadDifyConfig } from "./config.ts";
import { checkApps, formatReport } from "./doctor.ts";
import {
	type DifyToolDetails,
	describeError,
	difyToolDescription,
	difyToolLabel,
	difyToolName,
	runDifyApp,
} from "./tools.ts";

/** Custom api id for the Dify stream handler. Must be unique across providers. */
const DIFY_API: Api = "dify-chat-messages";
const PROVIDER_NAME = "dify";

const CHAT_PARAMS = Type.Object({
	query: Type.String({ description: "The question or instruction to send to the Dify app." }),
	conversation_id: Type.Optional(
		Type.String({
			description: "Dify conversation id from a previous call, to continue that thread. Omit to start a new one.",
		}),
	),
	inputs: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Values for the app's input variables, keyed by variable name.",
		}),
	),
});

const INPUT_PARAMS = Type.Object({
	inputs: Type.Record(Type.String(), Type.Unknown(), {
		description: "Values for the app's input variables, keyed by variable name.",
	}),
});

export default function difyExtension(pi: ExtensionAPI): void {
	let config: DifyConfig | undefined;
	let loadError: string | undefined;

	try {
		config = loadDifyConfig();
	} catch (error) {
		// A broken config must not take pi's startup down with it; surface it
		// on session_start and via /dify instead.
		loadError = error instanceof DifyConfigError ? error.message : String(error);
	}

	const clients = new Map<string, DifyClient>();
	const clientFor = (app: DifyAppConfig): DifyClient => {
		let client = clients.get(app.name);
		if (!client) {
			client = new DifyClient({
				baseUrl: app.baseUrl ?? config!.baseUrl,
				apiKey: app.apiKey,
				timeoutMs: app.timeoutMs,
			});
			clients.set(app.name, client);
		}
		return client;
	};

	pi.registerCommand("dify", {
		description: "Check Dify connectivity and list configured apps",
		handler: async (_args, ctx) => {
			if (loadError) {
				ctx.ui.notify(loadError, "error");
				return;
			}
			if (!config) {
				ctx.ui.notify(
					"No Dify configuration found. Copy integrations/dify/dify.config.example.json to " +
						"integrations/dify/dify.config.json, or set DIFY_BASE_URL and DIFY_API_KEY.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(`Checking ${config.apps.length} Dify app(s)...`, "info");
			const results = await checkApps(config);
			pi.sendMessage(
				{ customType: "dify-status", content: formatReport(config, results), display: true },
				{ triggerTurn: false },
			);
		},
	});

	if (!config) {
		if (loadError) {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify(`Dify extension disabled: ${loadError}`, "error");
			});
		}
		return;
	}

	const activeConfig = config;

	for (const app of activeConfig.apps) {
		const description = difyToolDescription(app);
		if (app.type === "chat") {
			pi.registerTool(
				defineTool({
					name: difyToolName(app),
					label: difyToolLabel(app),
					description,
					promptSnippet: `Ask the "${app.name}" Dify app`,
					parameters: CHAT_PARAMS,
					executionMode: "parallel",
					async execute(_toolCallId, params, signal) {
						const result = await runDifyApp(
							clientFor(app),
							app,
							{ query: params.query, conversation_id: params.conversation_id, inputs: params.inputs },
							activeConfig.user,
							signal,
						);
						// pi marks a tool call failed when execute throws; there is no
						// isError field on the result.
						if (result.isError) throw new Error(result.text);
						return {
							content: [{ type: "text", text: result.text }],
							details: result.details satisfies DifyToolDetails,
						};
					},
				}),
			);
			continue;
		}

		pi.registerTool(
			defineTool({
				name: difyToolName(app),
				label: difyToolLabel(app),
				description,
				promptSnippet: `Run the "${app.name}" Dify ${app.type}`,
				parameters: INPUT_PARAMS,
				executionMode: "parallel",
				async execute(_toolCallId, params, signal) {
					const result = await runDifyApp(
						clientFor(app),
						app,
						{ inputs: params.inputs },
						activeConfig.user,
						signal,
					);
					if (result.isError) throw new Error(result.text);
					return {
						content: [{ type: "text", text: result.text }],
						details: result.details satisfies DifyToolDetails,
					};
				},
			}),
		);
	}

	if (!activeConfig.registerProvider) return;

	const providerApps = activeConfig.apps.filter((app) => app.type === "chat" && app.provider);
	if (providerApps.length === 0) return;

	pi.registerProvider(PROVIDER_NAME, {
		name: "Dify",
		baseUrl: activeConfig.baseUrl,
		// Keys are per-app and read from the Dify config; this satisfies pi's
		// "a provider with models needs a key" check without carrying a real one.
		apiKey: "configured-per-app",
		api: DIFY_API,
		streamSimple: createDifyStream(activeConfig, clientFor),
		models: providerApps.map((app) => ({
			id: app.name,
			// Tool calling is surfaced in the name: a Dify app answers with text
			// only, so pi's coding loop cannot drive tools through these models.
			name: `${app.name} (Dify, text only)`,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: activeConfig.providerContextWindow,
			maxTokens: activeConfig.providerMaxTokens,
		})),
	});
}

/**
 * Build the `streamSimple` handler backing the `dify` provider.
 *
 * Dify keeps conversation history server-side, so each turn sends only the
 * latest user message and replays the conversation id issued for this thread.
 */
function createDifyStream(
	config: DifyConfig,
	clientFor: (app: DifyAppConfig) => DifyClient,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	const conversations = new Map<string, string>();

	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();

		void (async () => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};

			try {
				stream.push({ type: "start", partial: output });

				const app = config.apps.find((candidate) => candidate.name === model.id);
				if (!app) throw new Error(`No Dify app configured for model "${model.id}"`);

				const query = lastUserText(context);
				if (!query) throw new Error("No user message to send to Dify");

				const threadKey = `${model.id}:${firstUserText(context).slice(0, 200)}`;
				const block = { type: "text" as const, text: "" };
				output.content.push(block);
				const contentIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex, partial: output });

				let promptTokens = 0;
				let completionTokens = 0;

				for await (const event of clientFor(app).chatStream({
					query,
					conversationId: conversations.get(threadKey),
					user: config.user,
					signal: options?.signal,
				})) {
					if (event.event === "error") {
						throw new Error(typeof event.message === "string" ? event.message : "Dify returned an error event");
					}
					if (typeof event.conversation_id === "string" && event.conversation_id) {
						conversations.set(threadKey, event.conversation_id);
					}

					const delta = chatAnswerDelta(event);
					if (delta) {
						block.text += delta;
						stream.push({ type: "text_delta", contentIndex, delta, partial: output });
					}

					if (event.event === "message_end") {
						const usage = (event.metadata as { usage?: Record<string, number> } | undefined)?.usage;
						promptTokens = usage?.prompt_tokens ?? 0;
						completionTokens = usage?.completion_tokens ?? 0;
					}
				}

				stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });

				output.usage.input = promptTokens;
				output.usage.output = completionTokens;
				output.usage.totalTokens = promptTokens + completionTokens;
				calculateCost(model, output.usage);
				output.stopReason = "stop";

				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = describeError(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	};
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role === "user") return messageText(message);
	}
	return "";
}

function firstUserText(context: Context): string {
	for (const message of context.messages) {
		if (message.role === "user") return messageText(message);
	}
	return "";
}

function messageText(message: Message): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
