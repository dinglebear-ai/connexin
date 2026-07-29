# connexin

connexin is a local MCP App for short, human-approved SSH terminal sessions and confined SFTP file operations. An agent can request `open_connexin` for an SSH-configured device alias, but the user controls the terminal and file explorer.

## Developer Setup

```bash
npm install
go test ./...
go vet ./...
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
npm run test:sftp-integration -- dist/bin/connexin-sftp /path/to/ssh_config host-alias
```

Stdio is the recommended production transport:

```bash
npm run build
node dist/server/server/main.js --stdio
```

HTTP mode is localhost-only and requires bearer auth:

```bash
CONNEXIN_HTTP_TOKEN='replace-me' node dist/server/server/main.js --http
```

Requests to `/mcp` must include `Authorization: Bearer <token>`. The HTTP MCP server binds to `127.0.0.1` and does not enable broad CORS.

## Local CLI

The local CLI opens a human-controlled SSH terminal directly:

```bash
npm run build
node dist/server/cli/main.js --list
node dist/server/cli/main.js test-device --suggest 'hostname'
```

`--list` prints explicit SSH aliases plus optional metadata columns: alias, label, group, and danger.

`--suggest` keeps the suggested command outside the SSH PTY until the user presses `Ctrl-G`. That explicit action inserts the command without pressing Enter, so the user can edit or delete it before running it. No timer writes suggestion bytes into host-key, password, or other SSH prompts.

The local CLI does not accept `--reason`. Use the MCP API `reason` field when the caller needs to explain why a session is being requested.

## Configuration

Connexin keeps its ordinary runtime policy in `$HOME/.config/connexin/connexin.toml`; set `CONNEXIN_CONFIG` only to use a different file. Start from [`config/connexin.toml.example`](config/connexin.toml.example). The optional file also contains device metadata, so there is one reviewed place for operational settings rather than a long collection of environment variables.

The `[runtime]` table accepts the lower-snake-case forms in the provided template: session, terminal, bridge-listener, confinement, and file-operation limits. URLs, credentials, paths, HTTP listener settings, and public-bridge origin policy stay outside that table. Missing values use the built-in defaults. A `CONNEXIN_<UPPER_SNAKE_CASE>` value still wins when supplied, specifically to support a temporary deployment override, but it should not be the normal configuration mechanism.

Keep `.env` limited to deployment-specific URLs, secrets, and paths:

| Variable                     | Default                                | Purpose                                                                        |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `CONNEXIN_CONFIG`            | `$HOME/.config/connexin/connexin.toml` | Location of the combined runtime and device-metadata TOML file.                |
| `CONNEXIN_SSH_CONFIG`        | `$HOME/.ssh/config`                    | Required SSH configuration path.                                               |
| `CONNEXIN_HTTP_TOKEN`        | unset                                  | Bearer secret required in `--http` mode.                                       |
| `CONNEXIN_HTTP_PORT`         | random local port                      | Local HTTP MCP listener port.                                                  |
| `CONNEXIN_BRIDGE_PUBLIC_URL` | bridge listener URL                    | Public HTTPS origin advertised to a remote MCP App.                            |
| `CONNEXIN_ALLOWED_ORIGINS`   | empty                                  | Comma-separated WebSocket origin allowlist; required with a public bridge URL. |
| `CONNEXIN_AUDIT_LOG`         | stderr                                 | JSONL audit-log destination.                                                   |
| `CONNEXIN_SFTP_HELPER`       | bundled helper                         | Explicit SFTP helper path for unusual packaging layouts.                       |

`CONNEXIN_ALLOW_INSECURE_PUBLIC_BRIDGE=1` is a development-only escape hatch for an HTTP, non-loopback bridge URL. Do not put it in a shared `.env`.

## Devices

V1 accepts only explicit `Host` aliases from the configured SSH config. Parsed membership is authoritative for names, so safe aliases such as `home/lab` are accepted; aliases beginning with `-` or containing whitespace/control characters are rejected as unsafe SSH arguments. Wildcards such as `Host *`, `prod-*`, and negated aliases are ignored. Escaped `Host` patterns are rejected conservatively so a partial token cannot become an alias.

Only globally reachable `Include` directives are followed recursively, including simple `*` and `?` path globs. Includes inside `Host` or `Match` blocks do not contribute aliases. Relative include paths are resolved the same way OpenSSH resolves user config includes: under `$HOME/.ssh`. The primary SSH config must be readable; optional included files that do not exist are skipped. Include entries that require OpenSSH token expansion, environment expansion, or another user's `~user` home expansion are rejected because connexin cannot safely validate the same file OpenSSH would load.

The parser rejects SSH config that can execute local commands before the user reaches the remote shell:

