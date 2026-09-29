import {
  BarChart3,
  BookOpenText,
  Bot,
  BotMessageSquare,
  Briefcase,
  CircleUserRound,
  FolderKanban,
  ListTodo,
  MonitorCog,
  Settings2,
  Sparkles,
} from 'lucide-react';
import {
  defineAppRoutes,
  type AppClientRouteContribution,
} from '@nocobase/app-client/plugins';

import { NpInboxNavIcon } from './components/np-inbox-nav-icon.js';

/**
 * NP-117: a `/config` tab opens for whoever may read its settings item (`server/modules/shared/access.ts`); the page
 * grant `np-config` still applies above it.
 */
function settingsRead(id: string) {
  return { resource: { type: 'settings', id }, action: 'read' } as const;
}

/**
 * The sidebar follows the product plan §3.1 (iteration 3 §G): Inbox, My issues and Project manager (iteration 4 §C)
 * on top, the groups Work (issues, projects) and Agent team (agents, runtimes, skills, knowledge), then Reports and
 * Settings. Settings live in the front end (`/config`) rather than the system settings shell. Creating issues — one
 * or many — is the "New issue" (np.issues.new) dialog over the issues page (iteration 4 §D).
 *
 * Page tabs are child routes without `navigation` or `breadcrumb`; overlays (dialogs and drawers) are child routes
 * too. Children omit `authz` and inherit the page grant above them. `/intake`, `/issues/intake`,
 * `/projects/:projectId/intake`, `/usage` and `/inbox/approvals` are kept as redirects so old links and bookmarks
 * still land somewhere.
 */
