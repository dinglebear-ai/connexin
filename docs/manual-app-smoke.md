# Manual MCP App Smoke

Use this checklist in a host that supports MCP Apps.

1. Ask the agent to call `quick_shell.open_quick_shell` with an SSH alias and a harmless suggested command.
2. Confirm the app renders with the expected device label when `quick-shell.toml` metadata exists.
3. Confirm the terminal begins connecting immediately without an extra `Connect` click.
4. In remote gateway mode, confirm a direct WebSocket failure recovers through the app-only fallback and the shell becomes usable.
5. Confirm the suggested command is visible in the command field and is not inserted automatically.
6. Click `Insert` and confirm the command text appears without pressing Enter.
7. Edit the command in the terminal and run it manually.
8. If the host offers fullscreen, click `Fullscreen` and confirm the app expands, then click `Inline`.
9. If the host offers downloads, click `Download output` and confirm the exported file contains sanitized recent scrollback.
10. Click `Send output` and confirm the dialog is prefilled with recent bounded scrollback.
11. Edit the output snippet and confirm byte counts update.
12. Confirm likely secret warnings appear for token-like text.
13. Click `Confirm` and verify the approved output appears in the conversation.
14. Confirm the terminal remains open after output is sent.
15. Click `Close` and verify the session closes without stale terminal output.

Unsupported host fallback:

1. Trigger `open_quick_shell` in a host without MCP App rendering.
2. Confirm the model-visible text says the session was opened.
3. Confirm no app tokens or WebSocket tokens appear in model-visible content.
4. Confirm host-specific controls are hidden when their capabilities are not advertised.
