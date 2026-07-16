# quick-shell

quick-shell is a local MCP App for short, human-approved SSH terminal sessions. An agent can request `open_quick_shell` for an SSH-configured device alias, but the user controls the terminal, decides whether to insert any suggested command, runs commands manually, reviews output, and explicitly confirms anything sent back to the conversation.

## Developer Setup

```bash
npm install
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run smoke:stdio
npm run check
```

Useful development commands:

```bash
npm run dev              # rebuild the MCP app and run the HTTP server with a dev token
npm run serve:stdio      # run the built stdio MCP server
npm run serve            # run the built localhost HTTP MCP server
npm run verify:deployment
```

Stdio is the recommended production transport:

```bash
npm run build
node dist/server/server/main.js --stdio
```

HTTP mode is localhost-only and requires bearer auth:

```bash
QUICK_SHELL_HTTP_TOKEN='replace-me' node dist/server/server/main.js --http
```

Requests to `/mcp` must include `Authorization: Bearer <token>`. The HTTP MCP server binds to `127.0.0.1` and does not enable broad CORS.

## Local CLI

The local CLI opens a human-controlled SSH terminal directly:

```bash
npm run build
node dist/server/cli/main.js --list
node dist/server/cli/main.js test-device --suggest 'hostname'
node dist/server/cli/main.js test-device --suggest 'hostname' --prefill-delay-ms 0
```

`--list` prints explicit SSH aliases plus optional metadata columns: alias, label, group, and danger.

`--suggest` writes a suggested command into the terminal input after the SSH PTY is created. It does not press Enter. The user can edit or delete the text before running it. `--prefill-delay-ms` controls the write delay, defaults to `1000`, accepts non-negative integers, and uses `0` for immediate prefill. A delayed prefill is canceled if the SSH process exits first.

The local CLI does not accept `--reason`. Use the MCP API `reason` field when the caller needs to explain why a session is being requested.

## Configuration

| Variable                                     | Default                                      | Purpose                                                                                           |
| -------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `QUICK_SHELL_SSH_CONFIG`                     | `$HOME/.ssh/config`                          | Primary SSH config file. This file is required.                                                   |
| `QUICK_SHELL_CONFIG`                         | `$HOME/.config/quick-shell/quick-shell.toml` | Optional device metadata file. Missing file is treated as empty metadata.                         |
| `QUICK_SHELL_AUDIT_LOG`                      | stderr audit output                          | JSONL audit log path.                                                                             |
| `QUICK_SHELL_HTTP_TOKEN`                     | unset                                        | Required bearer token for `--http` mode.                                                          |
| `QUICK_SHELL_HTTP_PORT`                      | random port                                  | Localhost HTTP MCP port for `--http` mode.                                                        |
| `QUICK_SHELL_ALLOWED_ORIGINS`                | empty                                        | Comma-separated exact WebSocket `Origin` allowlist for `/terminal`. Empty means no origin filter. |
| `QUICK_SHELL_BRIDGE_HOST`                    | `127.0.0.1`                                  | Terminal bridge bind host. Use `0.0.0.0` only behind a trusted TLS reverse proxy.                 |
| `QUICK_SHELL_BRIDGE_PORT`                    | `0`                                          | Terminal bridge bind port. `0` asks the OS for a free port.                                       |
| `QUICK_SHELL_BRIDGE_PUBLIC_URL`              | bridge listen URL                            | Public base URL advertised to the MCP App. Non-loopback URLs must use HTTPS by default.           |
| `QUICK_SHELL_ALLOW_INSECURE_PUBLIC_BRIDGE`   | unset                                        | Set to `1` only for local development if a non-loopback public bridge URL must use HTTP.          |
| `QUICK_SHELL_MAX_SESSIONS`                   | `4`                                          | Maximum live sessions in one server process.                                                      |
| `QUICK_SHELL_MAX_DEVICE_LENGTH`              | `128`                                        | Maximum device alias length.                                                                      |
| `QUICK_SHELL_MAX_REASON_LENGTH`              | `1000`                                       | Maximum MCP API reason length.                                                                    |
| `QUICK_SHELL_MAX_SUGGESTED_COMMAND_LENGTH`   | `4000`                                       | Maximum suggested command length.                                                                 |
| `QUICK_SHELL_MAX_SCROLLBACK_BYTES`           | `128000`                                     | Bounded scrollback and app-only poll buffer size.                                                 |
| `QUICK_SHELL_MAX_INPUT_BYTES`                | `16384`                                      | Maximum terminal input message size.                                                              |
| `QUICK_SHELL_MAX_SUBMIT_BYTES`               | `64000`                                      | Maximum user-approved output submission size.                                                     |
| `QUICK_SHELL_MAX_WS_PAYLOAD_BYTES`           | `16384`                                      | Maximum bridge WebSocket payload size.                                                            |
| `QUICK_SHELL_WS_BUFFERED_AMOUNT_LIMIT_BYTES` | `1000000`                                    | Backpressure limit before closing a slow terminal client.                                         |
| `QUICK_SHELL_MAX_SESSION_AGE_MS`             | `1800000`                                    | Absolute session lifetime.                                                                        |
| `QUICK_SHELL_IDLE_GRACE_MS`                  | `300000`                                     | Idle lifetime before cleanup.                                                                     |
| `QUICK_SHELL_CLEANUP_INTERVAL_MS`            | `30000`                                      | Session cleanup interval.                                                                         |

