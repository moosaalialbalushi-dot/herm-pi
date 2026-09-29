/**
 * Configuration loading for the Dify integration.
 *
 * One config feeds all three consumers: the pi extension, the MCP server used
 * by Hermes, and the doctor CLI.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DifyAppType } from "./client.ts";

export interface DifyAppConfig {
	/** Identifier used to build the tool name. Lowercase, digits, underscores. */
	name: string;
	type: DifyAppType;
	/** Resolved Service API key. */
	apiKey: string;
	/** Shown to the model as the tool description. */
	description?: string;
	/** Per-app Service API root; falls back to the top-level `baseUrl`. */
	baseUrl?: string;
	timeoutMs?: number;
	/** Expose this chat app as a pi model when the provider is enabled. */
	provider?: boolean;
}

export interface DifyConfig {
	/** Service API root, including the version segment. */
	baseUrl: string;
	/** End-user id Dify attributes calls to. */
	user: string;
	apps: DifyAppConfig[];
	/** Register chat apps as pi models (`/model dify/<app>`). Off by default. */
	registerProvider: boolean;
	/** Advertised context window for provider models; Dify does not report one. */
	providerContextWindow: number;
	/** Advertised max output tokens for provider models. */
	providerMaxTokens: number;
	/** Absolute path the config came from, or undefined when built from env vars. */
	sourcePath?: string;
}

export class DifyConfigError extends Error {
	problems: string[];

	constructor(problems: string[]) {
		super(`Invalid Dify configuration:\n  - ${problems.join("\n  - ")}`);
		this.name = "DifyConfigError";
		this.problems = problems;
	}
}

const APP_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const APP_TYPES: DifyAppType[] = ["chat", "completion", "workflow"];
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Candidate config paths, most specific first.
 *
 * `DIFY_CONFIG` wins; otherwise the repo-local file, then the per-user file.
 */
export function configSearchPaths(cwd: string): string[] {
	const explicit = process.env.DIFY_CONFIG;
	if (explicit) return [explicit];
	return [
		join(cwd, "integrations", "dify", "dify.config.json"),
		join(cwd, ".pi", "dify.json"),
		join(homedir(), ".pi", "dify.json"),
	];
}

/**
 * Load the Dify config, or return undefined when nothing is configured.
 *
 * Throws `DifyConfigError` when a config exists but is unusable — a silent
 * fallback would leave the agent with tools that fail on first call.
 */
export function loadDifyConfig(cwd: string = process.cwd()): DifyConfig | undefined {
	for (const path of configSearchPaths(cwd)) {
		if (!existsSync(path)) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new DifyConfigError([`${path}: not valid JSON (${error instanceof Error ? error.message : error})`]);
		}
		return parseDifyConfig(raw, path);
	}
	return configFromEnv();
}

/** Build a single-app config from environment variables alone. */
function configFromEnv(): DifyConfig | undefined {
	const apiKey = process.env.DIFY_API_KEY;
	const baseUrl = process.env.DIFY_BASE_URL;
	if (!apiKey || !baseUrl) return undefined;

	const name = process.env.DIFY_APP_NAME ?? "default";
	const type = (process.env.DIFY_APP_TYPE ?? "chat") as DifyAppType;
	const problems: string[] = [];
	if (!APP_NAME_PATTERN.test(name)) {
		problems.push(`DIFY_APP_NAME "${name}" must match ${APP_NAME_PATTERN.source}`);
	}
	if (!APP_TYPES.includes(type)) {
		problems.push(`DIFY_APP_TYPE "${type}" must be one of ${APP_TYPES.join(", ")}`);
	}
	const resolvedBaseUrl = validateBaseUrl(baseUrl, "DIFY_BASE_URL", problems);
	if (problems.length > 0 || !resolvedBaseUrl) throw new DifyConfigError(problems);

	return {
		baseUrl: resolvedBaseUrl,
		user: process.env.DIFY_USER ?? "pi-agent",
		apps: [{ name, type, apiKey, provider: type === "chat" }],
		registerProvider: process.env.DIFY_AS_PROVIDER === "1",
		providerContextWindow: DEFAULT_CONTEXT_WINDOW,
		providerMaxTokens: DEFAULT_MAX_TOKENS,
	};
}

