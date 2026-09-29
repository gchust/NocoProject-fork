import type { NpSignalsResource } from './np-signals-en-US.js';

/** Chinese wording for signals (`server/modules/shared/protocol.phase2-signals.ts`); merged into `np` by `zh-CN.ts`. */
const npSignalsZhCN: NpSignalsResource = {
  signals: {
    title: '自动唤醒执行 Agent',
    description:
      '关联的 Pull Request 出现需要修复的问题时，唤醒负责执行这个任务的 Agent，在同一分支上修复。默认关闭；由人执行的任务不受影响。',
    readOnly: '只有可以修改工作区设置的人才能修改这些规则。',
    saved: '规则已保存',
    maxConsecutive: '连续尝试次数',
    maxConsecutiveHint:
      '连续这么多次运行后问题仍未解决，就不再唤醒 Agent，改为通知任务负责人。',
    maxConsecutiveInvalid: '请输入 1 到 {{max}} 之间的整数。',
    instruction: '给 Agent 的指令',
    instructionHint: '留空则使用框中显示的默认指令。可用占位符：',
    kinds: {
      'github.ciFailed': {
        label: 'CI 检查失败',
        hint: '关联的未合并 Pull Request 的检查（GitHub Actions 或 commit status）失败。',
      },
      'github.conflict': {
        label: '合并冲突',
        hint: '关联的未合并 Pull Request 与目标分支冲突。需要 Webhook 勾选 Pushes 事件。',
      },
    },
  },
};

export default npSignalsZhCN;