## Devices

V1 accepts only explicit `Host` aliases from the configured SSH config. Wildcards such as `Host *`, `prod-*`, and negated aliases are ignored. `Include` files are followed recursively, including simple `*` and `?` path globs. Relative include paths are resolved the same way OpenSSH resolves user config includes: under `$HOME/.ssh`. The primary SSH config must be readable; optional included files that do not exist are skipped. Include entries that require OpenSSH token expansion, environment expansion, or another user's `~user` home expansion are rejected because quick-shell cannot safely validate the same file OpenSSH would load.

The parser rejects SSH config that can execute local commands before the user reaches the remote shell:

- `ProxyCommand`
- `KnownHostsCommand`
- `LocalCommand`
- `RemoteCommand`
- `PermitLocalCommand yes`
- `Match exec` and negated forms such as `Match !exec`

Add a device to the SSH config:

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

Metadata supports only `[devices.<alias>]` tables with quoted string values for `label`, `group`, `danger`, and `default_shell`. `danger` must be `normal`, `caution`, or `danger`. Metadata for aliases that are not in the SSH allowlist is ignored by session creation.

## Secure Remote Bridge

The terminal bridge is localhost-only by default. For remote MCP App hosts, expose only `/terminal` through a TLS reverse proxy and advertise that public base URL:

```bash
QUICK_SHELL_BRIDGE_HOST=0.0.0.0 \
QUICK_SHELL_BRIDGE_PORT=40101 \
QUICK_SHELL_BRIDGE_PUBLIC_URL=https://shell.example.com \
QUICK_SHELL_ALLOWED_ORIGINS=https://mcp-host.example.com \
node dist/server/server/main.js --stdio
```

Remote bridge requirements:

- Proxy only the bridge path needed by the app: `/terminal`.
- Preserve WebSocket upgrade headers.
- Use HTTPS for `QUICK_SHELL_BRIDGE_PUBLIC_URL`; the app receives a `wss://` terminal URL.
- Set `QUICK_SHELL_ALLOWED_ORIGINS` to the exact MCP App host origin or a comma-separated list of exact origins. When the list is non-empty, requests without a matching `Origin` are rejected before WebSocket upgrade.
- Keep `QUICK_SHELL_ALLOWED_ORIGINS` empty only for local-only deployments or when another trusted layer provides equivalent origin enforcement.
- Keep tool-result `_meta` hidden from the model. App tokens and WebSocket tokens are capabilities and must remain app-only.

The WebSocket URL contains only the session id. The app authenticates with a per-session WebSocket token in its first bridge message.

## API and Capability Model

quick-shell follows the MCP Apps standard first. `open_quick_shell` declares `_meta.ui.resourceUri`, the app resource is served as `text/html;profile=mcp-app`, and the iframe talks to the host through the standard `ui/*` bridge. ChatGPT/OpenAI compatibility aliases are also present, including `openai/outputTemplate`, widget visibility, and status metadata.

App resource:

| Resource                           | MIME type                   | Notes                                                                |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `ui://quick-shell/mcp-app.v2.html` | `text/html;profile=mcp-app` | Includes CSP metadata with bridge HTTP(S) and WS(S) connect domains. |

Tools:

