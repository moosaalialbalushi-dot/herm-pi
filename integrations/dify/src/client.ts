/**
 * Zero-dependency client for the Dify Service API.
 *
 * Covers the endpoints a self-hosted Dify instance exposes under `/v1` for
 * per-app API keys (`app-...`): chat apps, completion apps and workflows, in
 * both blocking and streaming response modes.
 *
 * Deliberately dependency-free: this module is shared by the pi extension and
 * by the standalone MCP server that runs on the Hermes VM, where adding an npm
 * dependency tree is not worth it.
 */

/** Dify app flavours addressable through the Service API. */
export type DifyAppType = "chat" | "completion" | "workflow";

export interface DifyClientOptions {
	/** Service API root, including the version segment, e.g. `https://dify.example.org/v1`. */
	baseUrl: string;
	/** Per-app Service API key (`app-...`). */
	apiKey: string;
	/** Abort a request after this many milliseconds. Default 120000. */
	timeoutMs?: number;
}

/** Token and price accounting reported by Dify in `metadata.usage`. */
export interface DifyUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	total_price?: string;
	currency?: string;
	latency?: number;
}

export interface DifyChatRequest {
	query: string;
	/** Values for the app's user input form. */
	inputs?: Record<string, unknown>;
	/** Continue an existing Dify conversation. Omit to start a new one. */
	conversationId?: string;
	/** End-user identifier Dify attributes the conversation to. */
	user: string;
	files?: DifyFileInput[];
	signal?: AbortSignal;
}

export interface DifyCompletionRequest {
	inputs: Record<string, unknown>;
	user: string;
	files?: DifyFileInput[];
	signal?: AbortSignal;
}

export interface DifyWorkflowRequest {
	inputs: Record<string, unknown>;
	user: string;
	files?: DifyFileInput[];
	signal?: AbortSignal;
}

export interface DifyFileInput {
	type: "image" | "document" | "audio" | "video" | "custom";
	transfer_method: "remote_url" | "local_file";
	url?: string;
	upload_file_id?: string;
}

export interface DifyChatResult {
	answer: string;
	conversationId?: string;
	messageId?: string;
	usage?: DifyUsage;
}

export interface DifyWorkflowResult {
	status: string;
	outputs: Record<string, unknown> | null;
	error?: string | null;
	elapsedTime?: number;
	totalTokens?: number;
	totalSteps?: number;
	workflowRunId?: string;
	taskId?: string;
}

/** `GET /info` — app identity. */
export interface DifyAppInfo {
	name?: string;
	description?: string;
	tags?: string[];
	mode?: string;
}

/** One field of an app's user input form, as reported by `GET /parameters`. */
export interface DifyUserInputField {
	variable: string;
	label: string;
	required: boolean;
	type: "text-input" | "paragraph" | "select" | "number";
	options?: string[];
	maxLength?: number;
	default?: string;
}

/** A decoded Dify SSE frame. `event` is Dify's own event discriminator. */
export interface DifySseEvent {
	event: string;
	[key: string]: unknown;
}

/** Raised for non-2xx Service API responses, carrying Dify's error envelope. */
export class DifyApiError extends Error {
	status: number;
	code: string | undefined;
	endpoint: string;

	constructor(message: string, status: number, endpoint: string, code?: string) {
		super(message);
		this.name = "DifyApiError";
		this.status = status;
		this.code = code;
		this.endpoint = endpoint;
	}
}

const DEFAULT_TIMEOUT_MS = 120000;

export class DifyClient {
	readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;

