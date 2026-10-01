# NocoProject pages: UI rules

The design system is `nocosolution/guidelines/frontend-standard.md`: part one (§1–§16) for any NocoBase 3 app, part two (§S1–§S16) for what every NocoSolution must share; this file is their implementation checklist for `client/pages/np/`. NocoProject used to keep a separate `../nocosolution/NocoProject/docs/design/ui-design.md`; it has been folded into those two docs and this file (§11 keeps what was NocoProject-specific: the shell layout and the screenshot/token inventory) and no longer exists — do not recreate it. Every page under `client/pages/np/` follows the rules here, but a design decision the product owner or user states explicitly for a page — even a one-line request, not written down anywhere — outranks all of it; update this file afterward so it stops saying one thing while the page does another. Start from `client/pages/reference/examples` (orders, team-settings, inbox, dashboard) for structure and density, and from `client/pages/reference/components` for component APIs — copy structure, never import.

## 0. Styling under the compact preset

NocoBase ships compact as the default preset: it sets `--spacing: 0.2rem` (20% under Tailwind's 0.25rem), so every `p-*`, `gap-*`, `h-*` and `w-*` shrinks. Our pages had picked values that were already tight under the default preset (32px nav rows, `size-8` header buttons, `w-72` board columns) and used `text-xs` for body copy, so under compact they looked cramped. Rules:

- Never override `--spacing` or any preset token at page level, and never give one page its own density.
- Size with the spacing scale and component size variants: buttons default / `sm` / `icon-sm`, the template's navigation row, the `DataTable` default row, cards `p-4` / `p-5`. No hand-picked tight values.
- Body text `text-sm`; `text-xs` only for captions and metadata; tags use `NpTag` (12px).
- Hit targets never below `icon-sm`.
- Layout widths that must not shrink are written in rem with a comment: side column `20rem`, inbox list `26rem`, board column `18rem`.
- Check both presets (compact, default) and both modes (light, dark): `pnpm build && pnpm screenshots` writes all four combinations of every page to `output/screenshots/` from a throwaway preview of this checkout (`../nocosolution/NocoProject/docs/dogfooding.md`); attach them to the delivery.

## 1. Page frame

- A top-level page is `PageContainer` + `PageHeader` (title = the menu name, one sentence of description, the one primary action rightmost). No `max-w-*` or `mx-auto` at page level.
- Only form and dialog content are width-limited (`FieldGroup className='max-w-2xl'`, the dialog's content).
- Page tabs are child routes (`NpRouteTabs` + default-tab redirect). Sections inside a covering detail page use `NpTabBar` with `?tab=`, because the detail's child routes are its dialogs. Both look the same. `/config/members` also splits into Members and Roles with `NpTabBar` and `?tab=roles` (NP-153): it is already a tab of `/config`, and its child route is the covering role page `/config/members/roles/:roleKey`.
- `/issues` and `/my-issues` fill the content area: header, toolbar, then the board or the table in a bounded area (`PageContainer className='flex h-full min-h-0 flex-col gap-6 space-y-0'`, `IssueBoard fill`, `DataTable fillHeight`). The page itself does not scroll.
- Every top-level page renders `NpShortcuts` once (§8).
- The project manager has no page and no sidebar entry (NP-197): its conversations and their history live in the drawer. `/pm` (history), `/pm/:conversationId` and `/pm/new` stay for links: they open the drawer there and go back to the page the member came from (the landing page when the link opened the app).
- The project manager drawer (`pages/np/pm/assistant/`) lives in the shell, beside `<main>`, so it survives page changes: docked (26.25rem) from 1536px, floating over the content (25rem) from `md`, a full-screen dialog below `md` (opened from a floating button), and "expand" covers the content area. The docked and floating forms are not dialogs, so `C` keeps working. Pages register what they show with `usePmContextSource` (and list filters with `usePmUrlFilter`); mark a block whose selected text belongs to an object with `data-pm-source="<type>:<id>"`. "Ask the project manager" is `AskPmButton`. `?pm=<conversationId|new|history>&pmMode=expanded` opens the drawer from a link. The history is the header's History button (search, active / archived, rename, archive; a row goes back to the conversation). The first load of a browser session opens the drawer where it docks (from 1536px, never where it would float or fill the screen) on the latest active conversation or a new one, without focusing the composer; the state then lives in `sessionStorage` (`nocoproject:pm-drawer`), so once the member closes it, reloads keep it closed until a new session. A new conversation nobody has written in yet is not a record: reloading the page shows it again (empty), not the latest conversation, and only the very first load of a session picks the latest one. The app's query client defaults `placeholderData` to `keepPreviousData`, so hooks whose key can become "none" (`usePmConversationDetail`, `usePmConversationIssue`) opt out; otherwise the drawer keeps showing the conversation it just left (NP-201).

## 2. Lists and tables

- Toolbar on the left (search, filters, view switch — `IssueToolbar`), the primary button in the page header.
- Below `md` the toolbar folds the search and the filters behind one "Filters" button (showing the active count), collapsed on every visit; "Clear filters" and the view switch stay on its row, so the board or table keeps the height (NP-164).
- Creating issues is one "New issue" button and one dialog (`/issues/new`, `NewIssueButton`), never a split button: tabs AI draft (default; describe or paste, choose the project, "Draft issues" → batch entry's drafts table → create one or many) and Manual (the single-issue form); creating in either tab closes the dialog with a toast (NP-124). The last tab is remembered in `localStorage` (`nocoproject:new-issue-tab`, try/catch), `?tab=` overrides, `?batch=` holds the open draft batch and `?project=` preselects the project. Old batch-entry routes redirect into the AI tab. The manual form opens with "Or just tell the project manager", which closes the dialog and opens the drawer with the chosen project and whatever was typed.
- The board shows the design-first columns (Analysis, Proposal review) only while one holds an issue or a visible issue is design-first (`withoutIdleDesignColumns`).
- Lists are `DataTable`. Server-paged lists pass `pagination={false}` and put "Load more" under the table; client-paged lists keep `pageSize={20}`.
- Column widths go in `meta.className`: fixed widths for identifier, status, priority, people and dates; the title column `w-full max-w-0` with a single-line truncated cell capped at `max-w-[30rem]` and a `title` tooltip. One long title never stretches a table.
- Sortable headers use `DataTableColumnHeader`: a click cycles ascending → descending → unsorted, the icon shows the state, there is no menu on the header. Column hiding lives in `DataTableViewOptions`.
- `/issues` and `/my-issues` open on the board. The list / board choice is remembered per page in `localStorage` (`nocoproject:issues-view:<page>`, every access in try/catch); `?view=` overrides and is always written explicitly.
- `/runtimes` lists runtimes grouped under their computer (`GroupedDataTable`, one header row per daemon: credential name or device, online state, CLI, owner); its computer credentials are split into valid and a folded "Revoked (n)" table. `/agents` offers List / By computer (`nocoproject:agents-grouping` in `localStorage`, try/catch); agents without a visible runtime group last as "No computer" (NP-188).
- Loading: `NpListSkeleton` (or a skeleton shaped like the content). Empty: `NpEmpty` (icon, title, one sentence of fact, the create action). Failed: `NpLoadError` (retry, none on 403).

## 3. Detail pages

- A record's page is a covering `RouteChildPage`. The issue and knowledge details use `NpDetailLayout` (main column `flex-1 min-w-0`, side column fixed `20rem` holding small cards, sticky below the page header from `lg` up unless taller than the viewport, one column below `lg`); the project detail is a header, `NpTabBar` and the tab's content.
- **One scroll container.** The covering page scrolls as a whole; neither column scrolls on its own. The issue composer is `sticky bottom-0` inside the main column.
- The main column starts with `Breadcrumbs` and the record's `text-2xl` title, then one meta line (identifier, status, project, and `NpLiveRun` while a run is active). Blocks are bordered cards (`rounded-lg border bg-card p-4`) headed by `NpSectionHeading`, `space-y-6` apart.
- **Empty sections take no room.** No description is one muted row with "edit"; empty sub-issues fold into one dashed row with its actions; attachments (right under the description, NP-78), pull requests and dependencies render only with content or once revealed from the "Add" chips under the description; approvals and proposals render only when pending.
- Loading uses `NpDetailSkeleton`; 404/403 uses an error with "back to the list".

## 4. Decisions

- A decision is always shown with the thing being decided in full (`DecisionContent`: the agent's delivery comment and PR, the approval's from → to and requester, the proposals, the knowledge text with its diff, the design proposal in Markdown for `design_review`) and the actions right under it (`DecisionActionsBar`). Never a bare "accept".
- The inbox (`/inbox`) is master–detail: grouped list on the left (decisions first), the selected item's context under a sticky action bar on the right, `j` / `k` / `e` / Enter, `?tab=` / `?archived=1` / `?item=` in the URL, list → detail on narrow screens.
- The inbox reminder: the sidebar entry carries the count of decisions still waiting on the viewer (`GET /np/inbox/pending-count`, NP-107), and a short Web Audio chime plays when that count goes up after the first load (NP-108, `inbox/inbox-chime.ts`). The chime is on by default; each member turns it off for their account on `/profile` (NP-153, `pages/profile/chime-preference.tsx`, `GET`/`PATCH /np/me/preferences`) — a personal preference, not a workspace setting, so it lives outside `client/pages/np/`. There is no toggle on the inbox page itself. The browser needs one user gesture in the tab before it lets the chime sound, and it plays in only one tab at a time (Web Lock).
- The issue page shows the viewer's open decisions on that issue ("Waiting for you", `GET /np/inbox?kind=decision&resolved=false&issueId=`); a decided card folds into one line for the rest of the visit.
- Both run decisions through `useDecisionRunner` (optimistic resolve in every cached inbox list, toast, refetch on failure). Button hierarchy: the primary action is the one filled button and comes first; other requests outlined; rejection red; navigation (open, reassign) plain text. Type-specific wording goes in `np.decision.actions.<type>.<key>`.

## 5. Identifiers, tags, people, empty values

- Identifiers, slugs, versions, branches: `font-mono text-xs`.
- The process is marked only when it changes what happens next: `NpProcessBadge` ("Design first", blue, compass icon) beside the status in the issue header and on board cards, nothing for direct issues. Timeline comments that are a design proposal or a retrospective note carry `NpCommentTag` ("Proposal" / "Retrospective").
- Executor pickers (`NpExecutorSelect`) offer invokable agents with explicit `issue.execute` capability; legacy `kind` is display-only.
- Every tag is `NpTag` (tinted pill: pale background, darker text of the same hue, 12px, dot for statuses) with its tone from one map. Status: `NpStatusBadge` (tone by meaning via `statusTone`: unstarted grey, started blue, in review violet, blocked amber, done green, cancelled slate). Priority: `NpPriorityLabel` (urgent red, high orange, medium blue, low grey). Runs: `NpRunStatusBadge`. Labels: `NpLabelChip`. Never a solid fill, never a dot on a neutral pill, never the shadcn `Badge` on these pages.
- People, agents and the system: only `NpActorAvatar` (initials round / bot rounded-square in the agent hue / dashed cog; `live` for a working agent). `NpExecutor` builds on it.
- Long person and agent names never push or overlap their neighbours: in any bounded space (`NpActorAvatar showName`, `NpExecutor`, the `NpExecutorSelect` trigger) the name truncates and carries a `title` with the full name. A table cell gets a definite-width wrapper (`<div className='w-42'>` in a `w-48` column), because `max-w` on a cell of an auto-layout table is ignored. The executor picker's popup grows to fit the names, up to 24rem and never past the viewport (NP-143).
- Empty values (no priority, executor, owner, date, project) render a muted "—" with the word kept for screen readers. Editable controls keep their "none" option names in the list only.

## 6. Feedback and copy

- Every explicit write action toasts on success and on failure; failures are localized (`np.common.forbidden`, `np.common.requestFailed`, or a specific key for 409s).
- Inline property edits and emoji reactions change in place and toast only on failure.
- Destructive actions go through `AlertDialog` with a `destructive` action.
- A dialog with a form asks "Discard unsaved changes?" before closing (Escape, the backdrop, ×, Cancel) while the form holds input that has not been submitted (NP-200). The dialog calls `useUnsavedChangesGuard()` and renders `UnsavedChangesBoundary` around its forms (`client/components/unsaved-changes.tsx`); a `RouteDialog` returns `confirmDiscard()` from `beforeClose` after its submitting check, a dialog in component state closes through `useGuardedClose`. Each form reports `useUnsavedChanges(dirty)`, where dirty means a field differs from what the form opened with (text compared trimmed), and calls the returned `markSaved()` before closing after a successful submit. Browser back, switching the new-issue tabs and navigating away do not ask.
- UI text states facts and actions and never explains the UI: no "here you can…", "below is…", "decide it right here…". An empty state's sentence is a fact, not an instruction.

## 6a. Permissions

- A control the viewer may not use is hidden or disabled; the server refuses the same write on its own. Never decide it from `members.role` (only a projection of the business roles, NP-153).
- Settings items (`/config` tabs, `nocoproject.members` `assign` / `define-roles`, `nocoproject.github` `update`, ...) go through `useCan(settingsCheck(tab, action))` (`config/config-access.ts`).
- Business actions (close an issue, change its owner, manage or delete a project, manage an agent, ...) have a scope — `all`, `related` (NocoProject's own relation: owner, project lead, agent owner, creator) or `none` — that `useCan` cannot tell apart. Read it from `useWorkspaceViewer()` (`GET /np/me` `scopes`) with the rules in `permissions.ts`; a record's own `canEdit` from the server wins over them.
- `useWorkspaceViewer` refetches `/np/me` and the members when the authorization revision changes (`authorization:permissions-changed`), so buttons follow a role change without a reload, like the menu. Component tests mock `@nocobase/app-plugin-authorization/client` with `tests/components/np-authz-double.ts` (its `authzRevision.bump()` stands for that event).
- Project manager setup (NP-189): `/profile` holds "My project manager" (`pages/profile/pm-agent-section.tsx`: system default or one's own agent, copy from default, the personal choice hidden while `allowPersonal` is off, `PM_AGENT_NOT_ELIGIBLE` reasons in words) and "Always confirm first" (`pmConfirmAll`); `allowPersonal` is a switch in Settings → General's conversation entry, `pmAllowed` a switch in the `/runtimes` table for public runtimes (both need `nocoproject.general` `update`), and a `manager` agent's capability area is read-only (`PM_CAPABILITIES`).
- Business roles are edited only in `/config/members` (Roles, `config/role-editor.tsx`): pages, settings actions, and business actions with "NocoProject rules" (the action's own record access) or "All records". Only what `GET /np/access/catalog` offers is listed, and the page states that holding "Define roles" gives access to anything in NocoProject.

## 7. Colour, motion, themes

- Colours are tokens only. Neutrals, primary and charts come from the theme presets; NocoProject's own semantic colours (`--agent`, `--attention`, `--success`, `--np-tint-*` / `--np-ink-*`) live in `client/np-tones.css`. Accent (primary) only for primary actions, focus and live state; amber only for "needs you".
- Markdown (`NpMarkdown`) draws ` ```mermaid ` blocks as diagrams through `NpMermaid` (NP-167): mermaid is imported only when a diagram mounts, runs with `securityLevel: 'strict'` and no HTML labels, takes its palette from the tokens (converted from `oklch` to hex on a canvas, because mermaid cannot parse `oklch`) and redraws when the mode or preset changes; a diagram that does not parse stays code with one error line. Wide diagrams keep their natural size and scroll inside their frame. The Tiptap editor shows the source; only rendered Markdown draws.
- Motion explains change and respects reduced motion: realtime inbox arrivals slide in, resolved decisions dim, running work pulses (`NpPulse`, `np-live-ring`), progress rings animate.
- The project manager launchers (top bar button, mobile floating button) are the one element that moves on its own: `np-pm-launcher` (`client/styles.css`, NP-197) breathes in the primary → agent gradient (scale and a blurred glow, 3.6s, transform and opacity only), glows brighter while the drawer's conversation has a reply running, stops while the drawer is open, and is static under `prefers-reduced-motion`. Don't reuse it for anything else.

## 8. Keyboard

- `C` opens "New issue" (on `/issues` the create dialog beside the list), ignored while typing or when a dialog is open.
- `⌘K` / `Ctrl+K` opens the issue search; Enter opens the highlighted issue.
- `⌘J` / `Ctrl+J` opens the project manager drawer and focuses its composer, brings the focus into it when it is open, and closes it when the focus is already inside (also while typing); Escape restores an expanded drawer, then closes it.
- `⌘Enter` sends a comment, saves a knowledge document, sends an inline decision comment.
- In the inbox: `j` / `k` move, `e` archives, Enter opens the issue.

## 9. Long lists

- Cursor pages (`useInfiniteQuery`): the issue list, board columns ("load more" per column), older issue activities, the inbox groups.
- Virtualization (`react-virtuoso`): the activity timeline and board columns past 100 items (`NpVirtualList`), the issue table past 200 rows (`DataTable virtualizeAfter`), measured against the nearest scrolling ancestor.
- Query keys sit under the family the realtime topics invalidate (`npKeys.issues`, `npKeys.issue(id)`, `npKeys.inbox`).

## 10. Languages

- Every string is a key in `client/locales/` with `en-US` and `zh-CN`; `tests/logic/locale-coverage.test.ts` fails on a missing key. New groups go in the latest `np-*-en-US.ts` (today `np-iter4-en-US.ts`); a key inside an existing group goes into the file that defines that group, since the spread into `np` is shallow; avoid i18next plural suffixes.

## 11. Shell, screenshots and token inventory

NocoProject-specific reference material that doesn't belong in the two shared design docs because no other Solution needs it verbatim:

- **Shell**: brand mark, top bar (collapse toggle, workspace name, appearance, account) above a flat sidebar — Inbox → My issues → Work (issues, projects) → Agent team (agents, runtimes, skills, knowledge) → Reports → Settings. Top bar and sidebar keep the template's own sizes (`h-16`, `size-10` / `size-9` icon buttons); they are already sized for the compact preset, so they are not compressed further.
- **Screenshots**: 1360×900 desktop viewport, `../nocosolution/NocoProject/docs/design/screenshots/` holds the last reviewed baseline (compact · dark as the primary shot, plus a light and a default-preset counterpart per page: inbox, issue detail, project detail, board, issue list, knowledge, reports, settings). Day-to-day verification doesn't update that baseline — `pnpm build && pnpm screenshots` regenerates the same four combinations (compact/default × light/dark) into `output/screenshots/` from a throwaway local preview (`../nocosolution/NocoProject/docs/dogfooding.md` "see the result"); attach those to the delivery instead.
- **Token and file inventory**:
  - Theme presets (`client/theme/themes/{compact,default}.css`, identical except density): cool-toned neutrals, `--primary` indigo, `--chart-1..5` fixed hues, an independent sidebar background, selected nav text in the body color.
  - App semantic colours (`client/np-tones.css`): `--agent`, `--attention` / `--attention-foreground`, `--success`, `--np-tint-*` / `--np-ink-*` (eight hues), plus the `badge-text` and `np-live-ring` utilities (the latter in `client/styles.css`).
  - Flat sidebar sections: `client/layouts/components/navigation-sections.tsx` (the template's `navigation-tree.tsx` only gained the entry row styling and `relative`, and still owns the collapsible tree for Settings/Dev and for any group whose entry count needs it — see the best-practices doc §2.1 for when to switch).