| Tool                                  | Visibility | Purpose                                                                                                                               |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `check_quick_shell`                   | model      | Side-effect-free health check with active session counts, started session counts, max sessions, and public-bridge status.             |
| `list_quick_shell_devices`            | model      | Lists allowlisted aliases and non-secret device metadata so agents do not have to guess target names.                                 |
| `open_quick_shell`                    | model      | Prepares a session capability for an allowlisted SSH alias. Inputs are `device`, optional `reason`, and optional `suggested_command`. |
| `get_quick_shell_session`             | app        | Exchanges hidden app capability for app session details when the initial tool result did not include them.                            |
| `poll_quick_shell_session`            | app        | App-only output polling fallback when the browser cannot reach the direct bridge. Terminal output is returned in hidden `_meta`.      |
| `write_quick_shell_input`             | app        | App-only input fallback.                                                                                                              |
| `resize_quick_shell_session`          | app        | App-only terminal resize fallback.                                                                                                    |
| `close_quick_shell_session`           | app        | App-owned session close.                                                                                                              |
| `record_quick_shell_output_confirmed` | app        | Audit breadcrumb after the user confirms output return.                                                                               |

`open_quick_shell` returns model-visible text plus structured public session fields: `sessionId`, `device`, optional `reason`, optional `suggestedCommand`, and optional device metadata. The model-visible text says the session is prepared, not opened: the SSH PTY starts only after a compatible MCP App host renders the app and attaches through the bridge or app-only fallback. Hidden `_meta.quickShell` contains the app token. Hidden `_meta.quickShellSession` may also include bridge URL, WebSocket token, limits, and ping cadence so the app can attach immediately.

App-only tools require the hidden app token. Direct WebSocket sessions require the hidden WebSocket token. Tokens are never placed in model-visible `content` or `structuredContent`.

## Architecture and Session Topology

One runtime process owns:

- MCP server registration and transports.
- The terminal bridge HTTP/WebSocket listener.
- The in-memory session manager.
- SSH PTYs and bounded scrollback buffers.
- Cleanup timers and audit logging.

`open_quick_shell` creates a session and tokens, but the SSH PTY starts only when the MCP App attaches through the bridge or app-only fallback. Each session has one active bridge socket; a newer view replaces the previous socket. App-only fallback uses the same session manager and token model, so it must reach the same runtime process that created the session.

Deployment topology matters. If you run multiple quick-shell replicas, route each session's MCP app-only tools and `/terminal` bridge traffic back to the same process that handled `open_quick_shell`, or use a single upstream instance. Round-robin routing without sticky affinity will produce invalid or missing session capability errors.

Important sticky limits:

- Default maximum live sessions per process is `4`.
- Sessions expire by absolute age and idle timeout.
- Sessions are closed on process shutdown and process signals.
- Bridge clients are closed on authentication timeout, invalid schema, invalid token, backpressure, or session replacement.
- There is no durable transcript or session resume in v1.

## Output Handling

Terminal output is bounded in memory. When the user clicks `Send output`, the app normalizes recent output, strips terminal control sequences, truncates to the configured byte limit, and shows an editable confirmation dialog. The app warns about common secret-looking patterns such as API keys, private keys, password assignments, token assignments, and bearer headers.

This is not a DLP system. The warning pass is a best-effort prompt for human review, not a guarantee that secrets or sensitive data are detected. The user remains responsible for editing or canceling output before confirming.

Output return uses `app.sendMessage`. A compatible host must render the app, connect the terminal bridge or app-only fallback, and accept `app.sendMessage` so the approved output appears in the conversation. If `app.sendMessage` is unsupported or rejected, the app keeps the send dialog open and shows a copyable fallback. That host is unsupported for full v1 output return.

Download, when offered by the host, exports sanitized recent scrollback through `ui/download-file`. `ui/update-model-context` is used only for session state, never for terminal output.

Audit breadcrumbs can include session ids, device aliases, whether a reason was present, suggested command text, byte counts, bridge rejection reasons, startup errors, and lifecycle events. They do not include terminal output or app/WebSocket tokens.

## Host Compatibility and Accessibility

The UI adopts host context when available:

- host theme, style variables, fonts, safe-area insets, and display mode
- `ui/request-display-mode` for inline/fullscreen switching when offered
- `ui/download-file` for user-initiated output export when offered
- `ui/update-model-context` for session state only
- host logging for app errors when offered

Host-specific controls stay hidden when their host capability is unavailable. The app uses host-neutral visible copy and exposes labels/live regions for the session status, suggested command field, terminal region, and send-output dialog.

## Deployment Verification

A deployment can be checked with:

```bash
npm run verify:deployment
```

