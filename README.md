# quick-shell

quick-shell is a local MCP App for short human-approved SSH terminal sessions. An agent can request `open_quick_shell` for an SSH-configured device alias, but the human controls the terminal, decides whether to insert any suggested command, and explicitly confirms any output sent back to the conversation.

## Run

Stdio is the recommended mode:

```bash
npm run build
node dist/server/server/main.js --stdio
```

The local CLI opens a human-controlled SSH terminal directly:

```bash
npm run build
node dist/server/cli/main.js --list
node dist/server/cli/main.js test-device --suggest 'hostname'
```

HTTP mode is localhost-only and requires bearer auth:

```bash
QUICK_SHELL_HTTP_TOKEN='replace-me' node dist/server/server/main.js --http
```

Requests to `/mcp` must include `Authorization: Bearer <token>`. The server does not enable broad CORS.

Set `QUICK_SHELL_AUDIT_LOG=/path/to/audit.jsonl` to write durable JSONL audit breadcrumbs instead of stderr.

For remote MCP App hosts, expose the terminal bridge through a TLS reverse proxy and advertise that URL:

```bash
QUICK_SHELL_BRIDGE_HOST=0.0.0.0 \
QUICK_SHELL_BRIDGE_PORT=40101 \
QUICK_SHELL_BRIDGE_PUBLIC_URL=https://shell.example.com \
node dist/server/server/main.js --stdio
```

## Device Allowlist

V1 accepts only explicit `Host` aliases from your SSH config. Wildcards such as `Host *`, `prod-*`, and negated aliases are ignored.

Add a device to `~/.ssh/config`:

```sshconfig
Host test-device
  HostName 192.0.2.10
  User operator
```

Then ask the agent to open quick-shell for `test-device`.

Optional `quick-shell.toml` metadata can decorate SSH aliases without granting access:

```toml
[devices.test-device]
label = "Test Device"
group = "dev"
danger = "normal"
default_shell = "zsh"
```

By default the file is read from `~/.config/quick-shell/quick-shell.toml`. Override it with `QUICK_SHELL_CONFIG`.

## Security Model

- The terminal bridge is localhost-only by default; remote deployments should expose only `/terminal` through TLS and keep the per-session quick-shell WebSocket token required.
- SSH targets must be explicit SSH config aliases from a readable primary config.
- SSH config blocks that can execute local commands (`ProxyCommand`, `LocalCommand`, `PermitLocalCommand yes`, or `Match exec`) are rejected.
- `quick-shell.toml` is metadata only; it does not allow new targets.
- No automatic command execution.
- Suggested commands are editable and inserted only after the user clicks Insert.
- Insert does not press Enter.
- Output is bounded, editable, checked for likely secret patterns, and sent only after Confirm.
- The app connects the terminal immediately when the host receives session capability metadata; Reconnect is only shown after a failed automatic attach.
- If the host browser cannot reach the direct terminal WebSocket, the app falls back to app-only MCP tools for polling output and sending input.
- Terminal WebSocket sessions require hidden app capabilities and enforce payload, schema, backpressure, and one-active-socket limits.
- App-only fallback transport requires the same hidden app capability and keeps terminal output in hidden tool-result metadata.
- Deploy only through MCP hosts that keep tool-result `_meta` hidden from the model and enforce app-only tool visibility.
- Sessions expire by age/idle cleanup and are closed on process signals.
- Audit breadcrumbs omit terminal output, suggested command content, and app/WebSocket tokens.

## Deployment Verification

A deployment can be checked with:

```bash
npm run verify:deployment
```

Configure the verifier with environment variables for your own gateway and container paths.
See `docs/manual-app-smoke.md` for the human UI smoke checklist.

## Host Compatibility

quick-shell follows the MCP Apps standard first: `open_quick_shell` declares `_meta.ui.resourceUri`, the app resource is served as `text/html;profile=mcp-app`, and the iframe talks to the host through the standard `ui/*` bridge. ChatGPT/OpenAI compatibility aliases are also present (`openai/outputTemplate`, widget visibility/status metadata), and app-only helper tools stay hidden from the model through `_meta.ui.visibility: ["app"]`.

The UI adopts host context when available:

- host theme, style variables, fonts, safe-area insets, and display mode
- `ui/request-display-mode` for inline/fullscreen switching when offered
- `ui/download-file` for user-initiated output export when offered
- `ui/update-model-context` for session state only; terminal output is never silently inserted into model context
- host logging for app errors when offered

Output return uses `app.sendMessage`. A compatible host must render the app, connect the terminal bridge, and accept `app.sendMessage` so the user-approved output appears in the conversation. If `app.sendMessage` is unsupported or rejected, the app keeps the send dialog open and shows a copyable fallback; that host is unsupported for full v1 output return.

Manual app smoke should verify:

- App renders.
- Terminal begins connecting without an extra click.
- In remote gateway mode, unreachable direct WebSockets fall back to app-only MCP transport.
- Suggested command is displayed but not inserted until Insert.
- Insert sends exactly the edited text and does not press Enter.
- Confirm sends edited output through `app.sendMessage`.
- Unsupported `app.sendMessage` shows the copy fallback.
- Fullscreen and download controls appear only when the host advertises those capabilities.

## V1 Deferrals

- Target daemons
- Non-SSH transports
- Remote or multi-user auth
- Windows PTY guarantees
- Durable transcripts or session resume
