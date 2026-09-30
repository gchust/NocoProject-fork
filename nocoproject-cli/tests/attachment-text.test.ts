import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI = join(__dirname, "..", "dist", "cli.js");
let dir: string;
let server: Server;
let url: string;
let textStatus = 200;
let extracted: string | null = "Extracted document";
let files = [
  {
    id: "f1",
    filename: "report.docx",
    size: 3,
    mimeType: "application/octet-stream",
  },
  { id: "f2", filename: "report.docx.txt", size: 3, mimeType: "text/plain" },
];
const requests: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pm-attachments-"));
  server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url?.endsWith("/content")) return res.end("raw");
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/text")) {
      res.statusCode = textStatus;
      return res.end(
        JSON.stringify(
          textStatus === 200
            ? { data: { text: extracted } }
            : {
                code: textStatus === 403 ? "FORBIDDEN" : "NOT_FOUND",
                message: "Unavailable",
              },
        ),
      );
    }
    res.end(
      JSON.stringify({
        data: { id: "conversation1", identifier: null, attachments: files },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  textStatus = 200;
  extracted = "Extracted document";
});
function run() {
  const child = spawn(
    process.execPath,
    [CLI, "issue", "attachment", "download", "conversation1", "--json"],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        NOCOPROJECT_HOME: dir,
        NOCOPROJECT_SERVER_URL: url,
        NOCOPROJECT_TOKEN: "npr_attachment_fixture",
      },
    },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolve) => child.on("close", (code) => resolve({ code, out, err })),
  );
}
describe("attachment text sidecars", () => {
  it("uses the id of an unnumbered conversation and never overwrites an original attachment", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    const saved = JSON.parse(result.out);
    expect(saved[0].path).toContain("/attachments/conversation1/report.docx");
    expect(saved[0].textPath).not.toBe(saved[1].path);
    expect(readFileSync(saved[0].textPath, "utf8")).toBe(extracted);
    expect(readFileSync(saved[1].path, "utf8")).toBe("raw");
    expect(requests.filter((p) => p.endsWith("/text"))).toEqual([
      "/api/np/agent/issues/conversation1/attachments/f1/text",
    ]);
  });
  it.each(["xlsx", "pptx"])("also extracts %s", async (extension) => {
    const previous = files;
    files = [
      {
        id: "f3",
        filename: "sheet." + extension,
        mimeType: "application/octet-stream",
        size: 3,
      },
    ];
    try {
      const r = await run();
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)[0].textPath).toContain(extension + ".txt");
    } finally {
      files = previous;
    }
  });
  it("preserves the original when the older server has no text endpoint", async () => {
    textStatus = 404;
    const r = await run();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)[0].textPath).toBeUndefined();
    expect(r.err).toContain("kept the original download");
  });
  it("does not invent text when extraction is unavailable", async () => {
    extracted = null;
    const r = await run();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)[0].textPath).toBeUndefined();
  });
  it("does not hide a text authorization failure", async () => {
    textStatus = 403;
    const r = await run();
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).error.code).toBe("FORBIDDEN");
    expect(requests.filter((p) => p.endsWith("/text"))).toHaveLength(1);
  });
});