The verifier contract is intentionally stricter than a process liveness check. It verifies:

- local build manifest exists, is clean, and matches local `HEAD`
- deployed source path and build manifest exist
- deployed manifest fields and file hashes match the local build
- optional gateway config env expectations are present
- gateway upstream command and args match the expected process
- gateway runtime is connected and exposes the expected tool count
- app-only tools are not visible to model discovery
- `check_quick_shell` can be called through the gateway

Verifier environment:

| Variable                               | Default                                                     | Purpose                                                                                  |
| -------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `QUICK_SHELL_VERIFY_UPSTREAM`          | `quick-shell`                                               | Gateway upstream name.                                                                   |
| `QUICK_SHELL_VERIFY_CONTAINER`         | unset                                                       | Optional container name for running checks through `incus exec`.                         |
| `QUICK_SHELL_VERIFY_USER`              | unset                                                       | Optional user inside the container.                                                      |
| `QUICK_SHELL_VERIFY_HOME`              | unset                                                       | Treat current working directory under this path as already inside the deployment target. |
| `QUICK_SHELL_VERIFY_GATEWAY_CLI`       | `gatewayctl`                                                | Gateway CLI command.                                                                     |
| `QUICK_SHELL_VERIFY_GATEWAY_CONFIG`    | unset                                                       | Optional gateway config path to inspect for expected env values.                         |
| `QUICK_SHELL_VERIFY_PATH`              | `/opt/quick-shell`                                          | Deployed quick-shell source/build path.                                                  |
| `QUICK_SHELL_VERIFY_COMMAND`           | `node`                                                      | Expected upstream command.                                                               |
| `QUICK_SHELL_VERIFY_ARGS`              | `["/opt/quick-shell/dist/server/server/main.js","--stdio"]` | Expected upstream args as JSON array or whitespace-split string.                         |
| `QUICK_SHELL_VERIFY_AUDIT_LOG`         | unset                                                       | Expected `QUICK_SHELL_AUDIT_LOG` in gateway config.                                      |
| `QUICK_SHELL_VERIFY_BRIDGE_HOST`       | unset                                                       | Expected bridge host in gateway config.                                                  |
| `QUICK_SHELL_VERIFY_BRIDGE_PORT`       | unset                                                       | Expected bridge port in gateway config.                                                  |
| `QUICK_SHELL_VERIFY_BRIDGE_PUBLIC_URL` | unset                                                       | Expected public bridge URL in gateway config.                                            |

On failure, the verifier returns failures plus a recovery hint: restart or recycle the configured gateway upstream, then rerun with the same `QUICK_SHELL_VERIFY_*` environment.

## Operations, Rollback, and Incidents

Before deploying, run:

```bash
npm run check
npm run smoke:stdio
```

After deploying, run `npm run verify:deployment` and at least one manual app smoke scenario from `docs/manual-app-smoke.md`.

Operational checks:

- Confirm `check_quick_shell` succeeds through the gateway.
- Confirm the gateway reports the upstream as connected with the expected exposed tool count.
- Confirm app-only tools are hidden from model discovery.
- Confirm the bridge public URL and allowed origins match the host that will render the app.
- Review the audit log for startup failures, bridge rejections, stale sessions, and cleanup events.

Rollback:

1. Restore the previous built quick-shell source or package at the deployment path.
2. Restore the previous gateway command, args, and quick-shell environment.
3. Restart or recycle the gateway upstream so the stdio process and bridge listener are replaced.
4. Rerun `npm run verify:deployment`.
5. Run the manual smoke scenario that previously failed.

Incident response:

1. Disable or stop the quick-shell upstream to kill active sessions and invalidate in-memory app/WebSocket tokens.
2. Remove or disable the public `/terminal` reverse-proxy route if bridge exposure is suspected.
3. Preserve audit logs before restarting if investigation is needed.
4. Rotate `QUICK_SHELL_HTTP_TOKEN` for HTTP mode and any external gateway secret that can launch the server.
5. Restart with known-good config, verify deployment, and run manual smoke before re-enabling access.

## Manual Smoke

See `docs/manual-app-smoke.md` for the scenario matrix covering baseline app attach, prefill behavior, app-only fallback, host capability gating, output return, unsupported hosts, and remote bridge origin checks.

## V1 Deferrals

- Target daemons
- Non-SSH transports
- Remote or multi-user auth
- Windows PTY guarantees
- Durable transcripts or session resume
