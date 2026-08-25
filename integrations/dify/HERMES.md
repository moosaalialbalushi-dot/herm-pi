# Connecting Dify to Hermes

`src/mcp-server.ts` exposes every configured Dify app as an MCP tool over
stdio. Any MCP client can drive it, so the Telegram agents get Dify workflows
as callable tools without Hermes learning anything about Dify's API.

This session had no access to the Hermes host or its repo, so the wiring below
is the standard MCP shape rather than a patch against your actual config.
Adjust paths to match the VM; everything else is verbatim.

## 1. Put the code on the VM

The server imports only `client.ts`, `config.ts` and `tools.ts`, all
dependency-free, and Node runs the TypeScript directly (type stripping, Node
22.6+ — the repo already requires 22.19).

```bash
sudo git clone https://github.com/moosaalialbalushi-dot/herm-pi /opt/herm-pi
node --version   # must be >= 22.19
```

No `npm install`. Nothing to build.

## 2. Configure

```bash
sudo mkdir -p /etc/hermes
sudo cp /opt/herm-pi/integrations/dify/dify.config.example.json /etc/hermes/dify.config.json
sudo $EDITOR /etc/hermes/dify.config.json
sudo chmod 600 /etc/hermes/dify.config.json
```

Keep the keys out of the file and in the environment:

```json
{
  "baseUrl": "https://dify.kadindustries.org/v1",
  "user": "hermes",
  "apps": [
    { "name": "assistant", "type": "chat", "apiKey": "$DIFY_KEY_ASSISTANT",
      "description": "General assistant. Ask a question; pass conversation_id to continue a thread." },
    { "name": "trade_intel", "type": "workflow", "apiKey": "$DIFY_KEY_TRADE_INTEL",
      "description": "Trade-intelligence workflow. inputs: { hs_code, country, period }.",
      "timeoutMs": 300000 }
  ]
}
```

The `description` is what the Telegram agent reads when deciding whether to
call an app. Naming the expected `inputs` there is the difference between the
agent calling a workflow correctly and guessing at the variable names.

Verify before wiring anything up:

```bash
DIFY_CONFIG=/etc/hermes/dify.config.json node /opt/herm-pi/integrations/dify/src/doctor.ts
```

## 3. Register with Hermes

Most MCP clients read a `mcpServers` map. Add:

```json
{
  "mcpServers": {
    "dify": {
      "command": "node",
      "args": [
        "/opt/herm-pi/integrations/dify/src/mcp-server.ts",
        "--config",
        "/etc/hermes/dify.config.json"
      ],
      "env": {
        "DIFY_KEY_ASSISTANT": "app-xxxxxxxx",
        "DIFY_KEY_TRADE_INTEL": "app-yyyyyyyy"
      }
    }
  }
}
```

If the agent already inherits those keys from its own environment, drop the
`env` block — `$VAR` references resolve against whatever the process inherits.

For a Claude Code agent on the VM:

```bash
claude mcp add dify -- node /opt/herm-pi/integrations/dify/src/mcp-server.ts --config /etc/hermes/dify.config.json
```

The agent then sees `dify_assistant`, `dify_trade_intel`, and one tool per app
you add later — restart the client after editing the config, since tools are
listed once at startup.

### If Hermes speaks HTTP MCP rather than stdio

This server is stdio only. Two ways across:

- Put a stdio-to-HTTP MCP bridge in front of it (`mcp-proxy` and similar wrap a
  stdio server as streamable HTTP).
- Or skip MCP: import `client.ts` and `tools.ts` directly from the Hermes
  agent code and call `runDifyApp()`. That is the same code path the MCP
  server uses, minus the protocol.

No systemd unit is needed either way: a stdio MCP server is spawned by its
client and lives for that client's lifetime. Only a bridge would need a unit.

## 4. Verify the server by hand

The protocol is newline-delimited JSON-RPC, so a handshake is one pipeline:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| DIFY_CONFIG=/etc/hermes/dify.config.json node /opt/herm-pi/integrations/dify/src/mcp-server.ts
```

Expect an `initialize` result followed by a `tools/list` result naming your
apps. Diagnostics go to stderr; stdout carries protocol traffic only.

Call a tool the same way:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dify_assistant","arguments":{"query":"say ok"}}}' \
| DIFY_CONFIG=/etc/hermes/dify.config.json node /opt/herm-pi/integrations/dify/src/mcp-server.ts
```

## 5. Operating notes

- **Timeouts.** The default is 120s per call. Workflows that outlast that need
  `timeoutMs` raised per app — and if the hostname stays behind Cloudflare's
  proxy, a blocking call over ~100s returns 524 regardless. See
  [RUNBOOK.md](RUNBOOK.md#524-on-long-calls).
- **Conversation continuity.** `dify_<chat app>` returns its `conversation_id`
  in the result text. An agent that passes it back on the next call keeps one
  Dify thread per Telegram conversation; one that ignores it starts fresh each
  time.
- **Failures reach the model.** A Dify error comes back as a normal tool result
  with `isError` set and a message that names the likely cause, so the agent can
  report or retry rather than the turn dying.
- **Key rotation.** Rotate in Dify's **API Access** page, update the
  environment the MCP server inherits, restart the client. The config file only
  holds `$VAR` names, so it never needs editing for a rotation.
- **Adding an app.** Append to `apps` in `/etc/hermes/dify.config.json`, export
  its key, restart the client. No code change.
