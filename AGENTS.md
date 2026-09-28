本仓库是一个 NocoBase Solution：`nocoproject/` 是应用，`nocoproject-cli/` 是守护进程与 CLI，中文方案与阶段文档位于 `nocosolution/NocoProject/`。系列总纲与 skill 以子模块 `nocosolution/` 引入，skill 在根目录 `.agents/skills/nocosolution`，所有 Coding Agent 共用；`.claude/skills/nocosolution` 是给 Claude Code 的镜像链接（应用目录的 `.claude/skills/` 由 `skills sync` 生成，不放这里）。

- 起草或修订方案、改骨架（trigger、run、shared/、收件箱）、新增临时实现、设计跨 Solution 联动之前，先读 `.agents/skills/nocosolution/SKILL.md`。
- 开工先 `git pull && git submodule update --init --remote --merge`。
- 出现总纲 14.2 节要汇报的情形：进 `nocosolution/` 改总纲并提交推送，再回到本仓库提交子模块指针。
- 方案的"依据"里写明引用的总纲版本；网页用 `node nocosolution/NocoProject/scripts/build-doc.mjs` 生成，不入库。

- Write all new Git commit messages in English.
