/**
 * Plumbing for the CLI user mode (NP-86): the in-run refusal, the API key from `nocoproject login`, and local
 * resolution of project, label and agent names to ids.
 *
 * The refusal runs before the config is read: a run the daemon dispatched always carries `NOCOPROJECT_TOKEN` and
 * `NOCOPROJECT_RUN_ID`, and such an agent must not borrow the person's key (it uses `nocoproject issue …`).
 */
import { UserApi } from '../api/user-client.js';
import { loadConfig } from '../config.js';
import { RUN_ENV } from '../protocol.js';
import type { AgentListItem, Label, ProjectListItem } from '../protocol.js';
import { registerSecret } from '../util/redact.js';
import { CliError, EXIT } from './output.js';

export const USER_MODE_IN_RUN = 'USER_MODE_IN_RUN';

/** Throws exit 3 `USER_MODE_IN_RUN` inside an agent run. */
export function refuseInsideRun(env: NodeJS.ProcessEnv = process.env): void {
  if (env[RUN_ENV.token] || env[RUN_ENV.runId]) {
    throw new CliError(
      `user commands act as you and are disabled inside an agent run (${RUN_ENV.token} is set); runs dispatched by NocoProject use \`nocoproject issue …\``,
      EXIT.auth,
      USER_MODE_IN_RUN,
    );
  }
}

export interface UserContext {
  readonly api: UserApi;
  readonly serverUrl: string;
}

/** Refuses inside a run, then reads the saved server URL and API key (never printed). */
export function userContext(env: NodeJS.ProcessEnv = process.env): UserContext {
  refuseInsideRun(env);
  const cfg = loadConfig(env);
  if (!cfg.serverUrl || !cfg.apiKey) {
    throw new CliError('not logged in: run `nocoproject login --server <url> --api-key-stdin` first', EXIT.auth, 'NOT_LOGGED_IN');
  }
  registerSecret(cfg.apiKey);
  return { api: new UserApi(cfg.serverUrl, cfg.apiKey), serverUrl: cfg.serverUrl };
}

interface Named {
  readonly id: string;
  readonly name: string;
}

/**
 * Picks the one item whose id equals `ref`, else whose name equals it (case-insensitive). No match or several
 * matches is an error listing the candidates; nothing is guessed.
 */
export function pickByName<T extends Named>(items: readonly T[], ref: string, what: string): T {
  const value = ref.trim();
  const byId = items.find((item) => item.id === value);
  if (byId) return byId;
  const matches = items.filter((item) => item.name.toLowerCase() === value.toLowerCase());
  if (matches.length === 1) return matches[0] as T;
  const hint = `run \`nocoproject user ${what}s\` to list them`;
  if (matches.length > 1) {
    throw new CliError(`${what} "${value}" is ambiguous (${matches.map((m) => m.id).join(', ')}); pass the id — ${hint}`, EXIT.validation, 'AMBIGUOUS_NAME');
  }
  throw new CliError(`no ${what} named "${value}"; ${hint}`, EXIT.notFound, 'NAME_NOT_FOUND');
}

/** Resolves names lazily, fetching each list at most once. */
export class NameResolver {
  private projectList?: Promise<ProjectListItem[]>;
  private labelList?: Promise<Label[]>;
  private agentList?: Promise<AgentListItem[]>;
  private meId?: Promise<string>;

  constructor(private readonly api: UserApi) {}

  async me(): Promise<string> {
    this.meId ??= this.api.me().then((me) => me.userId);
    return this.meId;
  }
  /** `me` → the signed-in user's id; anything else is taken as a user id. */
  async user(ref: string): Promise<string> {
    return ref.trim().toLowerCase() === 'me' ? this.me() : ref.trim();
  }
  async project(ref: string): Promise<string> {
    this.projectList ??= this.api.projects();
    return pickByName(await this.projectList, ref, 'project').id;
  }
  async label(ref: string): Promise<string> {
    this.labelList ??= this.api.labels();
    return pickByName(await this.labelList, ref, 'label').id;
  }
  async agent(ref: string): Promise<string> {
    this.agentList ??= this.api.agents();
    return pickByName(await this.agentList, ref, 'agent').id;
  }
}