const appRoutes: AppClientRouteContribution = defineAppRoutes([
  {
    // Every signed-in user reaches the landing page. `authz: 'skip'` takes it out of page authorization entirely, so
    // no permission change can leave a user signed in with nowhere to land. It is not in the menu (§3.1 has no home);
    // the page itself forwards to the inbox when the viewer may open it.
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/home.js'),
    name: 'home',
    path: '/',
  },
  {
    // Self-service account settings; authentication owns all writes, with no administrative page grant.
    auth: 'required',
    authz: 'skip',
    name: 'profile',
    path: '/profile',
    componentLoader: () => import('./pages/profile/index.js'),
  },
  {
    // Decisions and notifications (iteration 1 §J 3). The icon carries the unread decision count. `approvals` is a
    // redirect into the decisions list since iteration 3 §G.
    auth: 'required',
    authz: { resource: { type: 'page', id: 'np-inbox' }, action: 'access' },
    breadcrumb: { title: 'navigation.inbox' },
    componentLoader: () => import('./pages/np/inbox/index.js'),
    name: 'np-inbox',
    navigation: { title: 'navigation.inbox', icon: NpInboxNavIcon, order: 1 },
    path: '/inbox',
    children: [
      {
        componentLoader: () => import('./pages/np/inbox/approvals.js'),
        name: 'np-approvals',
        path: 'approvals',
      },
    ],
  },
  {
    // My issues (§G): the issue list and board filtered to the viewer, one tab per role.
    auth: 'required',
    authz: {
      resource: { type: 'page', id: 'np-my-issues' },
      action: 'access',
    },
    breadcrumb: { title: 'navigation.myIssues' },
    componentLoader: () => import('./pages/np/my-issues/index.js'),
    name: 'np-my-issues',
    navigation: {
      title: 'navigation.myIssues',
      icon: CircleUserRound,
      order: 2,
    },
    path: '/my-issues',
    children: [
      {
        componentLoader: () => import('./pages/np/my-issues/owned.js'),
        name: 'np-my-issues-owned',
        path: 'owned',
      },
      {
        componentLoader: () => import('./pages/np/my-issues/executing.js'),
        name: 'np-my-issues-executing',
        path: 'executing',
      },
    ],
  },
  {
    // Project manager (iteration 4 §C): the viewer's conversation with the project manager agent, full width.
    auth: 'required',
    authz: { resource: { type: 'page', id: 'np-pm' }, action: 'access' },
    breadcrumb: { title: 'navigation.pm' },
    componentLoader: () => import('./pages/np/pm/index.js'),
    name: 'np-pm',
    navigation: { title: 'navigation.pm', icon: BotMessageSquare, order: 3 },
    path: '/pm',
  },
  {
    name: 'np-work',
    navigation: { title: 'navigation.work', icon: Briefcase, order: 4 },
    children: [
      {
        // The detail is a covering child page (the list keeps its filters underneath); "New issue" (np.issues.new)
        // is a route dialog (one issue or many, iteration 4 §D) and `intake` redirects into it; the run transcript
        // is a dialog over the detail.
        auth: 'required',
        authz: {
          resource: { type: 'page', id: 'np-issues' },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.issues' },
        componentLoader: () => import('./pages/np/issues/index.js'),
        name: 'np-issues',
        navigation: { title: 'navigation.issues', icon: ListTodo },
        path: '/issues',
        children: [
          {
            componentLoader: () => import('./pages/np/issues/new.js'),
            name: 'np-issue-new',
            path: 'new',
          },
          {
            // Iteration 3's batch entry drawer: the AI draft (np.newIssue.tabs.ai) tab of "New issue" since
            // iteration 4 §D.
            componentLoader: () => import('./pages/np/intake/redirect.js'),
            name: 'np-issue-intake',
            path: 'intake',
          },
          {
            breadcrumb: { title: 'np.issue.breadcrumb' },
            componentLoader: () => import('./pages/np/issues/detail/index.js'),
            name: 'np-issue-detail',
            path: ':issueId',
            children: [
              {
                componentLoader: () =>
                  import('./pages/np/issues/detail/transcript.js'),
                name: 'np-run-transcript',
                path: 'runs/:runId',
              },
              {
                componentLoader: () =>
                  import('./pages/np/issues/detail/new-subtask.js'),
                name: 'np-subtask-new',
                path: 'new-subtask',
              },
            ],
          },
        ],
      },
      {
        auth: 'required',
        authz: {
          resource: { type: 'page', id: 'np-projects' },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.projects' },
        componentLoader: () => import('./pages/np/projects/index.js'),
        name: 'np-projects',
        navigation: { title: 'navigation.projects', icon: FolderKanban },
        path: '/projects',
        children: [
          {
            componentLoader: () => import('./pages/np/projects/new.js'),
            name: 'np-project-new',
            path: 'new',
          },
          {
            breadcrumb: { title: 'np.projects.breadcrumb' },
            componentLoader: () =>
              import('./pages/np/projects/detail/index.js'),
            name: 'np-project-detail',
            path: ':projectId',
            children: [
              {
                componentLoader: () =>
                  import('./pages/np/projects/detail/new-resource.js'),
                name: 'np-project-resource-new',
                path: 'resources/new',
              },
              {
                // Iteration 3's "Batch add" (np-iter2 project.batchAdd): the AI draft tab of "New issue" with the
                // project preselected.
                componentLoader: () => import('./pages/np/intake/redirect.js'),
                name: 'np-project-intake',
                path: 'intake',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'np-agent-team',
    navigation: { title: 'navigation.agentTeam', icon: Bot, order: 5 },
    children: [
      {
        auth: 'required',
        authz: {
          resource: { type: 'page', id: 'np-agents' },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.agents' },
        componentLoader: () => import('./pages/np/agents/index.js'),
        name: 'np-agents',
        navigation: { title: 'navigation.agents', icon: Bot },
        path: '/agents',
        children: [
          {
            componentLoader: () => import('./pages/np/agents/new.js'),
            name: 'np-agent-new',
            path: 'new',
          },
          {
            breadcrumb: { title: 'np.agentDetail.breadcrumb' },
            componentLoader: () => import('./pages/np/agents/detail/index.js'),
            name: 'np-agent-detail',
            path: ':agentId',
          },
        ],
      },
      {
        auth: 'required',
        authz: {
          resource: { type: 'page', id: 'np-runtimes' },
          action: 'access',
        },
        componentLoader: () => import('./pages/np/runtimes/index.js'),
        name: 'np-runtimes',
        navigation: { title: 'navigation.runtimes', icon: MonitorCog },
        path: '/runtimes',
        children: [
          {
            componentLoader: () => import('./pages/np/runtimes/connect.js'),
            name: 'np-runtime-connect',
            path: 'connect',
          },
        ],
      },
      {
        auth: 'required',
        authz: {
          resource: { type: 'page', id: 'np-skills' },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.skills' },
        componentLoader: () => import('./pages/np/skills/index.js'),
        name: 'np-skills',
        navigation: { title: 'navigation.skills', icon: Sparkles },
        path: '/skills',
        children: [
          {
            componentLoader: () => import('./pages/np/skills/new.js'),
            name: 'np-skill-new',
            path: 'new',
          },
          {
            breadcrumb: { title: 'np.skills.breadcrumb' },
            componentLoader: () => import('./pages/np/skills/detail/index.js'),
            name: 'np-skill-detail',
            path: ':skillId',
          },
        ],
      },
      {
        // Knowledge base (§B): Markdown documents per project or for the workspace; agents propose changes.
        auth: 'required',
        authz: {
          resource: { type: 'page', id: 'np-knowledge' },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.knowledge' },
        componentLoader: () => import('./pages/np/knowledge/index.js'),
        name: 'np-knowledge',
        navigation: { title: 'navigation.knowledge', icon: BookOpenText },
        path: '/knowledge',
        children: [
          {
            componentLoader: () => import('./pages/np/knowledge/new.js'),
            name: 'np-knowledge-new',
            path: 'new',
          },
          {
            breadcrumb: { title: 'np.knowledge.breadcrumb' },
            componentLoader: () =>
              import('./pages/np/knowledge/detail/index.js'),
            name: 'np-knowledge-detail',
            path: ':docId',
          },
        ],
      },
    ],
  },
  {
    // Reports (§G): acceptance metrics (§C) and run usage (iteration 2 §I) as two tabs.
    auth: 'required',
    authz: { resource: { type: 'page', id: 'np-reports' }, action: 'access' },
    componentLoader: () => import('./pages/np/reports/index.js'),
    name: 'np-reports',
    navigation: { title: 'navigation.reports', icon: BarChart3, order: 6 },
    path: '/reports',
    children: [
      {
        componentLoader: () => import('./pages/np/reports/metrics.js'),
        name: 'np-reports-metrics',
        path: 'metrics',
      },
      {
        componentLoader: () => import('./pages/np/reports/usage.js'),
        name: 'np-reports-usage',
        path: 'usage',
      },
    ],
  },
  {
    // Settings (§G): workspace settings in the front end. Each tab checks its settings item `nocoproject.*` (NP-117): by
    // default members read all but GitHub, owner/admin change them (the server enforces the same rule on every write).
    auth: 'required',
    authz: { resource: { type: 'page', id: 'np-config' }, action: 'access' },
    breadcrumb: { title: 'navigation.config' },
    componentLoader: () => import('./pages/np/config/index.js'),
    name: 'np-config',
    navigation: { title: 'navigation.config', icon: Settings2, order: 7 },
    path: '/config',
    children: [
      {
        authz: settingsRead('nocoproject.general'),
        componentLoader: () => import('./pages/np/config/general.js'),
        name: 'np-config-general',
        path: 'general',
      },
      {
        authz: settingsRead('nocoproject.members'),
        componentLoader: () => import('./pages/np/config/members.js'),
        name: 'np-config-members',
        path: 'members',
        children: [
          {
            // NP-153: one business role, as a covering page over the Roles section.
            breadcrumb: { title: 'np.roles.breadcrumb' },
            componentLoader: () => import('./pages/np/config/role-detail.js'),
            name: 'np-config-member-role',
            path: 'roles/:roleKey',
          },
        ],
      },
      {
        authz: settingsRead('nocoproject.workflows'),
        componentLoader: () => import('./pages/np/config/workflows.js'),
        name: 'np-config-workflows',
        path: 'workflows',
        children: [
          {
            breadcrumb: { title: 'np.workflows.breadcrumb' },
            componentLoader: () =>
              import('./pages/np/config/workflow-detail.js'),
            name: 'np-config-workflow-detail',
            path: ':workflowId',
          },
        ],
      },
      {
        authz: settingsRead('nocoproject.labels'),
        componentLoader: () => import('./pages/np/config/labels.js'),
        name: 'np-config-labels',
        path: 'labels',
      },
      {
        authz: settingsRead('nocoproject.github'),
        componentLoader: () => import('./pages/np/config/github.js'),
        name: 'np-config-github',
        path: 'github',
      },
    ],
  },
  {
    // Iteration 2's batch entry page is now the AI draft tab of "New issue" (iteration 4 §D); `?project` / `?batch`
    // kept.
    auth: 'required',
    authz: 'skip',
    componentLoader: () => import('./pages/np/intake/redirect.js'),
    name: 'np-intake-redirect',
    path: '/intake',
  },
  {
    // Iteration 2's usage page is now the Usage tab of /reports (§G).
    auth: 'required',
    authz: 'skip',
    componentLoader: () => import('./pages/np/reports/usage-redirect.js'),
    name: 'np-usage-redirect',
    path: '/usage',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/login.js'),
    name: 'login',
    path: '/login',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/register.js'),
    name: 'register',
    path: '/register',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/forgot-password.js'),
    name: 'forgot-password',
    path: '/forgot-password',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/reset-password.js'),
    name: 'reset-password',
    path: '/reset-password',
  },
  {
    // NP-88: the page an invitation email links to. `optional`, not `guest`: a guest page would send a signed-in
    // visitor to `/` without a word, so the page itself asks them to sign out before accepting.
    auth: 'optional',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/invite.js'),
    name: 'np-invite',
    path: '/invite/:token',
  },
]);

const routes: readonly AppClientRouteContribution[] = [appRoutes];

export default routes;