- `ProxyCommand` values other than `none`
- `KnownHostsCommand` values other than `none`
- `LocalCommand`
- `RemoteCommand` values other than `none`
- `PermitLocalCommand` enabled (`yes`, `true`, or `1`)
- `PKCS11Provider` values other than `none`
- `SecurityKeyProvider` values other than `internal`

These directives are rejected wherever they appear, including inside files pulled
in by an `Include` under a `Host` or `Match` block.

- `Match exec` and negated forms such as `Match !exec`

Add a device to the SSH config:

```sshconfig
Host test-device
  HostName 192.0.2.10
  User operator
```

Then ask the agent to open connexin for `test-device`.

Optional `connexin.toml` metadata can decorate SSH aliases without granting access:

```toml
[devices.test-device]
label = "Test Device"
group = "dev"
danger = "normal"
default_shell = "zsh"
```

Metadata supports only `[devices.<alias>]` tables with quoted string values for `label`, `group`, `danger`, and `default_shell`. `danger` must be `normal`, `caution`, or `danger`. Metadata for aliases that are not in the SSH allowlist is ignored by session creation.

## Secure Remote Bridge

The bridge is localhost-only by default. For remote MCP App hosts, expose `/terminal`, `/files/upload`, and `/files/download` through a TLS reverse proxy and advertise that public base URL:

```bash
CONNEXIN_BRIDGE_PUBLIC_URL=https://shell.example.com \
CONNEXIN_ALLOWED_ORIGINS=https://mcp-host.example.com \
node dist/server/server/main.js --stdio
```

Set `bridge_host = "0.0.0.0"` and `bridge_port = 40101` in the `[runtime]`
table when the TLS proxy must reach the bridge. The environment variables shown
above are deliberately limited to the public URL and allowed-origin deployment
settings; setting `CONNEXIN_BRIDGE_HOST` or `CONNEXIN_BRIDGE_PORT` is supported
only as a temporary process override.

Remote bridge requirements:

- Proxy only the bridge paths needed by the app: `/terminal`, `/files/upload`, and `/files/download`.
- Set `CONNEXIN_BRIDGE_PUBLIC_URL` to an origin with no path prefix; v1 serves `/terminal`, `/files/upload`, and `/files/download` at that origin's root.
- Preserve WebSocket upgrade headers.
- Disable proxy buffering on file routes and enforce compatible body and timeout limits.
- Use HTTPS for `CONNEXIN_BRIDGE_PUBLIC_URL`; the app receives a `wss://` terminal URL.
- Set `CONNEXIN_ALLOWED_ORIGINS` to the MCP App host origin or a comma-separated list. When the list is non-empty, requests without a matching `Origin` are rejected before WebSocket upgrade. Hosts that sandbox app iframes on rotating per-connector origins (Claude uses `{hash}.claudemcpcontent.com`) need a wildcard entry such as `https://*.claudemcpcontent.com`; wildcards match exactly one subdomain label, and the per-session WebSocket token remains the actual authentication.
- Keep `CONNEXIN_ALLOWED_ORIGINS` empty only for local-only deployments. It is required whenever `CONNEXIN_BRIDGE_PUBLIC_URL` is set: the server refuses to start on that combination, even if a proxy in front of it already enforces origins.
- Keep tool-result `_meta` hidden from the model. App tokens and WebSocket tokens are capabilities and must remain app-only.

The WebSocket URL contains only the session id. The app authenticates with a per-session WebSocket token in its first bridge message.

## API and Capability Model

connexin follows the MCP Apps standard first. `open_connexin` declares `_meta.ui.resourceUri`, the app resource is served as `text/html;profile=mcp-app`, and the iframe talks to the host through the standard `ui/*` bridge. ChatGPT/OpenAI compatibility aliases are also present, including `openai/outputTemplate`, widget visibility, and status metadata. App-only sibling tools are private, token-gated callbacks; they do not bind their own app resource or output template.

App resource:

| Resource                        | MIME type                   | Notes                                                      |
| ------------------------------- | --------------------------- | ---------------------------------------------------------- |
| `ui://connexin/mcp-app.v5.html` | `text/html;profile=mcp-app` | Canonical terminal and Files app with bridge CSP metadata. |
| `ui://connexin/mcp-app.v4.html` | `text/html;profile=mcp-app` | Compatibility URI.                                         |
| `ui://connexin/mcp-app.v3.html` | `text/html;profile=mcp-app` | Compatibility URI.                                         |
| `ui://connexin/mcp-app.v2.html` | `text/html;profile=mcp-app` | Compatibility URI.                                         |
| `ui://connexin/mcp-app.html`    | `text/html;profile=mcp-app` | V1 legacy compatibility URI.                               |

Tools:

