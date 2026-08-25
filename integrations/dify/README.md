# Dify integration

Wires a self-hosted Dify instance (`dify.kadindustries.org`) into three places:

| Consumer | Entry point | What it gets |
|---|---|---|
| pi in this repo | `.pi/extensions/dify.ts` | one tool per Dify app, a `/dify` health check, optional Dify models |
| Hermes (or any MCP client) | `src/mcp-server.ts` | the same apps as MCP tools over stdio |
| Operators | `src/doctor.ts`, `deploy/healthcheck.sh` | connectivity and deployment diagnostics |

All three share `src/client.ts` and one config file, so an app added once shows
up everywhere.

The runtime code has **no npm dependencies**. The MCP server runs on a box with
nothing but Node installed.

## Configure

```bash
cp integrations/dify/dify.config.example.json integrations/dify/dify.config.json
$EDITOR integrations/dify/dify.config.json
```

```json
{
  "baseUrl": "https://dify.kadindustries.org/v1",
  "user": "hermes",
  "registerProvider": false,
  "apps": [
    { "name": "assistant",   "type": "chat",     "apiKey": "$DIFY_KEY_ASSISTANT" },
    { "name": "trade_intel", "type": "workflow", "apiKey": "$DIFY_KEY_TRADE_INTEL",
      "description": "Runs the trade-intelligence workflow. inputs: { hs_code, country, period }.",
      "timeoutMs": 300000 }
  ]
}
```

Keys come from Dify: open the app, **API Access**, then create a secret. Each
app has its own key; there is no instance-wide key.

`dify.config.json` is gitignored. Keep the real keys in the environment and
reference them as `$VAR` — `$VAR` and `${VAR}` interpolate, `$$` is a literal
`$`. Unlike pi's own config values, `!command` is deliberately **not**
supported: the MCP server runs unattended, and a config file that can spawn
processes is a wider blast radius than this needs.

| Field | Meaning |
|---|---|
| `baseUrl` | Service API root. `/v1` is appended when missing. |
| `user` | End-user id Dify attributes calls to; shows up in Dify's logs. |
| `apps[].name` | `^[a-z][a-z0-9_]*$`. Becomes the tool name `dify_<name>`. |
| `apps[].type` | `chat`, `completion`, or `workflow`. Must match the app in Dify. |
| `apps[].description` | Tool description shown to the model. Name the expected `inputs` here — it is what makes the model call the app correctly. |
| `apps[].timeoutMs` | Per-app request timeout. Default 120000. Raise for slow workflows. |
| `registerProvider` | Expose chat apps as pi models. Off by default; see caveats below. |

Config is searched in this order, first hit wins:

1. `$DIFY_CONFIG`
2. `integrations/dify/dify.config.json`
3. `.pi/dify.json`
4. `~/.pi/dify.json`
5. `DIFY_BASE_URL` + `DIFY_API_KEY` (single app, no file needed)

A config that exists but is invalid is an error, not a silent fallback —
otherwise the agent gets tools that fail on their first call.

## Verify

```bash
node integrations/dify/src/doctor.ts              # probe every configured app
node integrations/dify/src/doctor.ts --self-test  # offline SSE parser checks
```

```
Dify base URL: https://dify.kadindustries.org/v1
Config source: integrations/dify/dify.config.json
End-user id:   hermes
Provider:      disabled

OK   assistant (chat, 214ms) "Assistant" (mode: advanced-chat)
FAIL trade_intel (workflow, 88ms) Dify app "trade_intel": 401 UNAUTHORIZED: Access token is invalid. The Service API key is wrong, revoked, or belongs to a different app.

1 of 2 app(s) failing.
```

## Use from pi

The extension loads automatically for anyone running pi in this repo. Each app
becomes a tool the agent can call:

```
dify_assistant   { query, conversation_id?, inputs? }
dify_trade_intel { inputs }
```

Chat results carry the `conversation_id` back in the text so the agent can pass
it to the next call and stay on one Dify thread. Workflow results return the
outputs — a single string output is returned bare, anything else as JSON.

`/dify` runs the same probe as the doctor and prints the report into the
session.

### Dify apps as pi models (opt-in)

With `"registerProvider": true`, chat apps also appear as models:

```
/model dify/assistant
```

This streams from `/v1/chat-messages`, so answers arrive token by token and
usage is reported. Two limits are worth knowing before turning it on:

- **No tool calling.** A Dify app returns text. pi's coding loop needs tools, so
  these models suit one-shot questions (`pi -p`) and chat, not coding work. The
  model picker labels them `(Dify, text only)` for that reason.
- **Dify owns the history.** Only the newest user message is sent; Dify replays
  the rest from its own conversation store, keyed per pi thread. pi's context
  edits — compaction, forking, editing an earlier message — do not reach Dify,
  so the two histories can drift apart on a long session.

## Use from Hermes

See [HERMES.md](HERMES.md). Short version:

```bash
node /opt/herm-pi/integrations/dify/src/mcp-server.ts --config /etc/hermes/dify.config.json
```

## Deploying and fixing the instance

`deploy/` holds the configuration that matters when Dify is served on a real
domain, and [RUNBOOK.md](RUNBOOK.md) maps symptoms to causes.

```bash
DIFY_API_KEY=app-xxxx ./integrations/dify/deploy/healthcheck.sh
```

## Layout

```
integrations/dify/
├── src/client.ts       Dify Service API client (fetch + SSE), no dependencies
├── src/config.ts       config discovery, env interpolation, validation
├── src/tools.ts        tool naming, schemas, execution, error messages
├── src/extension.ts    pi extension: tools, /dify, optional provider
├── src/mcp-server.ts   MCP stdio server (JSON-RPC 2.0, no dependencies)
├── src/doctor.ts       health checks + SSE parser self-test
└── deploy/             env, nginx, compose and healthcheck templates
```
