import type { NpDesignResource } from './np-design-en-US.js';

/** Chinese wording for the design pass groups (`nocosolution/guidelines/frontend-standard.md`); merged into `np` by `zh-CN.ts`. */
const npDesignZhCN: NpDesignResource = {
  inboxPane: {
    all: '全部',
    emptyAll: '这里空空如也',
    nothingSelected: '选择一条查看',
    back: '返回列表',
    openIssue: '打开任务',
    recent: '最近动态',
    keyMove: '移动',
    keyArchive: '归档',
    keyOpen: '打开',
  },
  decision: {
    titles: {
      review_requested: '待验收交付',
      agent_blocked: 'Agent 受阻',
      approval_pending: '状态变更待审批',
      proposal_pending: '执行者建议待确认',
      knowledge_proposal: '知识库修改建议',
      pr_review: 'PR 待合并',
      design_review: '设计方案待审核',
    },
    actions: {
      review_requested: {
        accept: '验收通过',
        requestChanges: '打回并留言',
      },
      agent_blocked: {
        reply: '回复 Agent',
        reassign: '改派执行者',
      },
      approval_pending: {
        approve: '批准',
        reject: '驳回',
      },
      proposal_pending: {
        acceptAll: '全部采纳',
      },
      knowledge_proposal: {
        accept: '接受',
        reject: '驳回',
        openDoc: '打开文档',
      },
      pr_review: {
        openPr: '打开 PR',
      },
      design_review: {
        approve: '批准进入开发',
        requestChanges: '打回修改',
      },
    },
    section: {
      title: '等你决定',
      viewInInbox: '在收件箱中查看',
      doneWith: '已{{action}}',
    },
    delivery: {
      note: '交付说明',
      blockedNote: '受阻原因',
      noNote: 'Agent 没有在这个任务上留下评论。',
      runFailed: '最近一次运行失败：{{reason}}',
      runResult: '最近一次运行：{{summary}}',
      runDone: '最近一次运行于{{when}}结束。',
    },
    approval: {
      change: '变更',
      requester: '申请人',
      approvers: '审批人',
      since: '申请时间',
    },
    knowledge: {
      document: '文档',
      reason: '理由',
      summary: '摘要',
      against: '与当前版本（v{{version}}）对比',
      showDiff: '看差异',
      showFull: '看全文',
      gone: '这条建议已经处理过了。',
      diffCaption: '行有变化',
      noChange: '建议的正文与当前版本相同。',
      unchanged: '{{count}} 行未变',
      added: '新增：',
      removed: '删除：',
    },
  },
  issueAdd: {
    label: '添加',
    subtask: '子任务',
    dependency: '前置依赖',
    pullRequest: '关联 PR',
    attachment: '附件',
    none: '无',
  },
  live: {
    working: '{{name}} 正在工作',
    workingFor: '{{name}} 正在工作 · {{minutes}} 分钟',
    queued: '{{name}} 排队中',
  },
  composer: {
    comment: '评论',
    note: '备注',
    notePlaceholder: '写备注…',
    quickSend: '发送',
    newLine: '换行',
    sendNote: '添加备注',
  },
  projectPage: {
    tabs: {
      label: '项目分区',
      overview: '概览',
      issues: '任务',
      knowledge: '知识库',
    },
    numbers: '关键数字',
    stats: {
      total: '全部任务',
      started: '进行中',
      review: '待验收',
      done: '已完成',
    },
    distribution: '状态分布',
    noIssues: '还没有任务。',
    documents: '文档',
    noDocuments: '把这个项目的约定写下来，Agent 开工前会读。',
    archived: '已归档',
    openInList: '在任务列表中打开',
  },
};

export default npDesignZhCN;
