# nocoproject-cli

Local daemon and agent CLI for NocoProject (Phase 1 iteration 4, protocol version 1).

- The **daemon** registers the coding tools installed on this machine (Claude Code, OpenCode, Codex) as runtimes, wakes up on the `np:daemon` realtime topic (with polling as a fallback), claims queued runs, prepares a workspace, launches the tool, streams its events back and reports the result.
- The **agent CLI** (`nocoproject issue ...`, `project get`, `repo checkout`, `pr link` / `pr list`, `kb list` / `get` / `propose`, `issue design-proposal`, `pm ...`) is what the agent runs inside a run to read the issue, post comments, change the status, create sub-issues, check out project repositories, link pull requests, submit design proposals and (project-manager agents) read across projects. It authenticates with the per-run token the daemon injects.

The contract lives in `nocosolution/NocoProject/docs/phase0/protocol.md`, `nocosolution/NocoProject/docs/phase1/iteration-1-contract.md` (§I), `nocosolution/NocoProject/docs/phase1/iteration-2-contract.md` (§C, §D, §G, §H, §J, §L), `nocosolution/NocoProject/docs/phase1/iteration-3-contract.md` (§I, §J) and `nocosolution/NocoProject/docs/phase1/iteration-4-contract.md` (§B, §C); `src/protocol.ts` is a copy of the shared types and re-exports the iteration-2, -3 and -4 additions from `src/protocol.phase1-iter2.ts`, `src/protocol.phase1-iter3.ts` and `src/protocol.phase1-iter4.ts`. `pnpm sync-protocol` copies all four from `nocoproject/server/modules/shared/` (dropping the `*-server.js` re-exports). See `nocosolution/NocoProject/docs/phase1/workspace.md` for the planned move to a shared `@nocoproject/protocol` workspace package.

## Install

Requires Node.js 22 or later.

```bash
pnpm install
pnpm build            # → dist/cli.js (single file) and dist/echo-agent.js
npm link              # optional: puts `nocoproject` and `ncp` on PATH
```

Without a global install, run `node dist/cli.js ...`. The daemon also writes shims to `~/.nocoproject/bin/{nocoproject,ncp}` and puts that directory first on every agent's `PATH`, so agents can always call `nocoproject`.

## Log in

```bash
nocoproject login --server http://127.0.0.1:13000/main --api-key <NocoBase API key>
```

- `--server` is the application URL **including its mount path** (`APP_BASE_PATH`, `/main` by default). If you give only an origin, login probes `<origin>/api/healthz` and then `<origin>/main/api/healthz`.
- The key is verified with `GET /api/np/me`. Use `--no-verify` to save the key without contacting the server. `--api-key-stdin` keeps the key out of the shell history: on a terminal it prompts and reads one line without echoing; from a pipe it reads to EOF (`printf '%s' "$KEY" | nocoproject login --server <url> --api-key-stdin`).
- The config is saved to `~/.nocoproject/config.json` with mode 0600: `{ serverUrl, apiKey, daemonId, deviceName }`. `daemonId` is a UUID generated once per machine.

## Run the daemon

```bash
nocoproject daemon start --foreground      # log to stderr, Ctrl-C to stop
nocoproject daemon start                   # background; log in ~/.nocoproject/logs/daemon.log
nocoproject daemon status [--json]
nocoproject daemon logs [-n 100] [-f]
nocoproject daemon stop
```

Options for `start`: `--providers claude,opencode,codex,echo` (the default is `claude,opencode,codex`; tools that are not installed are skipped) and `--max-concurrent <n>` (the default is 20).

What it does:

