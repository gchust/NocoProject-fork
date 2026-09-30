import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI = join(__dirname, "..", "dist", "cli.js");
const token = "npr_pm_transport_fixture";
let dir: string;
let url: string;
let server: Server;
const calls: {
  method: string;
  path: string;
  body: unknown;
  auth?: string;
  apiKey?: string;
}[] = [];
let response: { status: number; body: unknown };
let disconnect = false;
const plan = {
  id: "plan1",
  title: "Prepare work",
  status: "pending",
  rows: [],
  revision: 1,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pm-assistant-"));
  server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls.push({
      method: req.method!,
      path: req.url!,
      body: text ? JSON.parse(text) : undefined,
      auth: req.headers.authorization,
      apiKey: req.headers["x-api-key"] as string | undefined,
    });
    if (disconnect) {
      res.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/np/agent/pm/issues/"))
      return res.end(JSON.stringify({ data: { issue: { id: "i12" } } }));
    res.statusCode = response.status;
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  disconnect = false;
  response = { status: 200, body: { data: plan } };
});

function run(
  args: string[],
  authenticated = true,
): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      NOCOPROJECT_HOME: dir,
      NOCOPROJECT_SERVER_URL: url,
      ...(authenticated ? { NOCOPROJECT_TOKEN: token } : {}),
    },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (data) => (out += data));
  child.stderr.on("data", (data) => (err += data));
  return new Promise((resolve) =>
    child.on("close", (code) => resolve({ code, out, err })),
  );
}
function file(name: string, data: unknown): string {
  writeFileSync(join(dir, name), JSON.stringify(data));
  return name;
}

