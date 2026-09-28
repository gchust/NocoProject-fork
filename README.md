# NocoProject

NocoProject is a project management application built on NocoBase 3 for collaboration between people and agents.

The repository contains two main packages:

- [`nocoproject/`](./nocoproject/): The NocoBase 3 application, including the web UI, server, database migrations, and application tests.
- [`nocoproject-cli/`](./nocoproject-cli/): The local daemon and CLI. It claims project runs, launches coding agents, and provides commands such as `nocoproject issue`.

## Development setup

Requires Node.js 24 or later (the CLI itself requires Node.js 22 or later) and pnpm 11.

### NocoBase application

```bash
cd nocoproject
pnpm install
pnpm nocobase config init   # Generate config.yml on first run
pnpm nocobase config check
```

Run tests, check types, and start the development servers:

```bash
pnpm test
pnpm typecheck
pnpm dev                   # Start the API and Vite development servers
```

Build and start the production server:

```bash
pnpm build
pnpm start
```

### Daemon and CLI

```bash
cd nocoproject-cli
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

After building, log in to the application and start the daemon in the foreground:

```bash
node dist/cli.js login --server http://127.0.0.1:13000/main --api-key <NocoBase API key>
node dist/cli.js daemon start --foreground
```

You can also use `npm link` to add the built `nocoproject` command to your `PATH`. The daemon claims tasks using the Claude Code, OpenCode, or Codex runtimes installed on your machine. See the [CLI README](./nocoproject-cli/README.md) for the full command reference.

## Documentation

Chinese project documents are maintained in [NocoSolution/NocoProject](https://github.com/nocobase/NocoSolution/tree/main/NocoProject), available locally under `nocosolution/NocoProject/` after initializing the submodule:

```bash
git submodule update --init --recursive
```

- **Architecture decisions**: [`adr/`](https://github.com/nocobase/NocoSolution/tree/main/NocoProject/docs/adr/), covering TypeScript and package layout, the PostgreSQL dispatch protocol, temporary implementation boundaries, and trigger constraints.
- **Phase 0**: [`phase0/plan.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase0/plan.md), [`phase0/protocol.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase0/protocol.md), [`phase0/server-notes.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase0/server-notes.md), [`phase0/conclusion.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase0/conclusion.md).
- **Phase 1 overview and workspace**: [`phase1/plan.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/plan.md), [`phase1/workspace.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/workspace.md).
- **Phase 1 iteration documents**: [`phase1/iteration-1-contract.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/iteration-1-contract.md), [`phase1/iteration-1-integration.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/iteration-1-integration.md), [`phase1/iteration-2-contract.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/iteration-2-contract.md), [`phase1/iteration-2-integration.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/iteration-2-integration.md), [`phase1/iteration-3-contract.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/iteration-3-contract.md), [`phase1/iteration-3-integration.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/iteration-3-integration.md).
- **Protocols and server notes**: [`phase1/protocol-iteration-1.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/protocol-iteration-1.md), [`phase1/protocol-iteration-2.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/protocol-iteration-2.md), [`phase1/protocol-iteration-3.md`](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/docs/phase1/protocol-iteration-3.md) and the corresponding `server-notes*.md` files.

- **Product and technical plan**: [Product and technical plan](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/NocoProject%20产品与技术方案.md).
- **Research**: [Multica research](https://github.com/nocobase/NocoSolution/blob/main/NocoProject/Multica_调研/Multica%20调研.md).

## Contributing

Write all new Git commit messages in English.
