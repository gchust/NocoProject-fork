/** PM assistant commands. Authorization and operation policy remain server-owned. */
import type { Command } from "commander";
import { z } from "zod";
import type {
  PmOperation,
  PmPlan,
  PmActResult,
  PmRosterAgent,
} from "../protocol.phase2-pm-assistant.js";
import {
  PM_OPERATION_TYPES,
  PM_PLAN_REF_PATTERN,
  PM_PLAN_TITLE_MAX,
  PM_PLAN_SUMMARY_MAX,
  PM_PLAN_MAX_OPS,
  PM_TITLE_MAX,
} from "../protocol.phase2-pm-assistant.js";
import {
  action,
  type JsonOpt,
  runTokenContext,
  IDENTIFIER,
} from "./run-token.js";
import { issueRef, readJsonObject } from "./input.js";
import { CliError, EXIT, printJson, printLine } from "./output.js";

const refSchema = z.string().regex(PM_PLAN_REF_PATTERN);
const operationSchema = z
  .object({
    type: z.enum(PM_OPERATION_TYPES),
    params: z.record(z.string(), z.unknown()),
    ref: refSchema.optional(),
  })
  .strict();
const planSchema = z
  .object({
    title: z.string().trim().min(1).max(PM_PLAN_TITLE_MAX),
    summary: z.string().max(PM_PLAN_SUMMARY_MAX).optional(),
    ops: z.array(operationSchema).min(1).max(PM_PLAN_MAX_OPS),
  })
  .strict();
const statusSchema = z.enum([
  "pending",
  "executing",
  "executed",
  "failed",
  "discarded",
  "expired",
  "superseded",
]);
const limit = (v: string) =>
  z.coerce.number().int().positive().max(200).parse(v);
const segment = (v: string) =>
  encodeURIComponent(z.string().trim().min(1).parse(v));
const out = <T>(
  opts: JsonOpt,
  data: T,
  render: (d: T) => void = printJson,
): void => (opts.json ? printJson(data) : render(data));

/** Only validates transport shape; domain rules and per-operation fields are checked by the server. */
export function pmOperation(
  type: string,
  params: Record<string, unknown>,
  ref?: string,
): PmOperation {
  return operationSchema.parse({
    type,
    params,
    ...(ref === undefined ? {} : { ref }),
  }) as PmOperation;
}

export function pmPlanFile(opts: { file?: string; planFile?: string }) {
  if (opts.file !== undefined && opts.planFile !== undefined)
    throw new CliError(
      "pass either --file or --plan-file, not both",
      EXIT.validation,
      "CONFLICTING_OPTIONS",
    );
  const file = opts.file ?? opts.planFile;
  if (!file)
    throw new CliError(
      "--file or --plan-file is required",
      EXIT.validation,
      "FILE_REQUIRED",
    );
  return planSchema.parse(readJsonObject(file));
}

function printPlan(plan: PmPlan): void {
  printLine("Plan " + plan.id + " [" + plan.status + "] " + plan.title);
  printJson(plan);
}