describe("PM assistant transport", () => {
  it.each([
    ["issue.create", { title: "Task", process: "direct" }],
    ["issue.update", { issue: "NP-12", set: { title: "Updated" } }],
    ["issue.status", { issue: "NP-12", statusKey: "todo" }],
    ["dependency.add", { issue: "NP-12", blockedBy: "NP-13" }],
    ["dependency.remove", { issue: "NP-12", blockedBy: "NP-13" }],
    ["comment.create", { issue: "NP-12", content: "Update", parentId: "c1" }],
    ["decision.resolve", { inboxItemId: "n1", action: "accept" }],
    ["project.create", { name: "Project" }],
    [
      "knowledge.propose",
      { title: "Guide", content: "Read this.", reason: "Reusable" },
    ],
  ])("sends %s through the run-token act endpoint", async (type, params) => {
    response.body = {
      data: {
        op: type,
        object: { id: "i12", type: "issue" },
        budget: { used: 1, limit: 2 },
      },
    };
    const r = await run([
      "pm",
      "do",
      type,
      "--params-file",
      file("params.json", params),
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).budget).toEqual({ used: 1, limit: 2 });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/np/agent/pm/act",
        body: { op: { type, params } },
        auth: "Bearer " + token,
        apiKey: undefined,
      },
    ]);
  });

  it.each(["--file", "--plan-file"])(
    "submits plans using %s without executing them",
    async (flag) => {
      const payload = {
        title: "Prepare tasks",
        summary: "Review first",
        ops: [
          {
            ref: "first",
            type: "issue.create",
            params: { title: "First", process: "direct" },
          },
          {
            type: "issue.create",
            params: { title: "Second", blockedBy: [{ ref: "first" }] },
          },
        ],
      };
      const r = await run([
        "pm",
        "plan",
        "create",
        flag,
        file("plan.json", payload),
        "--json",
      ]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual(plan);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "POST",
        path: "/api/np/agent/pm/plans",
        body: payload,
      });
    },
  );

  it("reads, filters and discards plans without a browser request", async () => {
    expect((await run(["pm", "plan", "get", "plan1"])).out).toContain(
      "Plan plan1 [pending]",
    );
    await run(["pm", "plan", "list", "--status", "pending", "--json"]);
    response.body = { data: { ...plan, status: "discarded" } };
    expect((await run(["pm", "plan", "discard", "plan1"])).out).toContain(
      "[discarded]",
    );
    expect(calls.map((c) => c.method + " " + c.path)).toEqual([
      "GET /api/np/agent/pm/plans/plan1",
      "GET /api/np/agent/pm/plans?status=pending",
      "POST /api/np/agent/pm/plans/plan1/discard",
    ]);
    expect((await run(["pm", "plan", "execute", "plan1"])).code).not.toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("reads the roster, run events, runs and PRs", async () => {
    const roster = [
      {
        id: "a1",
        name: "Coder",
        provider: "codex",
        model: "model",
        summary: "Testing",
        capabilities: ["issue.execute"],
        skills: [{ name: "Tests", description: "Tests" }],
        canInvoke: true,
        runtime: { online: false, compat: "upgrade_required" },
        load: { running: 0, queued: 2, maxConcurrentRuns: 3 },
      },
    ];
    response.body = { data: roster };
    expect(JSON.parse((await run(["pm", "agents", "--json"])).out)).toEqual(
      roster,
    );
    const readable = (await run(["pm", "agents"])).out;
    expect(readable).toContain("offline/upgrade_required");
    expect(readable).toContain("queued: 2");
    response.body = { data: [] };
    expect((await run(["pm", "agents"])).out).toContain("(no agents)");
    await run(["pm", "runs", "np-12", "--limit", "3", "--json"]);
    await run(["pm", "prs", "i12", "--json"]);
    await run(["pm", "run", "run/1", "--events", "--limit", "200", "--json"]);
    expect(calls.map((c) => c.path)).toContain("/api/np/agent/pm/issues/NP-12");
    expect(calls.map((c) => c.path)).toContain(
      "/api/np/agent/pm/runs?issueId=i12&limit=3",
    );
    expect(calls.map((c) => c.path)).toContain(
      "/api/np/agent/pm/pull-requests?issueId=i12",
    );
    expect(calls.at(-1)?.path).toBe(
      "/api/np/agent/pm/runs/run%2F1/events?limit=200",
    );
  });

  it("renames the conversation and preserves title lock errors", async () => {
    const r = await run([
      "pm",
      "conversation",
      "title",
      " A new title ",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(calls[0]).toMatchObject({ body: { title: "A new title" } });
    response = {
      status: 409,
      body: { code: "TITLE_LOCKED", message: "The human edited the title" },
    };
    const locked = await run([
      "pm",
      "conversation",
      "title",
      "Other",
      "--json",
    ]);
    expect(locked.code).toBe(5);
    expect(JSON.parse(locked.out).error.code).toBe("TITLE_LOCKED");
  });

  it.each([
    ["PLAN_REQUIRED", 409],
    ["PLAN_INVALID", 400],
    ["NOT_CONVERSATION_RUN", 403],
  ] as const)(
    "preserves %s details and never retries",
    async (code, status) => {
      const details = {
        reason: "budget",
        budget: { used: 2, limit: 2 },
        rows: [{ seq: 2, ok: false, errorCode: "STALE_TARGET" }],
      };
      response = { status, body: { code, message: "Review needed", details } };
      const params = file("params.json", { title: "Task" });
      const r = await run([
        "pm",
        "do",
        "issue.create",
        "--params-file",
        params,
        "--json",
      ]);
      expect(r.code).toBe(3);
      expect(JSON.parse(r.out).error).toMatchObject({
        code,
        exitCode: 3,
        details,
      });
      expect(JSON.parse(r.err)).toEqual(details);
      expect(calls).toHaveLength(1);
      const text = await run([
        "pm",
        "do",
        "issue.create",
        "--params-file",
        params,
      ]);
      expect(text.err).toContain(JSON.stringify(details));
      expect(calls).toHaveLength(2);
    },
  );

  it.each([
    [403, "CAPABILITY_DENIED", 3],
    [404, "NOT_FOUND", 4],
    [409, "PLAN_EXPIRED", 5],
    [500, "INTERNAL_ERROR", 1],
  ])("preserves HTTP %s without replay", async (status, code, exit) => {
    response = { status: status as number, body: { code, message: "Refused" } };
    const r = await run(["pm", "plan", "discard", "plan1", "--json"]);
    expect(r.code).toBe(exit);
    expect(JSON.parse(r.out).error.code).toBe(code);
    expect(calls).toHaveLength(1);
    expect(r.out + r.err).not.toContain(token);
  });

  it("does not replay a write when its response is lost", async () => {
    disconnect = true;
    const r = await run([
      "pm",
      "do",
      "issue.create",
      "--params-file",
      file("uncertain.json", { title: "Possibly created", process: "direct" }),
      "--json",
    ]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.out).error.code).toBe("NETWORK_ERROR");
    expect(calls).toHaveLength(1);
    expect(r.out + r.err).not.toContain(token);
  });

  it("rejects malformed input before any request", async () => {
    writeFileSync(join(dir, "bad.json"), "{");
    for (const args of [
      ["pm", "do", "issue.create", "--params-file", "bad.json"],
      ["pm", "do", "issue.create", "--params-file", "missing.json"],
      ["pm", "do", "delete", "--params-file", file("valid.json", {})],
      ["pm", "do", "issue.create", "--params-file", file("array.json", [])],
      [
        "pm",
        "plan",
        "create",
        "--file",
        "valid.json",
        "--plan-file",
        "valid.json",
      ],
      ["pm", "plan", "create"],
      [
        "pm",
        "plan",
        "create",
        "--file",
        file("empty-plan.json", { title: "Empty", ops: [] }),
      ],
      ["pm", "run", "r1", "--events", "--limit", "201"],
      ["pm", "conversation", "title", " "],
      ["pm", "conversation", "title", "x".repeat(41)],
    ])
      expect((await run(args)).code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("requires a run token and keeps user mode inaccessible inside runs", async () => {
    const missing = await run(["pm", "agents", "--json"], false);
    expect(missing.code).toBe(3);
    expect(JSON.parse(missing.out).error.code).toBe("RUN_TOKEN_REQUIRED");
    expect((await run(["user", "whoami", "--json"])).code).toBe(3);
    expect(calls).toHaveLength(0);
  });
});
