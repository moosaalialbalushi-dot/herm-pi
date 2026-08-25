/**
 * Health checks for the Dify integration.
 *
 * Backs both the `/dify` slash command in pi and a standalone CLI:
 *
 *   node integrations/dify/src/doctor.ts
 *   node integrations/dify/src/doctor.ts --self-test
 */

import { DifyClient, parseSseStream } from "./client.ts";
import { type DifyConfig, DifyConfigError, loadDifyConfig } from "./config.ts";
import { describeError } from "./tools.ts";

export interface DifyCheckResult {
	app: string;
	type: string;
	ok: boolean;
	latencyMs: number;
	detail: string;
}

/** Probe every configured app with `GET /info`, in parallel. */
export async function checkApps(config: DifyConfig, signal?: AbortSignal): Promise<DifyCheckResult[]> {
	return Promise.all(
		config.apps.map(async (app) => {
			const client = new DifyClient({
				baseUrl: app.baseUrl ?? config.baseUrl,
				apiKey: app.apiKey,
				timeoutMs: app.timeoutMs ?? 15000,
			});
			const started = Date.now();
			try {
				const info = await client.getAppInfo(signal);
				return {
					app: app.name,
					type: app.type,
					ok: true,
					latencyMs: Date.now() - started,
					detail: info.name ? `"${info.name}"${info.mode ? ` (mode: ${info.mode})` : ""}` : "reachable",
				};
			} catch (error) {
				return {
					app: app.name,
					type: app.type,
					ok: false,
					latencyMs: Date.now() - started,
					detail: describeError(error, app),
				};
			}
		}),
	);
}

/** Render a check run as plain text for a terminal or a chat transcript. */
export function formatReport(config: DifyConfig, results: DifyCheckResult[]): string {
	const lines: string[] = [
		`Dify base URL: ${config.baseUrl}`,
		`Config source: ${config.sourcePath ?? "environment variables"}`,
		`End-user id:   ${config.user}`,
		`Provider:      ${config.registerProvider ? "enabled" : "disabled"}`,
		"",
	];
	for (const result of results) {
		const status = result.ok ? "OK  " : "FAIL";
		lines.push(`${status} ${result.app} (${result.type}, ${result.latencyMs}ms) ${result.detail}`);
	}
	const failed = results.filter((result) => !result.ok).length;
	lines.push(
		"",
		failed === 0 ? `All ${results.length} app(s) reachable.` : `${failed} of ${results.length} app(s) failing.`,
	);
	return lines.join("\n");
}

/**
 * Offline assertions for the SSE frame decoder.
 *
 * The decoder is the one piece of pure logic here that a live check does not
 * pin down: proxies reframe streams, so partial frames, CRLF and multi-line
 * `data:` all have to survive.
 */
export async function selfTest(): Promise<string[]> {
	const failures: string[] = [];

	const collect = async (chunks: string[]): Promise<Record<string, unknown>[]> => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const events: Record<string, unknown>[] = [];
		for await (const event of parseSseStream(stream)) events.push(event);
		return events;
	};

	const expect = (label: string, actual: unknown, expected: unknown) => {
		const a = JSON.stringify(actual);
		const b = JSON.stringify(expected);
		if (a !== b) failures.push(`${label}: expected ${b}, got ${a}`);
	};

	expect("single frame", await collect(['data: {"event":"message","answer":"hi"}\n\n']), [
		{ event: "message", answer: "hi" },
	]);

	// A frame split mid-JSON across chunk boundaries must not be lost.
	expect("split frame", await collect(['data: {"event":"mess', 'age","answer":"ab"}', "\n\n"]), [
		{ event: "message", answer: "ab" },
	]);

	expect("crlf framing", await collect(['data: {"event":"message","answer":"x"}\r\n\r\n']), [
		{ event: "message", answer: "x" },
	]);

	// Keep-alive comments and ping events carry no answer text but must not break parsing.
	expect(
		"ping between messages",
		await collect([': keep-alive\n\ndata: {"event":"ping"}\n\ndata: {"event":"message","answer":"y"}\n\n']),
		[{ event: "ping" }, { event: "message", answer: "y" }],
	);

	// A final frame with no trailing blank line still has to be emitted.
	expect("unterminated final frame", await collect(['data: {"event":"message_end","metadata":{}}']), [
		{ event: "message_end", metadata: {} },
	]);

	expect("multi-line data", await collect(['data: {"event":"message",\ndata: "answer":"z"}\n\n']), [
		{ event: "message", answer: "z" },
	]);

	return failures;
}

async function main(): Promise<void> {
	if (process.argv.includes("--self-test")) {
		const failures = await selfTest();
		if (failures.length > 0) {
			console.error(`SSE parser self-test failed:\n  - ${failures.join("\n  - ")}`);
			process.exitCode = 1;
			return;
		}
		console.log("SSE parser self-test passed.");
		return;
	}

	let config: DifyConfig | undefined;
	try {
		config = loadDifyConfig();
	} catch (error) {
		console.error(error instanceof DifyConfigError ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	if (!config) {
		console.error(
			"No Dify configuration found. Create integrations/dify/dify.config.json (see dify.config.example.json) " +
				"or set DIFY_BASE_URL and DIFY_API_KEY.",
		);
		process.exitCode = 1;
		return;
	}

	const results = await checkApps(config);
	console.log(formatReport(config, results));
	if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
