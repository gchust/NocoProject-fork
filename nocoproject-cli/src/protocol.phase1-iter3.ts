/**
 * NocoProject 协议类型：Phase 1 迭代 3 追加（docs/phase1/iteration-3-contract.md §J，实现见
 * docs/phase1/protocol-iteration-3.md）。
 *
 * 服务端正本；CLI 用 `pnpm sync-protocol` 复制本文件。本文件只从 protocol.ts 与 protocol.phase1-iter2.ts 引用类型；
 * 依赖服务端补充形状（IssueDetailV2 等）的组合类型在 protocol.phase1-iter3-server.ts（CLI 不复制）。
 * 只增不改：原联合类型保持不动，追加的枚举值写成单独的类型（InboxItemTypePhase1Iter3 等）再合并。
 */
import type {
  Activity,
  IssueListItemV1,
  ProjectDetail,
  Workflow,
} from './protocol.js';
import type {
  ApprovalRequest,
  CommentV2,
  InboxItemTypeV2,
  InboxItemV2,
  IssuePhase2Fields,
  IssueStatusSnapshot,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsView,
} from './protocol.phase1-iter2.js';

// ---------- 知识库（§B） ----------

/** 文档最后一次由谁更新（`knowledgeDocs.updatedByType`） */
export type KnowledgeAuthorType = 'user' | 'agent';
/** 版本作者（`knowledgeDocVersions.authorType`；system 目前不写，保留） */
export type KnowledgeVersionAuthorType = 'user' | 'agent' | 'system';
export type KnowledgeProposalStatus = 'pending' | 'accepted' | 'rejected';

