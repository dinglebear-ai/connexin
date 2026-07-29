# Connexin

Connexin is a Node.js MCP App for human-controlled SSH terminal sessions and optional confined SFTP file operations. The TypeScript app/server lives in `src/`; the SFTP helper is Go in `cmd/`.

## Repository conventions

- `CLAUDE.md` is the agent-memory source of truth. `AGENTS.md` and `GEMINI.md` must remain symlinks to this file.
- Keep root files limited to project entry points and package metadata. Shared configuration belongs under `config/`; the MCP App HTML lives with its app source at `src/app/mcp-app.html`.
- Preserve the human-consent boundary: models can request a session, but only the user drives the terminal and returns output.
- File operations are disabled unless the deployment has server-enforced remote confinement. Do not weaken this gate with client-side path checks.
- Treat secrets and deployment URLs as environment variables. Put non-secret behavior and limits in Connexin configuration, not `.env`.

## Verification

Run `npm run check` for the full TypeScript/Go build, lint, format, and coverage suite. Run `npm audit` after dependency changes. CI also runs a real OpenSSH SFTP integration and stdio smoke test.
