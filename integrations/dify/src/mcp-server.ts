/**
 * MCP stdio server exposing Dify apps as tools.
 *
 * Runs standalone on the Hermes VM with no npm dependencies: MCP over stdio is
 * newline-delimited JSON-RPC 2.0, so the whole transport is a few dozen lines
 * and the server can be dropped onto a box with nothing but Node installed.
 *
 *   node integrations/dify/src/mcp-server.ts [--config <path>]
 *
 * stdout carries protocol traffic only. Diagnostics go to stderr.
 */

import { pathToFileURL } from "node:url";
import { DifyClient } from "./client.ts";
import { type DifyAppConfig, type DifyConfig, DifyConfigError, loadDifyConfig } from "./config.ts";
import { difyInputSchema, difyToolDescription, difyToolName, runDifyApp } from "./tools.ts";

const SERVER_NAME = "dify";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** A JSON-RPC 2.0 request id. Absent means notification; null is a real id. */
type JsonRpcId = string | number | null;

/**
 * A decoded request. Every field is optional because these arrive off the wire:
 * `handle` is what establishes that they are well-formed.
 */
interface JsonRpcRequest {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: Record<string, unknown>;
}

interface JsonRpcError {
	code: number;
	message: string;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export class DifyMcpServer {
	private readonly config: DifyConfig;
	private readonly clients = new Map<string, DifyClient>();
	/** In-flight tool calls by request id, so notifications/cancelled can abort them. */
	private readonly active = new Map<string | number, AbortController>();

	constructor(config: DifyConfig) {
		this.config = config;
	}

	/**
	 * Handle one decoded request. Returns undefined when nothing may be sent:
	 * a notification, or a call the client cancelled.
	 *
	 * Only a missing `id` marks a notification. `id: null` is a legal request id
	 * in JSON-RPC 2.0 and must still be answered, with `id: null` echoed back.
	 */
	async handle(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
		const isNotification = request.id === undefined;
		const id = request.id ?? null;

		if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
			return isNotification ? undefined : this.errorResponse(id, INVALID_REQUEST, "Invalid JSON-RPC request");
		}

		try {
			const response = await this.dispatch(request, id);
			// Every result path funnels through here, so an id-less request can
			// never emit a protocol response.
			return isNotification ? undefined : response;
		} catch (error) {
			if (isNotification) return undefined;
			return this.errorResponse(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
		}
	}

	private async dispatch(request: JsonRpcRequest, id: JsonRpcId): Promise<Record<string, unknown> | undefined> {
		switch (request.method) {
			case "initialize": {
				const requested = (request.params as { protocolVersion?: string } | undefined)?.protocolVersion;
				const protocolVersion =
					requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
				return this.result(id, {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				});
			}

			case "notifications/cancelled": {
				const requestId = (request.params as { requestId?: string | number } | undefined)?.requestId;
				if (requestId !== undefined) this.active.get(requestId)?.abort();
				return undefined;
			}

			case "notifications/initialized":
				return undefined;

			case "ping":
				return this.result(id, {});

			case "tools/list":
				return this.result(id, {
					tools: this.config.apps.map((app) => ({
						name: difyToolName(app),
						description: difyToolDescription(app),
						inputSchema: difyInputSchema(app),
					})),
				});

			case "tools/call":
				return await this.callTool(request, id);

			default:
				return this.errorResponse(id, METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
		}
	}

	private async callTool(request: JsonRpcRequest, id: JsonRpcId): Promise<Record<string, unknown> | undefined> {
		const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
		if (typeof params.name !== "string") {
			return this.errorResponse(id, INVALID_PARAMS, 'tools/call requires a "name" parameter');
		}

		const app = this.config.apps.find((candidate) => difyToolName(candidate) === params.name);
		if (!app) {
			return this.errorResponse(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
		}

		// Registering the controller lets notifications/cancelled abort the Dify
		// request rather than leaving it to run out its timeout.
		const controller = new AbortController();
		if (id !== null) this.active.set(id, controller);

		const args = params.arguments ?? {};
		try {
			const result = await runDifyApp(
				this.clientFor(app),
				app,
				{
					query: typeof args.query === "string" ? args.query : undefined,
					conversation_id: typeof args.conversation_id === "string" ? args.conversation_id : undefined,
					inputs: isPlainObject(args.inputs) ? args.inputs : undefined,
				},
				this.config.user,
				controller.signal,
			);

			// A cancelled call gets no response at all; sending one would answer a
			// request the client has already stopped waiting for.
			if (controller.signal.aborted) return undefined;

			// Tool failures ride back as a successful JSON-RPC response with
			// isError set: that is how MCP lets the model see and react to them.
			return this.result(id, {
				content: [{ type: "text", text: result.text }],
				isError: result.isError,
				structuredContent: result.details as unknown as Record<string, unknown>,
			});
		} finally {
			if (id !== null) this.active.delete(id);
		}
	}

	private clientFor(app: DifyAppConfig): DifyClient {
		let client = this.clients.get(app.name);
		if (!client) {
			client = new DifyClient({
				baseUrl: app.baseUrl ?? this.config.baseUrl,
				apiKey: app.apiKey,
				timeoutMs: app.timeoutMs,
			});
			this.clients.set(app.name, client);
		}
		return client;
	}

	private result(id: JsonRpcId, result: Record<string, unknown>): Record<string, unknown> {
		return { jsonrpc: "2.0", id, result };
	}

	private errorResponse(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
		const error: JsonRpcError = { code, message };
		return { jsonrpc: "2.0", id, error };
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || typeof value === "number" || value === null;
}

function errorEnvelope(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

async function main(): Promise<void> {
	const configFlag = process.argv.indexOf("--config");
	if (configFlag !== -1) {
		const path = process.argv[configFlag + 1];
		if (!path) {
			console.error("--config requires a path");
			process.exit(2);
		}
		process.env.DIFY_CONFIG = path;
	}

	let config: DifyConfig | undefined;
	try {
		config = loadDifyConfig();
	} catch (error) {
		console.error(error instanceof DifyConfigError ? error.message : String(error));
		process.exit(2);
	}
	if (!config) {
		console.error("No Dify configuration found. Set DIFY_CONFIG, or DIFY_BASE_URL and DIFY_API_KEY.");
		process.exit(2);
	}

	const server = new DifyMcpServer(config);
	console.error(`dify-mcp: serving ${config.apps.length} app(s) from ${config.baseUrl}`);

	// stdin closing must not cut off a call that is still running, nor truncate a
	// reply still being flushed: a piped invocation ends stdin immediately, and
	// clients close it on shutdown.
	let inFlight = 0;
	let pendingWrites = 0;
	let stdinEnded = false;
	const exitWhenIdle = (): void => {
		if (stdinEnded && inFlight === 0 && pendingWrites === 0) process.exit(0);
	};

	const write = (message: unknown): void => {
		pendingWrites++;
		process.stdout.write(`${JSON.stringify(message)}\n`, () => {
			pendingWrites--;
			exitWhenIdle();
		});
	};

	const settle = (): void => {
		inFlight--;
		exitWhenIdle();
	};

	/** Validate one decoded value, then dispatch it. Never rejects. */
	const handleEntry = async (entry: unknown): Promise<Record<string, unknown> | undefined> => {
		// A bare `null` or a scalar is not a request object; dispatching it would
		// dereference a non-object and take the process down.
		if (!isPlainObject(entry)) {
			return errorEnvelope(null, INVALID_REQUEST, "Invalid JSON-RPC request");
		}
		if ("id" in entry && !isJsonRpcId(entry.id)) {
			return errorEnvelope(null, INVALID_REQUEST, "Invalid JSON-RPC request id");
		}

		// Read the fields rather than casting: the wire shape is unknown, and a
		// cast would assert a structure nothing has checked.
		const request: JsonRpcRequest = {
			jsonrpc: typeof entry.jsonrpc === "string" ? entry.jsonrpc : undefined,
			method: typeof entry.method === "string" ? entry.method : undefined,
			params: isPlainObject(entry.params) ? entry.params : undefined,
		};
		if ("id" in entry) request.id = entry.id as JsonRpcId;

		try {
			return await server.handle(request);
		} catch (error) {
			return errorEnvelope(
				request.id ?? null,
				INTERNAL_ERROR,
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	const dispatchLine = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			write(errorEnvelope(null, PARSE_ERROR, "Parse error"));
			return;
		}

		// Pre-2025-06-18 clients may send JSON-RPC batches. A batch is answered
		// with one array, not a response per line.
		if (Array.isArray(parsed)) {
			if (parsed.length === 0) {
				write(errorEnvelope(null, INVALID_REQUEST, "Invalid JSON-RPC request"));
				return;
			}
			inFlight++;
			void Promise.all(parsed.map(handleEntry))
				.then((responses) => {
					const batch = responses.filter(
						(response): response is Record<string, unknown> => response !== undefined,
					);
					if (batch.length > 0) write(batch);
				})
				.finally(settle);
			return;
		}

		inFlight++;
		void handleEntry(parsed)
			.then((response) => {
				if (response) write(response);
			})
			.finally(settle);
	};

	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line) dispatchLine(line);
		}
	});

	process.stdin.on("end", () => {
		stdinEnded = true;
		exitWhenIdle();
	});
}

// pathToFileURL, rather than a "file://" template: on Windows the raw path is
// not a URL, so a string compare silently skips main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
