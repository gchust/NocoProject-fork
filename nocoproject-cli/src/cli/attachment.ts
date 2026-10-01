/**
 * `nocoproject issue attachment list|download [issue]` (NP-111): the files attached to an issue. `list` prints the
 * attachments of the agent issue view; `download` saves them (or one, `--id`) into a directory, by default
 * `./attachments/<identifier>/` under the current directory, so the agent can open images and documents locally.
 */
import { HttpError } from "../api/client.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import type { AgentAttachmentInfo } from "../protocol.js";
import { CliError, EXIT, printJson, printLine } from "./output.js";
import {
  action,
  type JsonOpt,
  resolveIssueId,
  runTokenContext,
  type RunTokenContext,
} from "./run-token.js";

export interface SavedAttachment extends AgentAttachmentInfo {
  readonly path: string;
  readonly textPath?: string;
}

/** A file name safe to write inside the target directory: no separators, control characters or dot names. */
export function safeFileName(filename: string, fallback: string): string {
  const cleaned = filename
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned === "" || cleaned === "." || cleaned === ".."
    ? fallback
    : cleaned;
}

/** Distinct names for one directory: a repeated name gets the file id in front. */
export function fileNames(items: readonly AgentAttachmentInfo[]): string[] {
  const used = new Set<string>();
  return items.map((item) => {
    let name = safeFileName(item.filename, item.id);
    const base = name;
    let suffix = 0;
    while (used.has(name.toLowerCase())) {
      name = `${item.id}-${suffix++ || ""}${base}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function attachmentsOf(
  ctx: RunTokenContext,
  issueId: string,
): Promise<{ identifier: string; items: AgentAttachmentInfo[] }> {
  const issue = (await ctx.api.issue(issueId)) as {
    id: string;
    identifier: string | null;
    attachments?: readonly AgentAttachmentInfo[];
  };
  const items = [...(issue.attachments ?? [])];
  if (items.some((item) => !item.id)) {
    throw new CliError(
      "the server does not offer attachment downloads yet; upgrade NocoProject",
      EXIT.notFound,
      "ATTACHMENT_DOWNLOAD_UNSUPPORTED",
    );
  }
  return { identifier: issue.identifier || issue.id || issueId, items };
}

export function registerAttachmentCommands(issue: Command): void {
  const attachment = issue
    .command("attachment")
    .description("Files attached to an issue (images, documents)");
  attachment
    .command("list [issue]")
    .description("List the attachments (id, name, type, size)")
    .option("--json", "JSON output")
    .action(
      action(async (arg: string | undefined, opts: JsonOpt) => {
        const ctx = runTokenContext();
        const { items } = await attachmentsOf(
          ctx,
          await resolveIssueId(arg, ctx),
        );
        if (opts.json) return printJson(items);
        if (items.length === 0) return printLine("(no attachments)");
        for (const item of items)
          printLine(
            `${item.id}  ${item.filename}  ${item.mimeType}  ${formatSize(item.size)}`,
          );
      }),
    );
  attachment
    .command("download [issue]")
    .description(
      "Save the attachments into a directory (default ./attachments/<issue>/) and print the paths",
    )
    .option("--id <fileId>", "only this attachment")
    .option("--dir <path>", "target directory")
    .option("--json", "JSON output")
    .action(
      action(
        async (
          arg: string | undefined,
          opts: JsonOpt & { id?: string; dir?: string },
        ) => {
          const ctx = runTokenContext();
          const issueId = await resolveIssueId(arg, ctx);
          const { identifier, items } = await attachmentsOf(ctx, issueId);
          const names = fileNames(items);
          const picked = items
            .map((item, index) => ({ item, name: names[index]! }))
            .filter(({ item }) => !opts.id || item.id === opts.id);
          if (opts.id && picked.length === 0)
            throw new CliError(
              `attachment ${opts.id} is not on ${identifier}`,
              EXIT.notFound,
              "ATTACHMENT_NOT_FOUND",
            );
          const dir = resolve(opts.dir ?? join("attachments", identifier));
          const saved: SavedAttachment[] = [];
          const usedNames = new Set(names.map((name) => name.toLowerCase()));
          if (picked.length > 0) mkdirSync(dir, { recursive: true });
          for (const { item, name } of picked) {
            const { bytes } = await ctx.api.attachmentContent(issueId, item.id);
            const path = join(dir, name);
            writeFileSync(path, bytes);
            let textPath: string | undefined;
            if (/\.(docx|xlsx|pptx)$/i.test(item.filename)) {
              try {
                const result = await ctx.api.http.data<{ text: string | null }>(
                  "GET",
                  "/np/agent/issues/" +
                    encodeURIComponent(issueId) +
                    "/attachments/" +
                    encodeURIComponent(item.id) +
                    "/text",
                );
                if (result.text !== null) {
                  let textName = name + ".txt";
                  while (usedNames.has(textName.toLowerCase()))
                    textName = item.id + "-" + textName;
                  usedNames.add(textName.toLowerCase());
                  textPath = join(dir, textName);
                  writeFileSync(textPath, result.text, "utf8");
                }
              } catch (error) {
                if (!(error instanceof HttpError) || error.status !== 404)
                  throw error;
                process.stderr.write(
                  "Attachment text endpoint unavailable; kept the original download.\n",
                );
              }
            }
            saved.push({ ...item, path, ...(textPath ? { textPath } : {}) });
          }
          if (opts.json) return printJson(saved);
          if (saved.length === 0) return printLine("(no attachments)");
          for (const file of saved) {
            if (file.textPath) printLine(file.textPath);
            printLine(
              `${file.path}  (${file.mimeType}, ${formatSize(file.size)})`,
            );
          }
        },
      ),
    );
}