	constructor(options: DifyClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.apiKey = options.apiKey;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** App identity. Cheapest authenticated call, so it doubles as a credential probe. */
	async getAppInfo(signal?: AbortSignal): Promise<DifyAppInfo> {
		const response = await this.request("/info", { method: "GET" }, signal);
		return (await response.json()) as DifyAppInfo;
	}

	/** The app's user input form, used to describe workflow/completion inputs to callers. */
	async getUserInputFields(signal?: AbortSignal): Promise<DifyUserInputField[]> {
		const response = await this.request("/parameters", { method: "GET" }, signal);
		const payload = (await response.json()) as { user_input_form?: Record<string, unknown>[] };
		const fields: DifyUserInputField[] = [];
		for (const entry of payload.user_input_form ?? []) {
			// Each entry is a single-key object: { "text-input": { variable, label, ... } }.
			for (const [type, raw] of Object.entries(entry)) {
				const spec = raw as Record<string, unknown>;
				if (!spec || typeof spec.variable !== "string") continue;
				fields.push({
					variable: spec.variable,
					label: typeof spec.label === "string" ? spec.label : spec.variable,
					required: spec.required === true,
					type: type as DifyUserInputField["type"],
					options: Array.isArray(spec.options) ? (spec.options as string[]) : undefined,
					maxLength: typeof spec.max_length === "number" ? spec.max_length : undefined,
					default: typeof spec.default === "string" ? spec.default : undefined,
				});
			}
		}
		return fields;
	}

	/** `POST /chat-messages` in blocking mode. */
	async chat(request: DifyChatRequest): Promise<DifyChatResult> {
		const response = await this.request(
			"/chat-messages",
			{ method: "POST", body: JSON.stringify(this.chatBody(request, "blocking")) },
			request.signal,
		);
		const payload = (await response.json()) as {
			answer?: string;
			conversation_id?: string;
			message_id?: string;
			metadata?: { usage?: DifyUsage };
		};
		return {
			answer: payload.answer ?? "",
			conversationId: payload.conversation_id,
			messageId: payload.message_id,
			usage: payload.metadata?.usage,
		};
	}

	/**
	 * `POST /chat-messages` in streaming mode.
	 *
	 * Yields decoded SSE frames. Callers care about `message`/`agent_message`
	 * (incremental `answer`), `message_end` (usage) and `error`.
	 */
	chatStream(request: DifyChatRequest): AsyncGenerator<DifySseEvent> {
		return this.streamRequest("/chat-messages", this.chatBody(request, "streaming"), request.signal);
	}

	/** `POST /completion-messages` in blocking mode. */
	async complete(request: DifyCompletionRequest): Promise<DifyChatResult> {
		const body = {
			inputs: request.inputs,
			response_mode: "blocking",
			user: request.user,
			...(request.files?.length ? { files: request.files } : {}),
		};
		const response = await this.request(
			"/completion-messages",
			{ method: "POST", body: JSON.stringify(body) },
			request.signal,
		);
		const payload = (await response.json()) as {
			answer?: string;
			message_id?: string;
			metadata?: { usage?: DifyUsage };
		};
		return { answer: payload.answer ?? "", messageId: payload.message_id, usage: payload.metadata?.usage };
	}

	/** `POST /workflows/run` in blocking mode. */
	async runWorkflow(request: DifyWorkflowRequest): Promise<DifyWorkflowResult> {
		const body = {
			inputs: request.inputs,
			response_mode: "blocking",
			user: request.user,
			...(request.files?.length ? { files: request.files } : {}),
		};
		const response = await this.request(
			"/workflows/run",
			{ method: "POST", body: JSON.stringify(body) },
			request.signal,
		);
		const payload = (await response.json()) as {
			workflow_run_id?: string;
			task_id?: string;
			data?: {
				status?: string;
				outputs?: Record<string, unknown> | null;
				error?: string | null;
				elapsed_time?: number;
				total_tokens?: number;
				total_steps?: number;
			};
		};
		const data = payload.data ?? {};
		return {
			status: data.status ?? "unknown",
			outputs: data.outputs ?? null,
			error: data.error ?? null,
			elapsedTime: data.elapsed_time,
			totalTokens: data.total_tokens,
			totalSteps: data.total_steps,
			workflowRunId: payload.workflow_run_id,
			taskId: payload.task_id,
		};
	}

	/** `POST /workflows/run` in streaming mode, for progress reporting on long workflows. */
	runWorkflowStream(request: DifyWorkflowRequest): AsyncGenerator<DifySseEvent> {
		const body = {
			inputs: request.inputs,
			response_mode: "streaming",
			user: request.user,
			...(request.files?.length ? { files: request.files } : {}),
		};
		return this.streamRequest("/workflows/run", body, request.signal);
	}

	private chatBody(request: DifyChatRequest, mode: "blocking" | "streaming"): Record<string, unknown> {
		return {
			query: request.query,
			inputs: request.inputs ?? {},
			response_mode: mode,
			user: request.user,
			// Dify treats "" as "start a new conversation"; a stale id is a 404.
			conversation_id: request.conversationId ?? "",
			auto_generate_name: true,
			...(request.files?.length ? { files: request.files } : {}),
		};
	}

	private async *streamRequest(
		path: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): AsyncGenerator<DifySseEvent> {
		const response = await this.request(path, { method: "POST", body: JSON.stringify(body) }, signal);
		if (!response.body) {
			throw new DifyApiError("Response carried no body for a streaming request", response.status, path);
		}
		for await (const event of parseSseStream(response.body)) {
			yield event;
		}
	}

	private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				...init,
				signal: combined,
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					...(init.headers as Record<string, string> | undefined),
				},
			});
		} catch (error) {
			// Distinguish the caller's abort from our own timeout: they need different fixes.
			if (signal?.aborted) throw error;
			if (timeout.aborted) {
				throw new DifyApiError(`Request timed out after ${this.timeoutMs}ms`, 0, path, "timeout");
			}
			throw new DifyApiError(error instanceof Error ? error.message : String(error), 0, path, "network");
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			let code: string | undefined;
			let message = text.slice(0, 500);
			try {
				const parsed = JSON.parse(text) as { code?: string; message?: string };
				if (parsed.code) code = parsed.code;
				if (parsed.message) message = parsed.message;
			} catch {
				// Not Dify's JSON error envelope; a proxy or the web tier answered. Keep the raw body.
			}
			throw new DifyApiError(
				`${response.status} ${response.statusText}${message ? `: ${message}` : ""}`,
				response.status,
				path,
				code,
			);
		}

		return response;
	}
}