export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_SUMMARY_MAX = 300;
export const KNOWLEDGE_REASON_MAX = 500;
export const KNOWLEDGE_NOTE_MAX = 500;
export const KNOWLEDGE_CONTENT_MAX = 200_000;
/** slug：小写字母数字与连字符，1–64 位，不以连字符开头 */
export const KNOWLEDGE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** `GET /np/knowledge`、`GET /np/agent/knowledge` 的元素（不含正文） */
export interface KnowledgeDocSummary {
  readonly id: string;
  /** null = 系统级文档 */
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  /** 从 1 开始，每次更新 +1 */
  readonly version: number;
  readonly updatedByType: KnowledgeAuthorType;
  readonly updatedById: string | null;
  readonly updatedByName: string | null;
  readonly archivedAt: string | null;
  /** 该文档上未决的建议数 */
  readonly pendingProposalCount: number;
  /** 当前用户能否修改（项目 lead、owner/admin；系统级只有 owner/admin）；Agent 接口恒为 false */
  readonly canEdit: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 含 Markdown 正文 */
export interface KnowledgeDoc extends KnowledgeDocSummary {
  readonly content: string;
}

export interface KnowledgeVersionSummary {
  readonly docId: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly authorType: KnowledgeVersionAuthorType;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly sourceRunId: string | null;
  readonly proposalId: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface KnowledgeDocVersion extends KnowledgeVersionSummary {
  readonly content: string;
}

export interface KnowledgeProposal {
  readonly id: string;
  /** null = 新建文档的建议（接受后回填为新文档 id） */
  readonly docId: string | null;
  /** 现有文档的标题（新建时为建议的标题） */
  readonly docTitle: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  /** 建议的标题（更新现有文档时为空串 = 不改标题） */
  readonly title: string;
  /** 新建时的 slug（接受时可能因重名加后缀） */
  readonly slug: string | null;
  readonly summary: string;
  readonly content: string;
  readonly reason: string;
  readonly isNew: boolean;
  /** 提出建议时文档的版本（新建为 null） */
  readonly baseVersion: number | null;
  /** 文档现在的版本（新建为 null）；大于 `baseVersion` 说明接受前有人先改了文档 */
  readonly currentVersion: number | null;
  readonly proposedByAgentId: string;
  readonly proposedByAgentName: string | null;
  readonly sourceRunId: string | null;
  readonly sourceIssueId: string | null;
  readonly sourceIssueIdentifier: string | null;
  readonly status: KnowledgeProposalStatus;
  readonly decidedById: string | null;
  readonly decidedByName: string | null;
  readonly decidedAt: string | null;
  readonly comment: string | null;
  /** 当前用户能否决定（浏览器接口；Agent 接口恒为 false） */
  readonly canDecide: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `GET /np/knowledge/:id` */
export interface KnowledgeDocDetail {
  readonly doc: KnowledgeDoc;
  /** 新版本在前 */
  readonly versions: readonly KnowledgeVersionSummary[];
  /** 该文档上未决的建议（新在前） */
  readonly proposals: readonly KnowledgeProposal[];
}

export interface CreateKnowledgeDocRequest {
  readonly projectId?: string | null;
  readonly title: string;
  readonly slug?: string;
  readonly summary?: string;
  readonly content: string;
}

export interface UpdateKnowledgeDocRequest {
  readonly title?: string;
  readonly summary?: string;
  readonly content?: string;
  readonly note?: string;
  readonly expectedVersion: number;
}

export interface DecideKnowledgeProposalRequest {
  readonly comment?: string;
  /** 接受一条已过期的建议（`baseVersion < currentVersion`）时带上，绕过 409 `KNOWLEDGE_PROPOSAL_STALE` */
  readonly confirmStale?: boolean;
}

/** `POST /np/agent/knowledge/proposals`：`docId`（id 或 slug）与 `title`（+ 可选 `slug`）二选一 */
export interface AgentKnowledgeProposalRequest {
  readonly docId?: string;
  readonly title?: string;
  readonly slug?: string;
  /** 新建时的项目；缺省 = 运行所属项目，null = 系统级 */
  readonly projectId?: string | null;
  readonly summary?: string;
  readonly content: string;
  readonly reason: string;
}

/** 认领载荷 `knowledge[]` 的元素（索引，不带正文） */
export interface ClaimedKnowledgeDoc {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly projectId: string | null;
}

/** ClaimedRun 在迭代 3 追加的字段（守护进程按可选读取） */
export interface ClaimedRunPhase3Extras {
  /** 运行所属项目的文档在前，系统级在后；不含归档文档 */
  readonly knowledge: readonly ClaimedKnowledgeDoc[];
}

// ---------- 验收指标（§C） ----------

export type MetricStatus = 'ok' | 'warn' | 'n/a';

/** `settings.metricThresholds`；方向见 METRIC_THRESHOLD_DIRECTIONS */
export interface MetricThresholds {
  /** aiShare.share ≥ */
  readonly aiShare: number;
  /** trust.proposalAcceptRate ≥ */
  readonly proposalAcceptRate: number;
  /** reliability.claimLatencyP50Ms ≤ */
  readonly claimLatencyP50Ms: number;
  /** reliability.lostRuns ≤ */
  readonly lostRuns: number;
  /** humanLoad.decisionResolveP50Ms ≤ */
  readonly decisionResolveP50Ms: number;
}

export type MetricThresholdKey = keyof MetricThresholds;

export const METRIC_THRESHOLD_KEYS: readonly MetricThresholdKey[] = [
  'aiShare',
  'proposalAcceptRate',
  'claimLatencyP50Ms',
  'lostRuns',
  'decisionResolveP50Ms',
];

/** min：值 ≥ 阈值为 ok；max：值 ≤ 阈值为 ok */
export const METRIC_THRESHOLD_DIRECTIONS: Readonly<
  Record<MetricThresholdKey, 'min' | 'max'>
> = {
  aiShare: 'min',
  proposalAcceptRate: 'min',
  claimLatencyP50Ms: 'max',
  lostRuns: 'max',
  decisionResolveP50Ms: 'max',
};

export const DEFAULT_METRIC_THRESHOLDS: MetricThresholds = {
  aiShare: 0.5,
  proposalAcceptRate: 0.7,
  claimLatencyP50Ms: 3000,
  lostRuns: 0,
  decisionResolveP50Ms: 24 * 3600 * 1000,
};

export interface MetricsAdoption {
  readonly activeWeeks: number;
  readonly activeDays: number;
  readonly issuesCreated: number;
  readonly activeMembers: number;
}

export interface MetricsAiShare {
  readonly deliveredByAgent: number;
  readonly deliveredTotal: number;
  /** 没有交付时为 null */
  readonly share: number | null;
}

export interface MetricsTrust {
  readonly proposalAcceptRate: number | null;
  readonly reviewPassRate: number | null;
  readonly approvalApproveRate: number | null;
  readonly reworkRate: number | null;
}

export interface MetricsReliability {
  readonly runs: number;
  readonly failedRuns: number;
  readonly failuresByReason: Readonly<Record<string, number>>;
  readonly claimLatencyP50Ms: number | null;
  readonly claimLatencyP95Ms: number | null;
  readonly runDurationP50Ms: number | null;
  readonly lostRuns: number;
}

export interface MetricsCostByAgent {
  readonly agentId: string;
  readonly name: string;
  readonly cost: number | null;
}

export interface MetricsCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number | null;
  readonly costPerDeliveredIssue: number | null;
  readonly byAgent: readonly MetricsCostByAgent[];
}

export interface MetricsHumanLoad {
  readonly decisionsCreated: number;
  readonly decisionsResolved: number;
  readonly decisionResolveP50Ms: number | null;
  readonly openDecisions: number;
  /** 期间创建的决定项按类型计数 */
  readonly byType: Readonly<Partial<Record<InboxItemTypeV3, number>>>;
}

/** `GET /np/metrics` */
export interface MetricsReport {
  /** UTC 日期，含两端 */
  readonly from: string;
  readonly to: string;
  readonly projectId: string | null;
  readonly generatedAt: string;
  readonly adoption: MetricsAdoption;
  readonly aiShare: MetricsAiShare;
  readonly trust: MetricsTrust;
  readonly reliability: MetricsReliability;
  readonly cost: MetricsCost;
  readonly humanLoad: MetricsHumanLoad;
  readonly thresholds: MetricThresholds;
  readonly statuses: Readonly<Record<MetricThresholdKey, MetricStatus>>;
}

/** `GET /np/settings` 追加 */
export type WorkspaceSettingsViewV3 = WorkspaceSettingsView & {
  readonly metricThresholds: MetricThresholds;
};

/** `PATCH /np/settings` 追加（部分键即可，与已存的合并） */
export type UpdateWorkspaceSettingsRequestV3 =
  UpdateWorkspaceSettingsRequest & {
    readonly metricThresholds?: Partial<MetricThresholds>;
  };

// ---------- 分页（§D） ----------

export const ISSUE_PAGE_DEFAULT_LIMIT = 50;
export const ISSUE_PAGE_MAX_LIMIT = 100;
export const BOARD_COLUMN_DEFAULT_LIMIT = 50;
export const ACTIVITY_PAGE_DEFAULT_LIMIT = 50;
export const ACTIVITY_PAGE_MAX_LIMIT = 200;
/** 详情里的评论超过这个数才分页 */
export const DETAIL_COMMENTS_LIMIT = 200;

/** 任务列表行（服务端的 IssueListItemV2） */
export type IssueListRow = IssueListItemV1 & IssuePhase2Fields;

/** `GET /np/issues` 的完整响应体（`nextCursor` 与 `data` 同级；null = 最后一页） */
export interface IssueListPage<T = IssueListRow> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export interface BoardGroupV3<T = IssueListRow> {
  readonly statusKey: string;
  readonly issues: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/** `GET /np/issues?view=board` 的 data（带 `statusKey` 时只有那一列） */
export interface IssueBoardResponseV3<T = IssueListRow> {
  readonly groups: readonly BoardGroupV3<T>[];
}

/** `GET /np/issues/:id/activities` 的完整响应体；`data` 按时间升序，`nextCursor` 取更早的一页 */
export interface ActivityPage {
  readonly data: readonly Activity[];
  readonly nextCursor: string | null;
}

/** `GET /np/issues/:id/comments` 的完整响应体；`data` 按时间升序，`nextCursor` 取更早的一页 */
export interface CommentPage {
  readonly data: readonly CommentV2[];
  readonly nextCursor: string | null;
}

/** 任务详情追加的分页游标 */
export interface IssueDetailPaging {
  readonly activitiesNextCursor: string | null;
  readonly commentsNextCursor: string | null;
}

// ---------- 收件箱直接操作与交付（§E） ----------

export type InboxActionKind = 'primary' | 'secondary' | 'danger';
/** GET = 导航（应用内路由，或 `external` 时为外部 URL）；POST = 调接口（路径相对 `/api`） */
export type InboxActionMethod = 'GET' | 'POST';

export interface InboxAction {
  readonly key: string;
  /** i18n key：`np.inboxActions.<key>` */
  readonly label: string;
  readonly kind: InboxActionKind;
  readonly method: InboxActionMethod;
  /** POST：接口路径（如 `/np/issues/<id>/deliveries/accept`）；GET：应用内路由（如 `/issues/NP-12`）或外部 URL */
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  /** 需要先填评论；评论写进 `body[commentField]` */
  readonly needsComment?: boolean;
  /** 评论字段名，默认 `comment`（回复 Agent 是 `content`） */
  readonly commentField?: string;
  /** 打开任务详情（在那里继续操作） */
  readonly opensIssue?: boolean;
  /** `path` 是外部 URL（新窗口打开） */
  readonly external?: boolean;
}

export interface AcceptDeliveryRequest {
  readonly comment?: string;
}

export interface RequestChangesRequest {
  readonly comment: string;
}

/**
 * `POST /np/issues/:id/deliveries/accept | request-changes` 的 data（200；状态变化需审批时 202，`issue` 未变）。
 * `issue` 是完整任务行（服务端 IssueV2），这里只列 CLI 读取的字段。
 */
export interface DeliveryResult {
  readonly issue: IssueStatusSnapshot;
  readonly pendingApproval: ApprovalRequest | null;
  readonly comment: CommentV2 | null;
}

// ---------- 工作流模板（§F） ----------

/** `GET /np/workflows` 的行与 `GET /np/workflows/:id`（`isDefault` 已在 Workflow 上） */
export type WorkflowListItem = Workflow & {
  /** 使用这个模板的项目数（默认模板含未指定模板的项目） */
  readonly projectCount: number;
};

// ---------- 项目详情（§B） ----------

/** `GET /np/projects/:id` 追加项目文档（不含系统级、不含归档） */
export type ProjectDetailV3 = ProjectDetail & {
  readonly knowledgeDocs: readonly KnowledgeDocSummary[];
};

// ---------- 追加的枚举值 ----------

export type InboxItemTypePhase1Iter3 =
  'knowledge_proposal' | 'knowledge_decided';
/** 迭代 1–3 的全部收件箱类型 */
export type InboxItemTypeV3 = InboxItemTypeV2 | InboxItemTypePhase1Iter3;
/** 收件箱项（`type` 含迭代 3 的类型；`payload.actions` 见 InboxAction） */
export type InboxItemV3 = Omit<InboxItemV2, 'type'> & {
  readonly type: InboxItemTypeV3;
};
export type ActivityActionPhase1Iter3 =
  | 'knowledge_proposed'
  | 'knowledge_updated'
  | 'delivery_accepted'
  | 'changes_requested';