| Tool                               | Visibility | Purpose                                                                                                                                      |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_connexin`                   | model      | Side-effect-free health check with active session counts, started session counts, max sessions, and public-bridge status.                    |
| `list_connexin_devices`            | model      | Lists allowlisted aliases and non-secret device metadata so agents do not have to guess target names.                                        |
| `open_connexin`                    | model      | Prepares a session capability for an allowlisted SSH alias. Inputs are `device`, optional `reason`, and optional `suggested_command`.        |
| `get_connexin_session`             | app        | App-only attach. Starts the SSH PTY for the session and returns app session details (bridge URL, WebSocket token, limits) in hidden `_meta`. |
| `poll_connexin_session`            | app        | App-only output polling fallback when the browser cannot reach the direct bridge. Terminal output is returned in hidden `_meta`.             |
| `write_connexin_input`             | app        | App-only input fallback.                                                                                                                     |
| `resize_connexin_session`          | app        | App-only terminal resize fallback.                                                                                                           |
| `close_connexin_session`           | app        | App-owned session close.                                                                                                                     |
| `record_connexin_output_confirmed` | app        | Audit breadcrumb after the user confirms output return.                                                                                      |
| `list_connexin_files`              | app        | Bounded root-relative SFTP directory listing in hidden metadata.                                                                             |
| `prepare_connexin_file_operation`  | app        | Creates a short-lived one-use lease for a mutation or transfer.                                                                              |
| `mkdir_connexin_path`              | app        | Creates a directory using a fresh operation lease.                                                                                           |
| `rename_connexin_path`             | app        | Renames a path using a fresh operation lease.                                                                                                |
| `delete_connexin_path`             | app        | Deletes a path using a fresh operation lease.                                                                                                |

## SFTP Safety Model

The Files view starts its helper lazily and uses system OpenSSH with the same configured alias, keys, agent, host verification, and `ProxyJump` behavior as the terminal. Authentication is noninteractive (`BatchMode=yes`), so accept a new host key or unlock a key through the terminal first when necessary.

Paths are relative to the remote account's canonical home. The server bounds path bytes, component bytes, depth, directory entries, pending operations, transfer bytes, and lease lifetime. This is a user-safety boundary, not race-proof isolation from a malicious process running as the same remote user. Symlinks are listed distinctly and destructive operations require explicit UI confirmation plus a fresh one-use lease.

Transfers use fixed bridge routes with a separate file bearer in request headers. Capabilities, leases, and paths do not appear in URLs or model-visible MCP content. Downloads are bounded and appear only when the host advertises `downloadFile`; larger or resumable transfers remain out of scope.

`open_connexin` returns model-visible text plus structured public session fields: `sessionId`, `device`, optional `reason`, optional `suggestedCommand`, and optional device metadata. The model-visible text says the session is prepared, not opened: the SSH PTY starts only after a compatible MCP App host renders the app and attaches through the bridge or app-only fallback. Hidden `_meta.connexin` contains the app token. Hidden `_meta.connexinSession` may also include bridge URL, WebSocket token, limits, and ping cadence so the app can attach immediately.

App-only tools require the hidden app token. Direct WebSocket sessions require the hidden WebSocket token. Tokens are never placed in model-visible `content` or `structuredContent`.

## Architecture and Session Topology

One runtime process owns:

- MCP server registration and transports.
- The terminal bridge HTTP/WebSocket listener.
- The in-memory session manager.
- SSH PTYs and bounded scrollback buffers.
- Cleanup timers and audit logging.

`open_connexin` creates a session and tokens, but the SSH PTY starts only when the MCP App attaches through the bridge or app-only fallback. Each session has one active bridge socket; a newer view replaces the previous socket. App-only fallback uses the same session manager and token model, so it must reach the same runtime process that created the session.

Deployment topology matters. If you run multiple connexin replicas, route each session's MCP app-only tools and `/terminal` bridge traffic back to the same process that handled `open_connexin`, or use a single upstream instance. Round-robin routing without sticky affinity will produce invalid or missing session capability errors.

Important sticky limits:

- Default maximum live sessions per process is `4`.
- Sessions expire by absolute age and idle timeout.
- Sessions are closed on process shutdown and process signals.
- Bridge clients are closed on authentication timeout, invalid schema, invalid token, backpressure, or session replacement.

### File-operation confinement

File operations are disabled by default. Set `file_root_confinement_enforced = true` in `[runtime]` only when the remote SSH account is confined by the server (for example a chrooted `internal-sftp` account) to the intended file root. Client-side SFTP pathname checks are not atomic against a concurrent symlink swap and are not a substitute for server-side confinement.

- There is no durable transcript or session resume in v1.

## Output Handling

Terminal output is bounded in memory. When the user clicks `Send output`, the app normalizes recent output, strips terminal control sequences, truncates to the configured byte limit, and shows an editable confirmation dialog. The app warns about five specific secret-looking patterns: OpenAI-style `sk-` keys, OpenSSH private key headers, `password =` assignments, `token =` assignments, and `Authorization: Bearer` headers.

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
- app-only tools remain app-visible, OpenAI-private, and free of app resource/output-template bindings
- `check_connexin` can be called through the gateway
- resource smoke: the deployed server serves the app resource as `text/html;profile=mcp-app` and exposes every runtime tool
- audit log smoke: when `CONNEXIN_VERIFY_AUDIT_LOG` is set, the log contains `runtime_started` and `bridge_listening` with the expected `baseUrl`

Verifier environment:

| Variable                            | Default                                                  | Purpose                                                                                  |
| ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CONNEXIN_VERIFY_UPSTREAM`          | `connexin`                                               | Gateway upstream name.                                                                   |
| `CONNEXIN_VERIFY_CONTAINER`         | unset                                                    | Optional container name for running checks through `incus exec`.                         |
| `CONNEXIN_VERIFY_USER`              | unset                                                    | Optional user inside the container.                                                      |
| `CONNEXIN_VERIFY_HOME`              | unset                                                    | Treat current working directory under this path as already inside the deployment target. |
| `CONNEXIN_VERIFY_GATEWAY_CLI`       | `gatewayctl`                                             | Gateway CLI command.                                                                     |
| `CONNEXIN_VERIFY_GATEWAY_CONFIG`    | unset                                                    | Optional gateway config path to inspect for expected env values.                         |
| `CONNEXIN_VERIFY_PATH`              | `/opt/connexin`                                          | Deployed connexin source/build path.                                                     |
| `CONNEXIN_VERIFY_COMMAND`           | `node`                                                   | Expected upstream command.                                                               |
| `CONNEXIN_VERIFY_ARGS`              | `["/opt/connexin/dist/server/server/main.js","--stdio"]` | Expected upstream args as JSON array or whitespace-split string.                         |
| `CONNEXIN_VERIFY_AUDIT_LOG`         | unset                                                    | Expected `CONNEXIN_AUDIT_LOG` in gateway config.                                         |
| `CONNEXIN_VERIFY_BRIDGE_HOST`       | unset                                                    | Expected bridge host in gateway config.                                                  |
| `CONNEXIN_VERIFY_BRIDGE_PORT`       | unset                                                    | Expected bridge port in gateway config.                                                  |
| `CONNEXIN_VERIFY_BRIDGE_PUBLIC_URL` | unset                                                    | Expected public bridge URL in gateway config.                                            |

