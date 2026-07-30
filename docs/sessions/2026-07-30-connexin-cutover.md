---
date: 2026-07-30 18:31:17 EST
repo: git@github.com:dinglebear-ai/connexin.git
branch: main
head: 2e81418
session id: b93b2d7b-694c-486b-92ec-333c5ec80e0d
transcript: /home/jmagar/.claude/projects/-home-jmagar-workspace-connexin/b93b2d7b-694c-486b-92ec-333c5ec80e0d.jsonl
working directory: /home/jmagar/workspace/connexin
worktree: /home/jmagar/workspace/connexin
pr: "#2 Complete the Connexin cutover https://github.com/dinglebear-ai/connexin/pull/2"
beads: connexin-btt
---

# Connexin cutover, review, and cleanup

## User Request

Complete the repository cleanup and full Connexin cutover: relocate root artifacts, slim environment configuration, update all documentation and tests, review the PR, address every finding, merge it, and clean stale worktrees.

## Session Overview

PR [#2](https://github.com/dinglebear-ai/connexin/pull/2) completed the Quick Shell to Connexin cutover and was merged to `main` as `2e81418`. The work moved TypeScript and MCP App source artifacts out of the root, consolidated runtime policy into TOML, refreshed documentation and CI, and closed the associated bead.

## Sequence of Events

1. Created an isolated cutover worktree and inspected the existing repository, configuration, tests, and documentation.
2. Renamed runtime/API/package/release surfaces to Connexin; moved the SFTP helper, tsconfigs, app HTML, and examples.
3. Added combined `[runtime]` and `[devices.*]` TOML support, with environment variables reserved for paths, URLs, credentials, and temporary overrides.
4. Ran full validation, then fixed review findings for packaged config templates, duplicate manifest keys, duplicate TOML keys, and production app-artifact lookup.
5. Pushed and merged PR #2 after its `build` workflow succeeded; synchronized `main` and removed merged cutover/review worktrees and branches.
6. Closed `connexin-btt` after observing the merged implementation and verification evidence.

## Key Findings

- `src/server/mcp-tooling.ts` had to resolve the built app from `dist/app/src/app/mcp-app.html` when running from compiled server code; a source-only lookup would not work in the published package.
- `src/server/config.ts` now rejects duplicate and unknown `[runtime]` keys rather than silently accepting ambiguous policy.
- `src/server/device-metadata.ts` must skip the `[runtime]` table so one TOML file can hold both policy and device metadata.
- `package.json` now packages both config templates and verifies their presence with `scripts/check-package-contents.mjs`.

## Technical Decisions

- Keep `.env` for secrets, deployment URLs, paths, and necessary listener values; put behavioral limits and non-secret policy in `connexin.toml`.
- Make `CLAUDE.md` the sole memory source and keep `AGENTS.md` and `GEMINI.md` as symlinks.
- Retain temporary `CONNEXIN_*` overrides so deployment automation can override a TOML default without making environment configuration the primary interface.
- Add `npm audit --audit-level=high` to CI and test package contents rather than trusting `npm pack --dry-run` output manually.

## Files Changed

The merged commit changed 75 paths. Renames are shown as `old -> new`; all remaining paths were modified unless marked created or deleted.

| Status   | Paths                                                                                                                                                                                                                                                                                                                                                                   | Purpose / evidence                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| deleted  | `.env.example`                                                                                                                                                                                                                                                                                                                                                          | Replaced by slim `config/connexin.env.example`.                                           |
| created  | `CLAUDE.md`; `AGENTS.md`; `GEMINI.md`; `config/connexin.env.example`; `config/connexin.toml.example`; `scripts/check-package-contents.mjs`                                                                                                                                                                                                                              | Agent-memory source/symlinks, config templates, and package assertion.                    |
| renamed  | `cmd/quick-shell-sftp/{handle_test.go,handle_unix_test.go,harness_test.go,main.go,pipe_unix.go,pipe_windows.go,protocol.go,protocol_test.go,serve_test.go} -> cmd/connexin-sftp/...`                                                                                                                                                                                    | Connexin SFTP helper name.                                                                |
| renamed  | `{tsconfig.app.json,tsconfig.base.json,tsconfig.scripts.json,tsconfig.server.json,tsconfig.test.json} -> config/typescript/...`                                                                                                                                                                                                                                         | Remove split TypeScript config from repo root.                                            |
| renamed  | `mcp-app.html -> src/app/mcp-app.html`                                                                                                                                                                                                                                                                                                                                  | Co-locate HTML entry with app source.                                                     |
| modified | `.github/workflows/{ci,release}.yml`; `package{,-lock}.json`; `tsconfig.json`; `vite.config.ts`                                                                                                                                                                                                                                                                         | CI audit, Connexin release assets/package metadata, and relocated build inputs.           |
| modified | `README.md`; `docs/manual-app-smoke.md`                                                                                                                                                                                                                                                                                                                                 | Current API/resource, configuration, deploy, smoke, and rollback guidance.                |
| modified | `scripts/{install-sftp-helper,lint-static,sftp-helper-target,sftp-integration,smoke-build-and-stdio,verify-deployment,write-build-manifest}.{mjs,ts}`                                                                                                                                                                                                                   | Connexin naming, manifest inputs, static/package checks, deployment smoke.                |
| modified | `src/app/{aurora-tokens,dialogs,file-api,file-viewer,mcp-app,terminal-transport,view}.{css,ts}`                                                                                                                                                                                                                                                                         | Connexin app metadata and file lease surface.                                             |
| modified | `src/cli/main.ts`; `src/server/{audit-log,bridge-server,config,create-server,device-metadata,ensure-sftp-helper,health-tool,main,mcp-tooling,session-manager,sftp-helper}.ts`; `src/shared/protocol.ts`                                                                                                                                                                 | Runtime naming, config loading, MCP resources/tools, capability metadata, and app lookup. |
| modified | `tests/app/{file-api,mcp-app}.test.ts`; `tests/cli/main.test.ts`; `tests/scripts/{sftp-helper-target,verify-deployment,write-build-manifest}.test.ts`; `tests/server/{audit-log,bridge-server,config,create-server,device-metadata,e2e-fake-pty,ensure-sftp-helper,main,session-manager,sftp-helper-path,ssh-config}.test.ts`; `tests/server/helpers/runtime-config.ts` | Renamed contracts plus regression coverage for TOML and packaging behavior.               |

## Beads Activity

| Bead                                                                  | Action                                            | Final status | Why it mattered                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `connexin-btt` — Complete Connexin cutover and configuration redesign | Created during implementation; closed after merge | closed       | Tracked the requested rename, configuration redesign, docs, CI, and regression work.               |
| `connexin-0sq` — Full codebase review and remediation                 | Read only                                         | in progress  | Existing review bead; not changed because its close criteria were not established in this session. |

## Repository Maintenance

- Plans: `docs/plans/` did not exist, so no plan files were moved.
- Worktrees/branches: removed the clean, merged `codex-connexin-cutover` and `codex-review-full-codebase` worktrees and their remote branches after PRs #2 and #1 were confirmed merged.
- A clean `codex/fleet-alignment-20260730` worktree remains at the same `main` commit; it was not removed because it is an active named worktree with unclear ownership.
- Stale docs: README and `docs/manual-app-smoke.md` were updated alongside the implementation; `config/` examples are now shipped in the npm package.
- Beads: `connexin-btt` was closed with merge and verification evidence. No other bead state was changed.

## Tools and Skills Used

- Shell/Git/GitHub CLI: repository inspection, worktree lifecycle, commits, PR creation/merge, CI status, and cleanup.
- File editing and formatting: applied source/docs/config changes and ran Prettier.
- `lavra:lavra-review`: parallel review of runtime, API/security, and docs/CI aspects; findings were remediated.
- `vibin:review-pr`: final PR inspection of status, comments, checks, diff hygiene, and rename completeness.
- Beads CLI: read and closed the directly relevant cutover bead.
- No browser or external MCP tools were needed; Labby connectivity was reported unreachable by the environment setup, but no task required it.

## Commands Executed

| Command                                  | Result                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run check`                          | Built, linted, formatted, and ran 362 passing tests with coverage.                                         |
| `npm run smoke:stdio:built`              | Passed.                                                                                                    |
| `go test ./... && go vet ./...`          | Passed.                                                                                                    |
| `npm audit --audit-level=high`           | Found 0 vulnerabilities.                                                                                   |
| `npm run check:launcher`                 | Passed package-content assertion.                                                                          |
| `gh pr merge 2 --squash --delete-branch` | PR merged; local branch cleanup needed a follow-up because `main` was checked out in the primary worktree. |

## Errors Encountered

- Prettier was initially invoked against unsupported `*.example` paths; the normal formatter check was rerun successfully.
- `gh pr merge` merged PR #2 but could not switch local branches because `main` was already occupied by the primary worktree. The primary checkout was fast-forwarded and the merged worktree/branch were then removed explicitly.
- Review identified a missing packaged config template, duplicate JSON keys, and duplicate TOML-key handling; all were fixed before merge.

## Behavior Changes (Before/After)

| Area            | Before                                            | After                                                                    |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Identity        | Quick Shell names across APIs, binaries, and docs | Connexin names throughout tracked repository content.                    |
| Configuration   | Large environment-variable surface                | TOML-first runtime/device configuration with slim env example.           |
| Packaging       | Config template omitted from npm tarball          | Both config examples shipped and asserted.                               |
| Repository root | Root tsconfigs and MCP HTML                       | TypeScript config under `config/typescript/`; app HTML under `src/app/`. |

## Verification Evidence

| Command                         | Expected                          | Actual                      | Status |
| ------------------------------- | --------------------------------- | --------------------------- | ------ |
| `npm run check`                 | Full Node/Go quality gate         | 27 files / 362 tests passed | pass   |
| `npm run smoke:stdio:built`     | Built stdio server smoke          | Passed                      | pass   |
| `go test ./... && go vet ./...` | Go helper correctness             | Passed                      | pass   |
| `npm audit --audit-level=high`  | No high-severity dependency issue | 0 vulnerabilities           | pass   |
| GitHub PR #2 build              | Required CI                       | `SUCCESS` before merge      | pass   |

## Risks and Rollback

- The rename changes public MCP tool/resource and binary names. Roll back by reverting merge commit `2e81418` and restoring the previous gateway command/environment configuration.
- Runtime policy now reads `~/.config/connexin/connexin.toml`; invalid, duplicate, or unknown runtime keys intentionally prevent startup instead of silently applying an unintended policy.

## References

- [PR #2](https://github.com/dinglebear-ai/connexin/pull/2)
- [PR #1](https://github.com/dinglebear-ai/connexin/pull/1)
- `README.md`, `docs/manual-app-smoke.md`, `config/connexin.toml.example`

## Next Steps

- No unfinished work from the Connexin cutover remains.
- If operating Connexin in a deployment, copy the packaged TOML example, configure URLs/secrets in the environment, then run `npm run verify:deployment` and the documented manual app smoke.
- Keep the separate `codex/fleet-alignment-20260730` worktree until its owner confirms it is obsolete.
