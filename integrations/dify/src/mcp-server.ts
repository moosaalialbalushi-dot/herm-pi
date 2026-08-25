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

import { DifyClient } from "./client.ts";
import { type DifyAppConfig, type DifyConfig, DifyConfigError, loadDifyConfig } from "./config.ts";
import { difyInputSchema, difyToolDescription, difyToolName, runDifyApp } from "./tools.ts";

const SERVER_NAME = "dify";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
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

	constructor(config: DifyConfig) {
		this.config = config;
	}

	/** Handle one decoded request. Returns undefined for notifications. */
	async handle(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
		const isNotification = request.id === undefined || request.id === null;

		if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
			if (isNotification) return undefined;
			return this.errorResponse(request.id ?? null, INVALID_REQUEST, "Invalid JSON-RPC request");
		}

		try {
			switch (request.method) {
				case "initialize": {
					const requested = (request.params as { protocolVersion?: string } | undefined)?.protocolVersion;
					const protocolVersion =
						requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
					return this.result(request.id ?? null, {
						protocolVersion,
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
					});
				}

				case "notifications/initialized":
				case "notifications/cancelled":
					return undefined;

				case "ping":
					return isNotification ? undefined : this.result(request.id ?? null, {});

				case "tools/list":
					return this.result(request.id ?? null, {
						tools: this.config.apps.map((app) => ({
							name: difyToolName(app),
							description: difyToolDescription(app),
							inputSchema: difyInputSchema(app),
						})),
					});

				case "tools/call":
					return await this.callTool(request);

				default:
					if (isNotification) return undefined;
					return this.errorResponse(request.id ?? null, METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
			}
		} catch (error) {
			if (isNotification) return undefined;
			return this.errorResponse(
				request.id ?? null,
				INTERNAL_ERROR,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private async callTool(request: JsonRpcRequest): Promise<Record<string, unknown>> {
		const id = request.id ?? null;
		const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
		if (typeof params.name !== "string") {
			return this.errorResponse(id, INVALID_PARAMS, 'tools/call requires a "name" parameter');
		}

		const app = this.config.apps.find((candidate) => difyToolName(candidate) === params.name);
		if (!app) {
			return this.errorResponse(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
		}

		const args = params.arguments ?? {};
		const result = await runDifyApp(
			this.clientFor(app),
			app,
			{
				query: typeof args.query === "string" ? args.query : undefined,
				conversation_id: typeof args.conversation_id === "string" ? args.conversation_id : undefined,
				inputs: isPlainObject(args.inputs) ? args.inputs : undefined,
			},
			this.config.user,
		);

		// Tool failures ride back as a successful JSON-RPC response with
		// isError set: that is how MCP lets the model see and react to them.
		return this.result(id, {
			content: [{ type: "text", text: result.text }],
			isError: result.isError,
			structuredContent: result.details as unknown as Record<string, unknown>,
		});
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

	private result(id: string | number | null, result: Record<string, unknown>): Record<string, unknown> {
		return { jsonrpc: "2.0", id, result };
	}

	private errorResponse(id: string | number | null, code: number, message: string): Record<string, unknown> {
		const error: JsonRpcError = { code, message };
		return { jsonrpc: "2.0", id, error };
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

	const write = (message: Record<string, unknown>): void => {
		process.stdout.write(`${JSON.stringify(message)}\n`);
	};

	// stdin closing must not cut off a call that is still running: a piped
	// invocation ends stdin immediately, and clients close it on shutdown.
	let inFlight = 0;
	let stdinEnded = false;
	const settle = (): void => {
		inFlight--;
		if (stdinEnded && inFlight === 0) process.exit(0);
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
			if (!line) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
				continue;
			}

			// Pre-2025-06-18 clients may send JSON-RPC batches.
			const requests = Array.isArray(parsed) ? parsed : [parsed];
			for (const request of requests) {
				inFlight++;
				void server
					.handle(request as JsonRpcRequest)
					.then((response) => {
						if (response) write(response);
					})
					.finally(settle);
			}
		}
	});

	process.stdin.on("end", () => {
		stdinEnded = true;
		if (inFlight === 0) process.exit(0);
	});
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
