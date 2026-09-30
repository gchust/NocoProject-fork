---
name: nocoproject-user
description: Read and write NocoProject issues as the person at this terminal — list my issues, show an issue with its comments, check the inbox, create an issue (optionally for a NocoProject agent), comment, change status — with the `nocoproject user` commands. Use when the user asks about their NocoProject tasks or wants to file, update or hand off one. Not for runs dispatched by NocoProject (those use `nocoproject issue …`).
---

# NocoProject as yourself (`nocoproject user`)

`nocoproject user …` calls NocoProject with the API key the user saved with `nocoproject login`. Everything you do is
done **as that person**: the same permissions as in the web UI, recorded under their name, and marked "via CLI" in
the issue's activity.

## Before anything else

1. `nocoproject user whoami --json` — confirms who you act as and which server. If it answers `NOT_LOGGED_IN`
   (no personal API key: a computer credential alone is not enough), ask the user to run the
   `nocoproject login --server <url> --api-key-stdin` command from the message themselves. Never ask for, print or
   store the key.
2. If it answers `USER_MODE_IN_RUN`, you are inside a run NocoProject dispatched: stop and use `nocoproject issue …`
   (the run's own commands) instead. Do not look for the key in `~/.nocoproject/config.json` or the system keychain to get around this.

## Commands (always add `--json` and parse the output)

| Task | Command |
| --- | --- |
| My issues (I am the owner) | `nocoproject user issues --json` |
| Filter | `--project <name\|id> --status <key> --label <name> --executor <agent> --q <text>`; page with `--cursor <nextCursor>` |
| One issue with comments | `nocoproject user issue NP-12 --json` (`--comments all` for the whole history) |
| Inbox (unresolved) | `nocoproject user inbox --json` (`--kind decision`, `--all`) |
| Names and ids | `nocoproject user projects --json`, `nocoproject user labels --json`, `nocoproject user agents --json` |
| Create | `nocoproject user create --title "…" --description-file ./desc.md [--project …] [--label a,b] [--executor <agent>] [--priority high] [--process direct\|design_first] --json` |
| Comment | `nocoproject user comment NP-12 --content-file ./reply.md [--parent <commentId>] --json` |
| Status | `nocoproject user status NP-12 in_progress --json` |

- Look names up first (`projects`, `agents`, `labels`); a name that matches nothing or several things is an error, and
  the CLI never guesses — pass the id then.
- Write descriptions and comments to a file and pass `--description-file` / `--content-file`.
- The owner defaults to the user. Do not change owners, and do not set `done` / `cancelled` unless the user explicitly
  asks for that exact change.
- A status change behind an approval gate answers `pendingApproval` with exit 0: tell the user it waits for approval.
- Exit codes: 2 network, 3 not allowed / not logged in / inside a run, 4 not found, 5 invalid input.

## Handing work to a NocoProject agent

`create --executor <agent>` (or assigning later in the UI) starts that agent's run. This is the user's own action, not
"an agent triggering an agent": it runs with the user's permissions and the activity shows it came from the CLI. So only
do it when the user asked for it, and say which agent you assigned.

## Choosing the process (`--process`)

Set it when you create the issue; changing it afterwards may come too late, because the agent's first run can already
have started with the other process.

- `--process direct`: a small change with clear bounds that can be done right away (a bug fix, a flag, a doc update).
  The agent implements it straight away.
- `--process design_first`: the approach still needs to be agreed (several modules, open product questions, a risky
  migration). The agent writes a design proposal and waits for the owner's approval before implementing.
- `--process auto`: the server's classifier decides, and it often picks `design_first`. No flag: the workspace default
  applies (the classifier when that default is `auto`). So pass `direct` or `design_first` whenever the user's intent
  is clear.