export function registerPmAssistantCommands(pm: Command): void {
  pm.command("agents")
    .description("Executor roster visible to the asker")
    .option("--json", "JSON output")
    .action(
      action(async (opts: JsonOpt) => {
        const data = await runTokenContext().api.http.data<PmRosterAgent[]>(
          "GET",
          "/np/agent/pm/agents",
        );
        out(opts, data, (agents) => {
          if (!agents.length) return printLine("(no agents)");
          for (const a of agents) {
            printLine(
              a.id +
                "  " +
                a.name +
                "  " +
                a.provider +
                "/" +
                (a.model ?? "default"),
            );
            printLine(
              "  callable: " +
                a.canInvoke +
                "; runtime: " +
                (a.runtime
                  ? (a.runtime.online ? "online" : "offline") +
                    "/" +
                    a.runtime.compat
                  : "unavailable"),
            );
            printLine(
              "  running: " +
                a.load.running +
                "; queued: " +
                a.load.queued +
                "; capacity: " +
                a.load.maxConcurrentRuns,
            );
            printLine("  " + a.summary);
            printLine(
              "  capabilities: " +
                a.capabilities.join(", ") +
                "; skills: " +
                a.skills.map((s) => s.name).join(", "),
            );
          }
        });
      }),
    );

  for (const command of ["runs", "prs"] as const) {
    const cmd = pm
      .command(command + " <issue>")
      .description(
        command === "runs"
          ? "Runs of an issue visible to the asker"
          : "Pull requests, CI and mergeability of an issue",
      )
      .option("--json", "JSON output");
    if (command === "runs")
      cmd.option("--limit <n>", "maximum number of runs (1–200)", limit);
    cmd.action(
      action(async (ref: string, opts: JsonOpt & { limit?: number }) => {
        const { api } = runTokenContext();
        const normalized = issueRef(ref);
        const issueId = IDENTIFIER.test(normalized)
          ? (await api.pmIssue(normalized)).issue.id
          : normalized;
        const data = await api.http.data<unknown[]>(
          "GET",
          "/np/agent/pm/" + (command === "prs" ? "pull-requests" : "runs"),
          {
            query: {
              issueId,
              ...(opts.limit === undefined ? {} : { limit: opts.limit }),
            },
          },
        );
        // Some servers return the complete run list; still honor the CLI's display limit.
        out(
          opts,
          command === "runs" && opts.limit !== undefined
            ? data.slice(0, opts.limit)
            : data,
        );
      }),
    );
  }

  pm.command("run <id>")
    .description("Recent events of a run")
    .requiredOption("--events", "read run events")
    .option("--limit <n>", "maximum number of events (1–200)", limit)
    .option("--json", "JSON output")
    .action(
      action(async (id: string, opts: JsonOpt & { limit?: number }) => {
        out(
          opts,
          await runTokenContext().api.http.raw(
            "GET",
            "/np/agent/pm/runs/" + segment(id) + "/events",
            { query: { limit: opts.limit } },
          ),
        );
      }),
    );

  pm.command("do <opType>")
    .description("Act as the asker; the server may require a plan")
    .requiredOption(
      "--params-file <path>",
      "operation parameters as a JSON object",
    )
    .option("--ref <ref>", "local operation reference")
    .option("--json", "JSON output")
    .action(
      action(
        async (
          type: string,
          opts: JsonOpt & { paramsFile: string; ref?: string },
        ) => {
          const { api } = runTokenContext();
          const op = pmOperation(
            type,
            readJsonObject(opts.paramsFile),
            opts.ref,
          );
          out(
            opts,
            await api.http.data<PmActResult>("POST", "/np/agent/pm/act", {
              body: { op },
            }),
            (result) => {
              printLine(
                result.op +
                  ": " +
                  (result.object.identifier ?? result.object.id) +
                  (result.object.title ? " " + result.object.title : ""),
              );
              printLine(
                "Direct-write budget: " +
                  result.budget.used +
                  "/" +
                  result.budget.limit,
              );
            },
          );
        },
      ),
    );

  const plan = pm
    .command("plan")
    .description("Prepare and inspect plans; only the human executes them");
  plan
    .command("create")
    .description("Submit a plan for human review")
    .option("--file <path>", "plan JSON: title, summary, ops")
    .option("--plan-file <path>", "alias for --file")
    .option("--json", "JSON output")
    .action(
      action(async (opts: JsonOpt & { file?: string; planFile?: string }) => {
        const { api } = runTokenContext();
        out(
          opts,
          await api.http.data<PmPlan>("POST", "/np/agent/pm/plans", {
            body: pmPlanFile(opts),
          }),
          printPlan,
        );
      }),
    );
  plan
    .command("list")
    .description("Plans of this conversation")
    .option("--status <status>", "filter by plan status", (v) =>
      statusSchema.parse(v),
    )
    .option("--json", "JSON output")
    .action(
      action(async (opts: JsonOpt & { status?: string }) => {
        out(
          opts,
          await runTokenContext().api.http.data("GET", "/np/agent/pm/plans", {
            query: { status: opts.status },
          }),
        );
      }),
    );
  for (const command of ["get", "discard"] as const) {
    plan
      .command(command + " <id>")
      .description(
        command === "get" ? "Read a plan" : "Discard a pending or failed plan",
      )
      .option("--json", "JSON output")
      .action(
        action(async (id: string, opts: JsonOpt) => {
          const path =
            "/np/agent/pm/plans/" +
            segment(id) +
            (command === "discard" ? "/discard" : "");
          out(
            opts,
            await runTokenContext().api.http.data<PmPlan>(
              command === "discard" ? "POST" : "GET",
              path,
            ),
            printPlan,
          );
        }),
      );
  }
  pm.command("conversation")
    .description("This conversation")
    .command("title <title>")
    .description("Set the title unless the human has edited it")
    .option("--json", "JSON output")
    .action(
      action(async (title: string, opts: JsonOpt) => {
        const clean = z
          .string()
          .trim()
          .min(1)
          .refine(
            (s) => Array.from(s).length <= PM_TITLE_MAX,
            "title must be at most 40 characters",
          )
          .parse(title);
        out(
          opts,
          await runTokenContext().api.http.data(
            "POST",
            "/np/agent/pm/conversation/title",
            { body: { title: clean } },
          ),
        );
      }),
    );
}