On failure, the verifier returns failures plus a recovery hint: restart or recycle the configured gateway upstream, then rerun with the same `CONNEXIN_VERIFY_*` environment.

## Operations, Rollback, and Incidents

Before deploying, run:

```bash
npm run check
npm run smoke:stdio
```

After deploying, run `npm run verify:deployment` and at least one manual app smoke scenario from `docs/manual-app-smoke.md`.

Operational checks:

- Confirm `check_connexin` succeeds through the gateway.
- Confirm the gateway reports the upstream as connected with the expected exposed tool count.
- Confirm app-only tools remain private, token-gated callbacks without their own app resource/output-template binding.
- Confirm the bridge public URL and allowed origins match the host that will render the app.
- Review the audit log for startup failures, bridge rejections, stale sessions, and cleanup events.

Rollback:

1. Restore the previous built connexin source or package at the deployment path.
2. Restore the previous gateway command, args, and connexin environment.
3. Restart or recycle the gateway upstream so the stdio process and bridge listener are replaced.
4. Rerun `npm run verify:deployment`.
5. Run the manual smoke scenario that previously failed.

Incident response:

1. Disable or stop the connexin upstream to kill active sessions and invalidate in-memory app/WebSocket tokens.
2. Remove or disable the public `/terminal` reverse-proxy route if bridge exposure is suspected.
3. Preserve audit logs before restarting if investigation is needed.
4. Rotate `CONNEXIN_HTTP_TOKEN` for HTTP mode and any external gateway secret that can launch the server.
5. Restart with known-good config, verify deployment, and run manual smoke before re-enabling access.

## Manual Smoke

See `docs/manual-app-smoke.md` for the scenario matrix covering baseline app attach, prefill behavior, app-only fallback, host capability gating, output return, unsupported hosts, and remote bridge origin checks.

## V1 Deferrals

- Target daemons
- Non-SSH transports
- Remote or multi-user auth
- Windows PTY guarantees
- Durable transcripts or session resume

## License

Copyright 2026 Jacob Magar.

[PolyForm Noncommercial 1.0.0](LICENSE.md) — free for personal, hobby,
research, and educational use. **Any commercial use requires a separate
license**; open an issue to enquire.

This is a source-available license, not an OSI-approved open source
license.