/**
 * Decode a `text/event-stream` body into Dify event objects.
 *
 * Exported for the parser self-test in `doctor.ts`.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<DifySseEvent> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });

		// Frames are separated by a blank line; \r\n appears when a proxy rewrites the stream.
		let separator = findFrameEnd(buffer);
		while (separator) {
			const frame = buffer.slice(0, separator.index);
			buffer = buffer.slice(separator.index + separator.length);
			const event = decodeFrame(frame);
			if (event) yield event;
			separator = findFrameEnd(buffer);
		}
	}

	buffer += decoder.decode();
	const trailing = decodeFrame(buffer);
	if (trailing) yield trailing;
}

function findFrameEnd(buffer: string): { index: number; length: number } | undefined {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf === -1 && crlf === -1) return undefined;
	if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
	return { index: lf, length: 2 };
}

function decodeFrame(frame: string): DifySseEvent | undefined {
	const data: string[] = [];
	for (const rawLine of frame.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line.startsWith("data:")) continue;
		data.push(line.slice(5).replace(/^ /, ""));
	}
	if (data.length === 0) return undefined;

	const payload = data.join("\n");
	if (payload === "[DONE]") return undefined;

	try {
		const parsed = JSON.parse(payload) as Record<string, unknown>;
		const event = typeof parsed.event === "string" ? parsed.event : "message";
		return { ...parsed, event };
	} catch {
		// Dify only emits JSON frames; anything else is a proxy injecting into the stream.
		return undefined;
	}
}

/** Pull the incremental answer text out of a chat SSE frame, if it carries one. */
export function chatAnswerDelta(event: DifySseEvent): string | undefined {
	if (event.event !== "message" && event.event !== "agent_message") return undefined;
	return typeof event.answer === "string" ? event.answer : undefined;
}