/** Validate and normalize a parsed config document. Exported for the doctor CLI. */
export function parseDifyConfig(raw: unknown, sourcePath?: string): DifyConfig {
	const problems: string[] = [];
	const where = sourcePath ? `${sourcePath}: ` : "";

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new DifyConfigError([`${where}top level must be a JSON object`]);
	}
	const doc = raw as Record<string, unknown>;

	const baseUrlRaw = typeof doc.baseUrl === "string" ? resolveValue(doc.baseUrl) : process.env.DIFY_BASE_URL;
	const topLevelBaseUrl = baseUrlRaw ? validateBaseUrl(baseUrlRaw, `${where}"baseUrl"`, problems) : undefined;

	const apps: DifyAppConfig[] = [];
	const seen = new Set<string>();
	const rawApps = doc.apps;
	if (!Array.isArray(rawApps) || rawApps.length === 0) {
		problems.push(`${where}"apps" must be a non-empty array`);
	} else {
		rawApps.forEach((entry, index) => {
			const at = `${where}apps[${index}]`;
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				problems.push(`${at}: must be an object`);
				return;
			}
			const app = entry as Record<string, unknown>;

			const name = typeof app.name === "string" ? app.name : "";
			if (!APP_NAME_PATTERN.test(name)) {
				problems.push(`${at}: "name" must match ${APP_NAME_PATTERN.source} (got ${JSON.stringify(app.name)})`);
			} else if (seen.has(name)) {
				problems.push(`${at}: duplicate app name "${name}"`);
			} else {
				seen.add(name);
			}

			const type = app.type as DifyAppType;
			if (!APP_TYPES.includes(type)) {
				problems.push(`${at}: "type" must be one of ${APP_TYPES.join(", ")} (got ${JSON.stringify(app.type)})`);
			}

			let apiKey = "";
			if (typeof app.apiKey !== "string" || app.apiKey.length === 0) {
				problems.push(`${at}: "apiKey" is required`);
			} else {
				apiKey = resolveValue(app.apiKey);
				if (!apiKey) {
					problems.push(`${at}: "apiKey" resolved to an empty string (is ${app.apiKey} exported?)`);
				}
			}

			if (problems.length > 0 && (!name || !apiKey)) return;

			// An unresolved $VAR here would otherwise normalize to a bare "/v1" and
			// silently override a perfectly good top-level URL.
			let baseUrl: string | undefined;
			if (typeof app.baseUrl === "string") {
				baseUrl = validateBaseUrl(resolveValue(app.baseUrl), `${at}: "baseUrl"`, problems);
			}

			let timeoutMs: number | undefined;
			if (app.timeoutMs !== undefined) {
				timeoutMs = validateTimeoutMs(app.timeoutMs, `${at}: "timeoutMs"`, problems);
			}

			apps.push({
				name,
				type,
				apiKey,
				description: typeof app.description === "string" ? app.description : undefined,
				baseUrl,
				timeoutMs,
				provider: app.provider === true || (app.provider === undefined && type === "chat"),
			});
		});
	}

	// apps[].baseUrl exists so one config can span several Dify instances, so the
	// top-level value is only needed by apps that do not carry their own.
	if (!topLevelBaseUrl && apps.some((app) => !app.baseUrl)) {
		problems.push(`${where}"baseUrl" is required (or set DIFY_BASE_URL) unless every app sets its own`);
	}

	if (problems.length > 0) throw new DifyConfigError(problems);

	return {
		baseUrl: topLevelBaseUrl ?? "",
		user: typeof doc.user === "string" ? resolveValue(doc.user) : (process.env.DIFY_USER ?? "pi-agent"),
		apps,
		registerProvider: doc.registerProvider === true || process.env.DIFY_AS_PROVIDER === "1",
		providerContextWindow:
			typeof doc.providerContextWindow === "number" ? doc.providerContextWindow : DEFAULT_CONTEXT_WINDOW,
		providerMaxTokens: typeof doc.providerMaxTokens === "number" ? doc.providerMaxTokens : DEFAULT_MAX_TOKENS,
		sourcePath,
	};
}

/**
 * Interpolate `$VAR` / `${VAR}` from the environment; `$$` emits a literal `$`.
 *
 * Unlike pi's own config values this deliberately does not support `!command`:
 * the MCP server runs unattended on the Hermes VM, and a config file that can
 * spawn processes is a wider blast radius than this integration needs.
 */
export function resolveValue(value: string): string {
	return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
		if (match === "$$") return "$";
		return process.env[braced ?? bare] ?? "";
	});
}

/** Ensure the base URL carries the `/v1` Service API segment exactly once. */
export function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Normalize a base URL, rejecting anything that is not an absolute http(s) URL.
 *
 * Returns undefined and records a problem on failure, so a bad value surfaces at
 * load time rather than as a confusing 404 on the first call.
 */
function validateBaseUrl(value: string, label: string, problems: string[]): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		problems.push(`${label} resolved to an empty string (is the referenced variable exported?)`);
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		problems.push(`${label} must be an absolute URL (got ${JSON.stringify(value)})`);
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		problems.push(`${label} must use http or https (got ${JSON.stringify(parsed.protocol)})`);
		return undefined;
	}
	return normalizeBaseUrl(trimmed);
}

/**
 * Bound a configured timeout to what `AbortSignal.timeout` actually honours.
 *
 * Zero or a negative value aborts the request the moment it starts, and anything
 * past the 32-bit timer ceiling throws, either of which makes that app unusable.
 */
function validateTimeoutMs(value: unknown, label: string, problems: string[]): number | undefined {
	const MAX_TIMEOUT_MS = 2147483647;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
		problems.push(`${label} must be an integer between 1 and ${MAX_TIMEOUT_MS} (got ${JSON.stringify(value)})`);
		return undefined;
	}
	return value;
}