1. Registers with `POST /np/daemon/register` and sends a heartbeat every 15 s.
2. Subscribes to `np:daemon` over `<serverUrl>/ws`, authenticated with the `x-api-key` header. It reconnects with exponential backoff and jitter and pings every 30 s. It also polls for work every `pollIntervalMs` (15 s from the server).
3. Claims runs in batches for all runtimes, within a shared slot limit. It renews each lease every 15 s until the run starts.
4. For each run, creates `~/.nocoproject/workspaces/<issueKey>-<runKey>/{workdir,logs}`. It reuses the previous `workDir` and resumes the provider session when the server hands them back and `fresh` is false.
5. Writes `<workDir>/.nocoproject/context.json` (mode 0600, never contains the run token or the agent's env vars) from the Phase 1 claim extras: project and repositories, parent issue, stage, `autoExecuteSubtasks`, delegation targets, the previous session's `branchName` / `repoUrl`, (iteration 2) `issue.executionMode` (`task` when missing) and `issue.pullRequests` (`[{ number, url, state }]`), (iteration 3) `knowledge` (`[{ id, slug, title, summary, projectId }]`, `[]` when missing; the index only, never document content), and (iteration 4) `issue.process` (`direct` when missing), `issue.designApprovedAt` (`null` when missing) and `agent.kind` (`coder` when missing). The design proposal and the reasoning effort are not written there.
6. Rebuilds the agent's skills from `agent.skills` (see [Skills](#skills)) and writes the runtime brief as a marker block in `CLAUDE.md` (claude) or `AGENTS.md` (opencode, codex, echo). Content outside the markers is left untouched.
7. Launches the tool with the per-turn prompt and streams events in batches (every 500 ms, and immediately on the first visible event). Events are redacted and truncated to 64 KB, with increasing `seq` numbers.
8. Checks for cancellation every 5 s and also reacts to WebSocket `cancelRequested`, killing the whole process tree. An idle watchdog kills an agent that produces no output for 2 h.
9. Reports `complete` (with session id, summary and usage), `fail` (with a classified `FailureReason`) or `cancel-ack`. When the agent checked out a repository, `complete` and `fail` also carry `branchName` and `repoUrl` from `<workDir>/.nocoproject/checkout.json`.
10. On SIGINT or SIGTERM, kills running agents and reports them as `runtimeRecovery`, which the server retries. It then deregisters.

A `426 PROTOCOL_MISMATCH` stops claiming and logs a loud upgrade message.

### Environment variables

| Variable | Meaning |
|---|---|
| `NOCOPROJECT_HOME` | State directory (default `~/.nocoproject`) |
| `NOCOPROJECT_SERVER_URL` / `NOCOPROJECT_API_KEY` | Override the saved server URL and API key |
| `NOCOPROJECT_DAEMON_ID` / `NOCOPROJECT_DEVICE_NAME` | Override the daemon identity |
| `NOCOPROJECT_PROVIDERS` | Providers to register, e.g. `opencode,echo` |
| `NOCOPROJECT_MAX_CONCURRENT` | Concurrent run limit (default 20) |
| `NOCOPROJECT_POLL_INTERVAL` | Override the claim poll interval (`15s`, `1m`, ...) |
| `NOCOPROJECT_AGENT_IDLE_WATCHDOG` | Kill an agent after this long without output (default `2h`, `0` disables) |
| `NOCOPROJECT_WORKSPACES_ROOT` | Workspace root (default `$NOCOPROJECT_HOME/workspaces`) |
| `NOCOPROJECT_CLAUDE_PATH` / `NOCOPROJECT_OPENCODE_PATH` / `NOCOPROJECT_CODEX_PATH` | Tool executables (default: looked up on `PATH`, plus `~/.opencode/bin`, `/opt/homebrew/bin`) |
| `NOCOPROJECT_LOG_LEVEL` | `debug`, `info`, `warn` or `error` |

The API key and run tokens are never written to logs: every log line and every event goes through redaction. Agents never receive `NOCOPROJECT_API_KEY`.

### Agent environment variables (iteration 2 §G)

The claim payload's `agent.env` (`Record<string, string>`, decrypted by the server) is injected into the tool process:

- Names starting with `NOCOPROJECT_`, `PATH`, `HOME`, `SHELL` and names that are not `^[A-Z_][A-Z0-9_]*$` are skipped; the run's event stream gets a status line naming the skipped variables (never their values). The run variables (`NOCOPROJECT_TOKEN`, ...) always win.
- Every value of 6 characters or more joins the redaction table for the lifetime of the run (reference-counted, so concurrent runs of the same agent stay masked): it is replaced with `[REDACTED]` in run events, the completion summary, failure details, daemon logs, the agent's stdout/stderr log files and the brief file. Shorter values are not masked, so a value like `1` does not blank out every digit.
- `context.json` never contains the env, and nothing writes it to disk.

### Skills (iteration 2 §H)

Every run rebuilds `<workDir>/.nocoproject/skills/<slug>/` from the claim payload's `agent.skills` (`[{ id, slug, name, description, content, files: [{ path, content }] }]`): `SKILL.md` is `content` (with `name` / `description` YAML front matter added when the content has none) and each file is written at its relative path. The whole directory is removed first, so skills that were detached, and stale files, disappear. Slugs must be `^[a-z0-9][a-z0-9._-]*$`; file paths that are absolute or contain a `..` segment are rejected (a status line in the event stream says which), the rest of the skill is still written. A file named `SKILL.md` is ignored in favour of `content`.

The Claude Code adapter additionally copies each skill to `<workDir>/.claude/skills/<slug>/`, where Claude Code discovers skills natively. Only directories the daemon wrote there (listed in `.nocoproject/native-skills.json`) are ever removed, so other skills in `.claude/skills/` are left alone.

## Run-token mode (agent commands)

The daemon injects `NOCOPROJECT_SERVER_URL`, `NOCOPROJECT_TOKEN` (`npr_...`), `NOCOPROJECT_RUN_ID`, `NOCOPROJECT_AGENT_ID`, `NOCOPROJECT_ISSUE_ID`, `NOCOPROJECT_ISSUE_KEY`, `NOCOPROJECT_WORKDIR` (the run's workDir) and `NOCOPROJECT_HOME` (the daemon's state directory, so the agent's `repo checkout` shares the daemon's repository cache) into the agent process. When the token and URL are present, `issue` commands call the agent API (`/api/np/agent/*`) with `Authorization: Bearer <token>`:

```bash
nocoproject issue get NP-12 --json
nocoproject issue comment list NP-12 [--thread <rootId>] [--tail 20] [--since <iso>] [--roots-only] --json
nocoproject issue comment add NP-12 --content-file ./reply.md [--parent <rootId>] [--json]
nocoproject issue status in_progress                 # the run's own issue
nocoproject issue status NP-12 in_review

# Phase 1: sub-issues, dependencies, project, repositories
nocoproject issue create --title T [--description-file F | --description D] [--parent NP-12] [--stage N] \
  [--blocked-by NP-3,NP-4] [--executor self|none|<agentId>] [--priority p] [--label a,b] --json
nocoproject issue children [NP-12] --json          # stage, statusKey, executorName, blockedCount
nocoproject issue dependency add [NP-12] --blocked-by NP-3[,NP-4] --json
nocoproject issue dependency remove [NP-12] --blocked-by NP-3 --json
nocoproject project get --json                      # project + resources from context.json
nocoproject repo checkout <url> [--ref <ref>] [--fresh] [--json]

# Iteration 2: pull requests
nocoproject pr link <url> [--issue NP-12] [--json]  # POST /np/agent/issues/:id/pull-requests { url }
nocoproject pr list [--issue NP-12] [--json]        # GET  /np/agent/issues/:id/pull-requests

# Iteration 3: knowledge base
nocoproject kb list [--json]                        # GET  /np/agent/knowledge
nocoproject kb get <slug|id> [--json]               # GET  /np/agent/knowledge/:idOrSlug (content to stdout)
nocoproject kb propose (--doc <slug|id> | --title T [--slug s]) --content-file F --reason R [--summary S] [--json]
                                                    # POST /np/agent/knowledge/proposals

# Iteration 4: design first, project manager
nocoproject issue design-proposal [NP-12] --content-file F [--json]
                                                    # POST /np/agent/issues/:id/design-proposal { content }
nocoproject pm projects [--json]                    # GET  /np/agent/pm/projects
nocoproject pm issues [--project <id>] [--status <key>] [--owner me|<userId>] [--executor <agentId>] \
  [--q <text>] [--since 7d] [--limit n] [--cursor c] [--json]
                                                    # GET  /np/agent/pm/issues → { data, nextCursor }
nocoproject pm issue <id|NP-12> [--json]            # GET  /np/agent/pm/issues/:idOrIdentifier
nocoproject pm inbox [--kind decision] [--json]     # GET  /np/agent/pm/inbox?kind=decision
nocoproject pm metrics [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--project <id>] [--json]
                                                    # GET  /np/agent/pm/metrics
nocoproject pm knowledge [--project <id>] [--q <text>] [--json]
                                                    # GET  /np/agent/pm/knowledge

# Phase 2 (NP-77): stage checklists, workflow template proposals
nocoproject issue checklist [NP-12] [check|uncheck <itemKey|statusKey/itemKey>] [--status <key>] [--json]
                                                    # GET / PATCH /np/agent/issues/:id/checklists[/:statusKey/items/:itemKey]
nocoproject workflow list [--json]                  # GET  /np/agent/workflows
nocoproject workflow get [<template>] [--definition] [--json]
                                                    # GET  /np/agent/workflows/:id
nocoproject workflow propose (<template> | --copy-from <template> --name N) --definition-file F --reason R [--json]
                                                    # POST /np/agent/workflows/proposals
```

- Issue arguments can be identifiers (`NP-12`) or raw ids. An identifier is resolved through `NOCOPROJECT_ISSUE_KEY`/`NOCOPROJECT_ISSUE_ID` or `GET /np/agent/context`. Any other value is passed through as a raw id. With no argument, the run's own issue is used.
- `comment add` requires exactly one of `--content-file` or `--content`; `issue create` takes at most one of `--description-file` or `--description`.
- In request bodies (`--parent`, `--blocked-by`) identifiers are resolved to ids: the run's issue and its parent locally, others with `GET /np/agent/issues/<identifier>` (unknown → exit 4). `--executor` also accepts the name of one of the agent's delegation targets. Only flags that are given are sent; the server defaults `parentIssueId` to the run's issue and `executor` to `none`.
- `issue dependency remove` calls `DELETE /np/agent/issues/:id/dependencies?dependsOnIssueId=<id>&type=blockedBy` (the agent knows the blocking issue, not the dependency row id). `add` posts `{ dependsOnIssueId, type: 'blockedBy' }`.
- `issue status` handles approval gates (iteration 2 §D): when the server answers **202** `{ data: { issue, pendingApproval } }`, the status is unchanged and a pending approval request was created. The command prints `approval pending (request <id>)` (with `--json`: the `{ issue, pendingApproval }` object) and exits 0.
- `pr link <url>` checks that the URL is an absolute http(s) URL (otherwise exit 5 `INVALID_PR_URL`) and lets the server parse it (`400 INVALID_PR_URL` → exit 5). Text output: `linked <repo>#<number> (<state>) to <issue>`. `pr list` prints `<repo>#<number> (<state>[, CI <ciState>])  <title>` and the URL per pull request. `--issue` defaults to the run's issue.
- `kb list` shows the run's project documents plus system-level ones (`{ data: KnowledgeDocSummary[] }`, no content). Text output: `<slug>  <title>  (project|system, v<version>)` and the summary on the next line.
- `kb get <slug|id>` prints the document's Markdown content as-is on stdout (a trailing newline is added when missing); `--json` prints the whole `doc` from `{ data: { doc } }`. Unknown or invisible documents exit 4.
- `kb propose` never edits a document: it creates a pending proposal for the project lead (owner/admin for system documents). Exactly one of `--doc` (update; the slug or id is resolved to `docId` with `GET /np/agent/knowledge/:idOrSlug`) or `--title` (new document, optional `--slug` matching the server's `KNOWLEDGE_SLUG_PATTERN`, `^[a-z0-9][a-z0-9-]{0,63}$`). `--content-file` holds the whole proposed content (not a diff) and must not be empty; `--reason` is required (≤ 500 characters), `--summary` optional (≤ 300). These are checked locally (exit 5) before anything is sent. The body is `{ docId? | title, slug?, summary?, content, reason }`; `projectId` is left to the server (the run's project). A second pending proposal for the same document from the same run is `409 KNOWLEDGE_PROPOSAL_PENDING` → exit 5. Text output: `proposed <an update to <slug> | new document "<title>"> (proposal <id>, pending); ...`.
- `issue design-proposal` (iteration 4 §B) posts the whole proposal from `--content-file` (required, not empty; exit 5 otherwise) and prints the returned `kind='proposal'` comment (`{ data: comment }`; with `--json` the comment object). It does not change the status: the agent then runs `issue status <issue> proposal_review`. While a design-first issue is unapproved, the server refuses `in_progress` from an agent with `403 DESIGN_NOT_APPROVED` → exit 5.
- `pm ...` (iteration 4 §C) only works for agents of kind `manager`; otherwise the server answers `403 MANAGER_ONLY` and the CLI exits 3 with "pm commands are only available to project-manager agents". Everything is filtered by what the run's asker (`actorUserId`) can see. `pm issues` sends only the flags that are given: `--project` → `projectId`, `--status` → `statusKey`, `--owner` → `ownerUserId` (`me` is passed as-is and means the asker), `--executor` → `executorId`, `--q`, `--since` → `updatedSince` (`30m`, `12h`, `7d`, `2w` relative to now, or an ISO date; anything else exits 5), `--limit` (≤ 100), `--cursor`. `--json` prints `{ data, nextCursor }`; text output prints one line per issue and `more: --cursor <c>` when there is another page. `pm issue` prints `{ issue, comments, activities, runs, pullRequests, subtasks }` with `--json`, a short summary otherwise. `pm metrics` checks `--from` / `--to` are `YYYY-MM-DD`.
- `issue checklist` lists the issue's stage checklists (current status first; `[x]` / `[ ]` per item, `(required)`); `check` / `uncheck` take `<itemKey>` of the current status's checklist (or `--status`) or `<statusKey>/<itemKey>` and print `checked <statusKey>/<itemKey> (<n>/<m> required items checked)`. The issue may be left out before `check` / `uncheck`. Writes only work on the run's own issue (`403 ISSUE_NOT_IN_RUN`).
- `workflow list` prints `<id>  <name>  (rev <n>[, system: copy only][, default], <k> projects)` and marks the template of the run's project (`usedByRunProject`). `workflow get` defaults to that template; `--definition` prints only the definition JSON, the file to edit. `workflow propose` never changes a template: exactly one of `<template>` (edit; system templates answer `409 WORKFLOW_SYSTEM_TEMPLATE`) or `--copy-from` (a new template, `--name` required, ≤ 100 characters); `--reason` required (≤ 500); `--definition-file` must be a JSON object (a whole template from `workflow get --json` is unwrapped to its `definition`). These are checked locally (exit 5). The server validates at once: `400 INVALID_WORKFLOW` and `409 WORKFLOW_STATUS_CONFLICT` carry `details`, which the CLI prints one line per problem (and passes through in `--json`); `409 WORKFLOW_PROPOSAL_PENDING` when this run already proposed for the template. Text output: `proposed <a change to <name> (base revision n) | a new template "<name>" copied from <source>> (proposal <id>, pending); ...` and one line per kind of change.
- `issue comment list` marks resolved threads with `[resolved]` when the server sends `resolved: true`.
- `project get` reads `context.json` and falls back to `GET /np/agent/context` (`project`) outside a daemon workDir.
- Every command accepts `--json`. Errors are printed as `{"error":{"code","message","exitCode"}}` (plus `details` when the server sent them).
- Exit codes: `0` ok, `1` other (including git failures), `2` network, `3` auth (missing or invalid token, 401/403, `MANAGER_ONLY`), `4` not found, `5` validation (bad input, 400/409/422, `TRANSITION_NOT_ALLOWED`, `DESIGN_NOT_APPROVED`, `REPO_NOT_ALLOWED`, `CONTEXT_MISSING`).

## User mode (`nocoproject user`, NP-86)

For a person at their own terminal, and for the Claude Code / Codex sessions they drive there. The commands call the
browser API (`/api/np/*`) with the API key saved by `nocoproject login` (or `NOCOPROJECT_API_KEY`), so they act **as
that person**, with exactly the permissions they have in the UI; the server adds none. There is no `--api-key` flag:
change the key with `login --api-key-stdin`.

```bash
nocoproject user whoami [--json]                    # GET /np/me (+ serverUrl; never the key)
nocoproject user issues [--mine] [--owner me|<userId>] [--project <name|id>] [--status <key>] [--label <name|id>] \
  [--executor <agent name|id>] [--q <text>] [--limit n] [--cursor c] [--json]
                                                    # GET /np/issues → { data, nextCursor }; no filter = --mine
nocoproject user issue <NP-12> [--comments <n>|all] [--json]
                                                    # GET /np/issues/:id (+ older /comments pages for `all`)
nocoproject user inbox [--kind decision|info] [--all] [--cursor c] [--json]
                                                    # GET /np/inbox (resolved=false unless --all)
nocoproject user create --title T [--description-file F | --description D] [--project <name|id>] [--label a,b] \
  [--executor <agent name|id>|none] [--owner me|<userId>] [--priority p] [--status key] [--parent NP-1] \
  [--blocked-by NP-2,NP-3] [--json]                 # POST /np/issues (owner defaults to you on the server)
nocoproject user comment <NP-12> (--content-file F | --content T) [--parent <commentId>] [--json]
                                                    # POST /np/issues/:id/comments
nocoproject user status <NP-12> <statusKey> [--json]
                                                    # GET revision → PATCH /np/issues/:id { statusKey, revision }
nocoproject user projects | labels | agents [--json]
                                                    # names and ids for --project / --label / --executor
nocoproject user skill install [--claude] [--codex] [--force] [--json]
```

- **Refused inside agent runs.** When `NOCOPROJECT_TOKEN` or `NOCOPROJECT_RUN_ID` is set (the daemon sets both for
  every run), every `user` command exits 3 `USER_MODE_IN_RUN` before reading the config or sending anything; runs use
  the run-token commands above. This guards the normal path only: an agent runs as the same OS user and could read
  `~/.nocoproject/config.json` itself. Real isolation needs a separate OS user for the daemon or scoped keys.
- **Traceable.** Requests send `x-api-key` and `x-np-client: nocoproject-cli/<version>` (never `Authorization`). The
  server records the key owner as the actor and `details.via = 'cli'` on the activities the write produces (another
  API-key client gets `'api_key'`); the issue timeline shows "via CLI". `via` is a label, never a permission.
- **Handing work to an agent** (`create --executor <agent>`) is the person's own action, not "an agent triggering an
  agent": it has their permissions, the run's asker is them, and the activity shows it came from the CLI. Agents
  dispatched by NocoProject cannot take this path (see the refusal above), so delegation lists and approvals still hold
  for them.
- Names (`--project`, `--label`, `--executor`) match an id first, then a case-insensitive name; no match exits 4
  `NAME_NOT_FOUND`, several exit 5 `AMBIGUOUS_NAME` — nothing is guessed. `--owner me` / the default "mine" use
  `GET /np/me`. Labels are workspace-wide.
- `status` retries once on `409 REVISION_CONFLICT`; `202` (approval gate) prints `approval pending (request <id>)` and
  exits 0, like `issue status`.
- `issue --comments <n>` (default 50) keeps the latest n of the detail's comments and adds `commentsOmitted` in JSON;
  `all` pages through the older ones.
- The key is registered for redaction as soon as it is read, so it never appears in output or errors.
- `skill install` writes the bundled `nocoproject-user` skill (`skills/nocoproject-user/SKILL.md`, bundled into
  `dist/cli.js` as text) to `~/.claude/skills/nocoproject-user/` and `~/.codex/skills/nocoproject-user/` (both unless
  a flag picks one). An identical copy is left alone; a changed one needs `--force`. Re-run it after upgrading the CLI.
- Exit codes and `--json` errors are the same as in run-token mode; `3` also covers `NOT_LOGGED_IN`.

## Repository checkout

`nocoproject repo checkout <url>` runs in the agent process, not through the daemon:

- The URL must be one of the project's `gitRepo` resources in `$NOCOPROJECT_WORKDIR/.nocoproject/context.json` (compared case-insensitively, ignoring a trailing `/` or `.git`); otherwise exit 5 `REPO_NOT_ALLOWED`. The resource's own URL is what gets cloned.
- Bare cache: `$NOCOPROJECT_HOME/repos/<sha1(normalized url)>.git` (`git clone --bare`, then `git fetch --prune` on later checkouts; a failed fetch falls back to the cached copy with a warning). The cache uses the remote-tracking refspec `+refs/heads/*:refs/remotes/origin/*`, so remote branches never collide with agent branches. A `mkdir` lock next to the cache serializes concurrent checkouts.
- Worktree: `$NOCOPROJECT_WORKDIR/<repoName>/` via `git worktree add`, on `agent/<agentSlug>/<issue identifier, lower case>`. Base: `--ref`, else the resource's `defaultRef`, else the remote default branch (`origin/HEAD`, then `main`/`master`).
- Resuming: the same workDir reuses its worktree; a new workDir checks out `session.branchName` when the server handed one back for the same repository (from the local branch, or from `origin/<branch>` if the cache was rebuilt). A branch held by an older, dormant worktree is detached there (its files stay). Then it tries `git merge --ff-only <base>`; if that fails it leaves the branch alone and prints a note.
- A same-named branch that the session does not own (a foreign branch) gets a short run-key suffix, e.g. `agent/coder/np-12-67890123`.
- `--fresh` removes this workDir's worktree and restarts the branch from the base (`worktree add -B`).
- Git identity: global config is never changed. If the worktree has no `user.name`/`user.email`, it sets `NocoProject Agent <agent@nocoproject.local>` with `git config --worktree` (enabling `extensions.worktreeConfig` on the cache and moving `core.bare` to the cache's `config.worktree`, as git requires).
- It writes `$NOCOPROJECT_WORKDIR/.nocoproject/checkout.json` = `{ url, ref, branchName, path }`, prints the path (or the same object with `--json`) and prints progress notes on stderr.
- Worktrees and caches are never deleted by the daemon in this iteration (no GC yet).

## Adapters

| Provider | Launch | Brief |
|---|---|---|
| `claude` | `claude -p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions [--model m] [--effort level] [--resume id]`, with the prompt sent on stdin as one stream-json user message. `control_request` frames are auto-approved, and stdin is closed after `result`. Skills are also copied to `.claude/skills/`. | `CLAUDE.md` |
| `codex` | `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C <workDir> [-m model] [-c model_reasoning_effort="<effort>"] <prompt>`; resume with `codex exec resume --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-m model] [-c ...] <sessionId> <prompt>`. stdin is closed at once. JSONL events: `thread.started` (session id), `item.*` (`agent_message` → text, `reasoning` → thinking, `command_execution` / `file_change` / `mcp_tool_call` / `web_search` → toolUse + toolResult, `todo_list` → status, `error` item → warning status), `turn.completed` (usage; cached tokens are reported as `cacheReadTokens` and subtracted from `inputTokens`), `turn.failed` / `error`. Codex writes MCP and login noise (even 401s) to stderr on successful runs, so stderr is only used when the JSON stream has no error. | `AGENTS.md` |
| `opencode` | `opencode run --format json --auto --thinking --print-logs --log-level WARN --dir <workDir> [--session id] [--model provider/model] [--variant <effort>] <prompt>` (with `PWD` reset to the workDir) | `AGENTS.md` |
| `echo` | `node dist/echo-agent.js <prompt>`: a scripted fake agent that runs the real `issue get` / `status` / `comment add` commands | `AGENTS.md` |

**Reasoning effort** (iteration 4 §C): the claim payload's `agent.reasoningEffort` (`minimal`, `low`, `medium`, `high`, `max`; anything else or `null` passes nothing) is mapped per tool: opencode `--variant <effort>`; codex `-c model_reasoning_effort="<effort>"` (new and resumed sessions); claude `--effort <level>` when `claude --help` lists `--effort` (probed once per daemon; Claude Code has no `minimal`, so it becomes `low`), otherwise ignored.

If the provider rejects `--resume` for an unknown session, the run is retried once with a fresh session inside the same run.

The echo agent accepts test directives in the issue title or description: `[echo:sleep=<ms>]` to exercise cancellation and the watchdog, `[echo:fail=<text>]` to exercise failure classification (for example `[echo:fail=API Error: 429]` is reported as `agentError.providerRateLimit`), `[echo:subtasks=<n>]` to create n sub-issues with `issue create --executor self --stage <i>` (the parent then stays `in_progress`), and `[echo:checkout=<url>]` to run `repo checkout <url>`, write a file in the worktree and commit it on the agent branch. Iteration 2 adds `[echo:pr=<url>]` (runs `pr link <url>`), `[echo:status=<key>]` (runs `issue status <issue> <key>` instead of the usual `in_review`; a 202 "approval pending" counts as success), `[echo:env=<NAME>]` (writes `NAME=<value>` into the reply and a text event, to check env injection and redaction) and `[echo:skill=<slug>]` (writes the first body line of `.nocoproject/skills/<slug>/SKILL.md`, after the front matter, into the reply). Iteration 3 adds `[echo:kb=<slug>]` (runs `kb get <slug>` and writes `KB <slug>: <first non-empty line>` into the reply) and `[echo:kb-propose=<title>]` (writes `kb.md` and runs `kb propose --title <title> --content-file kb.md --reason ... --json`). Iteration 4 adds `[echo:design]` (unless `context.json` has `issue.designApprovedAt`: moves `todo` → `analysis`, writes `proposal.md`, runs `issue design-proposal`, sets `proposal_review` and stops without a reply, `in_progress` or `in_review`; once approved it works normally) and `[echo:pm=<question>]` (runs `pm issues --json` and writes `PM <question>: <n> issues` into the reply). In session mode (`issue.executionMode` in `context.json`) the echo agent never sets `in_review`; for a manager agent (`agent.kind = 'manager'`) it never changes the status.

### Brief (Phase 1 additions)

Besides the Phase 0 sections the brief has `## Project Context` (project name and description, parent issue and stage), `## Repositories` (resources, the checkout command, the branch rule, the previous branch, PRs with `gh pr create` and the issue identifier in the title), `## Sub-issues` (when to split, `--stage` / `--blocked-by`, what `--executor self` does given the issue's `autoExecuteSubtasks`, other agents become proposals unless they are in the delegation list, never @-mention agents) and `## Parent coordination` (what to do when woken by `childBatchDone`). The per-turn prompt names the parent issue and opens `childBatchDone`, `dependencyReleased` and `proposalAccepted` turns with a matching sentence.

### Brief (iteration 2 additions)

- `## Available Commands` lists `pr link` and `pr list`.
- `## Repositories` tells the agent to push, open the PR with `gh pr create --title "<identifier>: <summary>"` and then run `nocoproject pr link <url>`, noting that the branch name already contains the identifier so the server links it automatically too. PRs already linked to the issue (`issue.pullRequests`) are listed, also when the project has no repositories.
- `## Skills` (only when skills are attached) lists each skill's name, description and `.nocoproject/skills/<slug>/SKILL.md` path and says to read `SKILL.md` when a task matches; for Claude Code it adds that the same skills are discovered under `.claude/skills/`.
- Session mode (`issue.executionMode = 'session'`): the brief opens with `## Conversation Mode` (live conversation with the owner, short replies, no per-turn summary report, working directory and session carry over, no `in_review` needed), the `## Workflow` becomes the conversational loop (read the quoted comment, reply briefly in the thread, leave the status alone), and the per-turn prompt opens with "You are in a live conversation with the owner on issue …" and closes with "Reply briefly via … you do not need to set `in_review`".
- Resolved comment threads are filtered by the server; the brief and prompt only quote the triggering comments.

### Brief (iteration 3 additions)

- `## Available Commands` lists `kb list`, `kb get` and `kb propose`.
- `## Knowledge` (after `## Skills`, always present) lists every document from the claim's `knowledge` index as `- **<title>** (`<slug>`[, system-wide]) — <summary>` and explains `nocoproject kb get <slug>`; with an empty index it says no documents are available yet and that `kb list --json` shows ones added later.
- `## Capture learnings` (after `## Parent coordination`, always present): before finishing, propose new conventions, pitfalls or decisions with `kb propose --doc <slug>` (whole new content, starting from `kb get`) or `kb propose --title`, give a reason, never edit documents directly (or write them into the repository instead), at most 3 proposals per run and only durable knowledge, one pending proposal per document per run.

### Brief (iteration 4 additions)

- **Design first** (`issue.process = 'design_first'` and `issue.designApprovedAt` null): `## Design first` comes right after the heading: set `analysis`, analyze (read only), write the proposal (需求理解 / 方案 / 影响范围 / 风险与待定 / 验证计划), submit it with `nocoproject issue design-proposal <key> --content-file ./proposal.md`, set `proposal_review` and end the turn; no code changes, commits, pushes, sub-issues or pull requests before approval, never `in_progress` (`DESIGN_NOT_APPROVED`); when sent back, revise the whole proposal per the comments and resubmit. `## Available Commands` lists `issue design-proposal`, `## Workflow` becomes the design loop, and the turn prompt closes with "Submit or revise the proposal with … then set `proposal_review` … No code changes or pull requests before approval." Once approved, `## Design first` only says to implement the approved proposal (and explain deviations).
- A run triggered by `designApproved` opens with "方案已批准，按方案实现" and quotes `issue.designProposal.content` ("The approved design proposal:"); without it, the prompt says where to read it.
- **Project manager** (`agent.kind = 'manager'`): `## Project manager` opens the brief (role: reads across projects, answers, retrospectives, knowledge suggestions; conclusion first; answer in the asker's language; cite identifiers; never change any status; never @-mention agents; `kb propose` for knowledge, at most 3). `## Available Commands` lists the `pm` commands instead of `issue status` and the sub-issue / repository / PR commands; `## Repositories`, `## Sub-issues`, `## Parent coordination` and `## Capture learnings` are left out; `## Workflow` is the answer loop and `## Status Rules` says the agent never changes a status. The turn prompt closes with "… you do not need to set `in_review` and never change the status."
- A `retrospective` run gets its own prompt: "任务 <key> 已完成，请做总结", then read `nocoproject pm issue <key> --json`, post exactly one comment whose first line is `/note` (what was done, time and usage, conventions or pitfalls, whether conventions need updating), propose durable knowledge with `kb propose`, and change nothing else.
- Coder briefs for `direct` issues (and claims from older servers) are unchanged.

### Brief (Phase 2 additions)

- `## Stage checklist` (NP-77 stage 1) lists the open items of the current status and, since stage 2, tells the agent to check each one with `nocoproject issue checklist <key> check <itemKey>`.
- `## Available Commands` (coding agents) lists `issue checklist`, `workflow list|get` and `workflow propose`.
- `## Changing a workflow template` (after `## Parent coordination`, coding agents only): templates change only when a person asks; read (`workflow list`, `workflow get <template> --definition > wf.json`), edit the whole definition (built-in statuses stay, new statuses need a key, a fixed category and a human exit), propose (system templates only by `--copy-from`), fix what `INVALID_WORKFLOW` / `WORKFLOW_STATUS_CONFLICT` report, call out `runExecutor` actions with an `agentId`, and propose again when a proposal becomes stale.

## Development

```bash
pnpm typecheck
pnpm test                 # builds dist/ first (vitest global setup), then runs all suites
NOCOPROJECT_LIVE_OPENCODE=1 pnpm vitest run tests/opencode.live.test.ts   # real OpenCode run (costs tokens)
NOCOPROJECT_LIVE_CODEX=1 pnpm vitest run tests/codex.live.test.ts         # real Codex run (costs tokens)
NOCOPROJECT_LIVE_CLAUDE=1 pnpm vitest run tests/claude.live.test.ts       # real Claude Code run (costs tokens; skipped with a message when `claude` is not installed)
pnpm vitest run --exclude "**/*.live.test.ts"                             # everything except the live tests
npm pack --dry-run
```

The tests use an in-process mock server (`tests/helpers/mock-server.ts`) that implements the daemon API, the agent API (including the Phase 1 endpoints and claim extras, the iteration-2 pull-request endpoints, `agent.env` / `agent.skills` / `issue.executionMode` / `issue.pullRequests` in the claim payload via `enqueue` options, and a 202 approval gate for issues created with `approvalRequired: true | string[]`, the iteration-3 knowledge endpoints in `tests/helpers/mock-knowledge.ts` with `knowledge` in the claim payload via `enqueue({ knowledge })`, and the iteration-4 `design-proposal` and `pm/*` endpoints in `tests/helpers/mock-pm.ts` (`mock.pm.managerOnly`, on by default, answers 403 `MANAGER_ONLY` unless `agentExtras.kind` is `manager`; `agentExtras.reasoningEffort`; `process` / `designApprovedAt` / `designProposal` on `addIssue` or `issueExtras`; the `analysis` / `proposal_review` transitions and the `DESIGN_NOT_APPROVED` gate) and the realtime socket. Repository checkout is tested against local bare repositories in temp directories (no network). The Codex fixtures in `tests/fixtures/codex/` are real `codex-cli 0.154.0` captures.


### Comments received during a run (NP-114)

On a server with migration `2026100700001_np_run_input`, this CLI opts resumable runs into `acceptsInput` when starting. New human comments addressed to that run are retained server-side, then processed at the current provider turn's end using the same run id, token, checkout and provider session. No additional queued run is created. Current exec adapters do not interrupt an in-flight tool or inject messages mid-turn; if the provider refuses a session resume, the existing fresh-session fallback applies.

The status response adds `inputs` (comment id, author, content and thread root). Completion sends `handledInputIds`; `409 RUN_INPUT_PENDING` means another comment arrived and the daemon must continue before completing. Usage is aggregated across turns. Explicit mentions/replies retain their recipient, and `/note` or agent-authored comments never trigger a run. Implicit delivery requires a unique running agent with the same triggering human's authorization context. Old CLI runs and ambiguous targets retain queued routing; new CLI versions also work against servers that omit `inputs`.
