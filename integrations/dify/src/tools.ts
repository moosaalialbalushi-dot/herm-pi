/**
 * Shared tool surface for the Dify integration.
 *
 * Both the pi extension and the MCP server expose the same operations, so the
 * naming, descriptions, argument handling and result formatting live here and
 * are wrapped in whichever tool protocol the host speaks.
 */

import { DifyApiError, type DifyClient, type DifyUsage, type DifyWorkflowResult } from "./client.ts";
import type { DifyAppConfig } from "./config.ts";

export interface DifyToolResult {
	/** Text handed back to the model. */
	text: string;
	/** Structured payload for logs and UI rendering. */
	details: DifyToolDetails;
	isError: boolean;
}

export interface DifyToolDetails {
	app: string;
	type: DifyAppConfig["type"];
	conversationId?: string;
	messageId?: string;
	workflowRunId?: string;
	status?: string;
	usage?: DifyUsage;
	totalTokens?: number;
	elapsedTime?: number;
	error?: string;
}

/** Tool name for an app. Valid for both pi tools and MCP tool names. */
export function difyToolName(app: DifyAppConfig): string {
	return `dify_${app.name}`;
}

export function difyToolLabel(app: DifyAppConfig): string {
	return `Dify: ${app.name}`;
}

export function difyToolDescription(app: DifyAppConfig): string {
	if (app.description) return app.description;
	switch (app.type) {
		case "chat":
			return `Ask the "${app.name}" Dify chat app. Pass conversation_id to continue an existing thread.`;
		case "completion":
			return `Run the "${app.name}" Dify completion app over the given inputs.`;
		case "workflow":
			return `Run the "${app.name}" Dify workflow and return its outputs.`;
	}
}

/**
 * JSON Schema for an app's arguments.
 *
 * Used directly by the MCP server; the pi extension declares the equivalent
 * TypeBox schema so pi can validate tool calls itself.
 */
export function difyInputSchema(app: DifyAppConfig): Record<string, unknown> {
	if (app.type === "chat") {
		return {
			type: "object",
			properties: {
				query: { type: "string", description: "The question or instruction to send to the app." },
				conversation_id: {
					type: "string",
					description: "Dify conversation id to continue. Omit to start a new conversation.",
				},
				inputs: {
					type: "object",
					description: "Values for the app's input variables, keyed by variable name.",
					additionalProperties: true,
				},
			},
			required: ["query"],
			additionalProperties: false,
		};
	}
	return {
		type: "object",
		properties: {
			inputs: {
				type: "object",
				description: "Values for the app's input variables, keyed by variable name.",
				additionalProperties: true,
			},
		},
		required: ["inputs"],
		additionalProperties: false,
	};
}

export interface DifyToolArgs {
	query?: string;
	conversation_id?: string;
	inputs?: Record<string, unknown>;
}

/**
 * Execute one Dify app call and format it for a tool result.
 *
 * Never throws: transport and app-level failures come back as `isError` results
 * so the model can react to them instead of the turn dying.
 */
export async function runDifyApp(
	client: DifyClient,
	app: DifyAppConfig,
	args: DifyToolArgs,
	user: string,
	signal?: AbortSignal,
): Promise<DifyToolResult> {
	const base: DifyToolDetails = { app: app.name, type: app.type };
	try {
		if (app.type === "chat") {
			const query = typeof args.query === "string" ? args.query.trim() : "";
			if (!query) {
				return { text: 'Missing required argument "query".', details: base, isError: true };
			}
			const result = await client.chat({
				query,
				inputs: args.inputs,
				conversationId: args.conversation_id,
				user,
				signal,
			});
			const details: DifyToolDetails = {
				...base,
				conversationId: result.conversationId,
				messageId: result.messageId,
				usage: result.usage,
			};
			const trailer = result.conversationId ? `\n\n[conversation_id: ${result.conversationId}]` : "";
			return { text: `${result.answer}${trailer}`, details, isError: false };
		}

		if (app.type === "completion") {
			const result = await client.complete({ inputs: args.inputs ?? {}, user, signal });
			return {
				text: result.answer,
				details: { ...base, messageId: result.messageId, usage: result.usage },
				isError: false,
			};
		}

		const result = await client.runWorkflow({ inputs: args.inputs ?? {}, user, signal });
		return formatWorkflowResult(base, result);
	} catch (error) {
		if (signal?.aborted) {
			return { text: "Call aborted.", details: { ...base, error: "aborted" }, isError: true };
		}
		const message = describeError(error, app);
		return { text: message, details: { ...base, error: message }, isError: true };
	}
}

function formatWorkflowResult(base: DifyToolDetails, result: DifyWorkflowResult): DifyToolResult {
	const details: DifyToolDetails = {
		...base,
		workflowRunId: result.workflowRunId,
		status: result.status,
		totalTokens: result.totalTokens,
		elapsedTime: result.elapsedTime,
	};

	if (result.status !== "succeeded") {
		const reason = result.error || `workflow ended with status "${result.status}"`;
		return { text: `Workflow failed: ${reason}`, details: { ...details, error: reason }, isError: true };
	}

	const outputs = result.outputs ?? {};
	const keys = Object.keys(outputs);
	// A single-output workflow is almost always a text result; returning the bare
	// value keeps it readable instead of wrapping one string in JSON.
	if (keys.length === 1 && typeof outputs[keys[0]] === "string") {
		return { text: outputs[keys[0]] as string, details, isError: false };
	}
	return { text: JSON.stringify(outputs, null, 2), details, isError: false };
}

/** Turn a thrown value into a message that says what to actually check. */
export function describeError(error: unknown, app?: DifyAppConfig): string {
	if (error instanceof DifyApiError) {
		const target = app ? `Dify app "${app.name}"` : "Dify";
		switch (error.status) {
			case 401:
			case 403:
				return `${target}: ${error.message}. The Service API key is wrong, revoked, or belongs to a different app.`;
			case 404:
				return `${target}: ${error.message}. Check the base URL includes /v1, and that any conversation_id is still valid.`;
			case 413:
				return `${target}: ${error.message}. The request exceeded the upload limit on the proxy or on Dify.`;
			case 429:
				return `${target}: ${error.message}. Rate limited by Dify or by the upstream model provider.`;
			case 504:
				return `${target}: ${error.message}. The proxy timed out before Dify answered; raise proxy_read_timeout for long workflows.`;
			default:
				return `${target}: ${error.message}`;
		}
	}
	return error instanceof Error ? error.message : String(error);
}
