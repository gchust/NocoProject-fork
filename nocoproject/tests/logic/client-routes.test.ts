import {
  resolveAppClientContributions,
  type AppClientRegisteredRoute,
  type AppClientRouteComponentLoader,
} from '@nocobase/app-client/plugins';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import applicationRoutes from '../../client/routes.ts';

// The reference-page scan below reads application source from disk, so its root comes from this file's own URL — taken
// apart rather than written as `new URL('..', import.meta.url)`, the idiom the other tests use, because Vite rewrites
// that pattern into an asset URL in the jsdom environment this file shares with the page tests.
const applicationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const clientRoot = path.join(applicationRoot, 'client');
const referenceRoot = path.join(clientRoot, 'pages', 'reference');

describe('app client routes', () => {
  it('keeps the landing page and the authentication pages', () => {
    // The authentication plugin and this application have to agree on these paths: it sends an unknown visitor to
    // /login, sends a signed-in user who opens a guest page back to /, and mails a reset link to /reset-password,
    // while the sign-in form links to /register and /forgot-password. Only their presence is asserted, so a page the
    // application adds is not a defect. Whether these four are guest pages is not checked here either: app-client
    // refuses any route that claims one of those paths without `auth: 'guest'`.
    expect(pagePaths(resolveRoutes().routes)).toEqual(
      expect.arrayContaining([
        '/',
        '/login',
        '/register',
        '/forgot-password',
        '/reset-password',
      ]),
    );
  });

  it('loads every page component', async () => {
    const resolved = resolveRoutes();
    const loaders = [
      ...componentLoadersIn(resolved.routes),
      ...componentLoadersIn(resolved.settingsRouteTree),
      ...componentLoadersIn(resolved.devRouteTree),
    ];
    // The trees above are filtered by loader, so an empty list would make the loop below pass without loading
    // anything at all.
    expect(loaders).not.toHaveLength(0);

    for (const componentLoader of loaders) {
      // The registered loader is already the wrapped one, so awaiting it holds every page to the contract that its
      // module default-exports a component. A page that moved or lost its default export fails here.
      await expect(componentLoader()).resolves.toMatchObject({
        default: expect.any(Function),
      });
    }
  });

  it('never imports or routes a reference page', () => {
    // The reference pages are worked source to read while building a page, not screens this application serves. A
    // route reaches one through an `import()` its page loader names, so scanning specifiers catches the route as well
    // as the plain import. Reaching into the directory at all fails: a shadcn gallery inside somebody's product is
    // the defect this pins.
    const offenders: string[] = [];
    for (const file of clientSourceFiles()) {
      for (const specifier of moduleSpecifiersIn(file)) {
        const referencePage = specifierPathsIn(specifier, file).find(
          isReferencePage,
        );
        if (referencePage) {
          offenders.push(
            `${path.relative(applicationRoot, file)} names "${specifier}", which resolves to ` +
              `${path.relative(applicationRoot, referencePage)}`,
          );
        }
      }
    }

    expect(
      offenders,
      'Application source reaches into client/pages/reference/, which is not part of the running application.',
    ).toEqual([]);
  });

  it('pins the route names page grants are stored against', () => {
    // A route's `name` is the identifier a stored page grant records. Renaming one is a data change that has to
    // migrate the grants that name it, not a refactor — so changing this list deliberately is the point. A new page
    // that requires sign-in adds an entry here, because that is a new grant somebody has to be given.
    const resolved = resolveRoutes();

    // The landing page opted out of page authorization, so it is reachable by every signed-in user. The NocoProject
    // pages each check their own page grant; their overlays and the issue detail inherit it.
    expect(pageAuthorizations(resolved.routes)).toEqual([
      { name: 'home', authorizedAs: null },
      { name: 'profile', authorizedAs: null },
      { name: 'np-pm-conversation', authorizedAs: 'np-pm' },
      // Iteration 2's standalone pages are redirects now (no menu entry, so they sort before the ordered menu); the
      // page they forward to checks its own grant.
      { name: 'np-intake-redirect', authorizedAs: null },
      { name: 'np-usage-redirect', authorizedAs: null },
      { name: 'np-inbox', authorizedAs: 'np-inbox' },
      { name: 'np-approvals', authorizedAs: 'np-inbox' },
      { name: 'np-my-issues', authorizedAs: 'np-my-issues' },
      { name: 'np-my-issues-owned', authorizedAs: 'np-my-issues' },
      { name: 'np-my-issues-executing', authorizedAs: 'np-my-issues' },
      { name: 'np-pm', authorizedAs: 'np-pm' },
      { name: 'np-issues', authorizedAs: 'np-issues' },
      { name: 'np-issue-new', authorizedAs: 'np-issues' },
      { name: 'np-issue-intake', authorizedAs: 'np-issues' },
      { name: 'np-issue-detail', authorizedAs: 'np-issues' },
      { name: 'np-run-transcript', authorizedAs: 'np-issues' },
      { name: 'np-subtask-new', authorizedAs: 'np-issues' },
      { name: 'np-projects', authorizedAs: 'np-projects' },
      { name: 'np-project-new', authorizedAs: 'np-projects' },
      { name: 'np-project-detail', authorizedAs: 'np-projects' },
      { name: 'np-project-resource-new', authorizedAs: 'np-projects' },
      { name: 'np-project-intake', authorizedAs: 'np-projects' },
      { name: 'np-agents', authorizedAs: 'np-agents' },
      { name: 'np-agent-new', authorizedAs: 'np-agents' },
      { name: 'np-agent-detail', authorizedAs: 'np-agents' },
      { name: 'np-runtimes', authorizedAs: 'np-runtimes' },
      { name: 'np-runtime-connect', authorizedAs: 'np-runtimes' },
      { name: 'np-skills', authorizedAs: 'np-skills' },
      { name: 'np-skill-new', authorizedAs: 'np-skills' },
      { name: 'np-skill-detail', authorizedAs: 'np-skills' },
      { name: 'np-knowledge', authorizedAs: 'np-knowledge' },
      { name: 'np-knowledge-new', authorizedAs: 'np-knowledge' },
      { name: 'np-knowledge-detail', authorizedAs: 'np-knowledge' },
      { name: 'np-reports', authorizedAs: 'np-reports' },
      { name: 'np-reports-metrics', authorizedAs: 'np-reports' },
      { name: 'np-reports-usage', authorizedAs: 'np-reports' },
      { name: 'np-config', authorizedAs: 'np-config' },
      // NP-117: each settings tab checks its own settings item (under the page grant np-config).
      {
        name: 'np-config-general',
        authorizedAs: 'settings:nocoproject.general',
      },
      {
        name: 'np-config-members',
        authorizedAs: 'settings:nocoproject.members',
      },
      {
        name: 'np-config-member-role',
        authorizedAs: 'settings:nocoproject.members',
      },
      {
        name: 'np-config-workflows',
        authorizedAs: 'settings:nocoproject.workflows',
      },
      {
        name: 'np-config-workflow-detail',
        authorizedAs: 'settings:nocoproject.workflows',
      },
      {
        name: 'np-config-labels',
        authorizedAs: 'settings:nocoproject.labels',
      },
      {
        name: 'np-config-github',
        authorizedAs: 'settings:nocoproject.github',
      },
    ]);
  });

  it('groups the NocoProject menu as the product plan §3.1 lays it out', () => {
    // Iteration 3 §G: Inbox and My issues on top — with Project manager under them since iteration 4 §C — the Work and
    // Agent team groups, then Reports and Settings, in that order.
    expect(menuTree(resolveRoutes().routes)).toEqual([
      'navigation.inbox',
      'navigation.myIssues',
      'navigation.pm',
      {
        group: 'navigation.work',
        items: ['navigation.issues', 'navigation.projects'],
      },
      {
        group: 'navigation.agentTeam',
        items: [
          'navigation.agents',
          'navigation.runtimes',
          'navigation.skills',
          'navigation.knowledge',
        ],
      },
      'navigation.reports',
      'navigation.config',
    ]);
  });

  it('registers no NocoProject page in the system settings shell', () => {
    // Iteration 3 §G: members, GitHub and the NocoProject settings moved to /config; `defineSettingsRoutes` is gone.
    expect(settingsAuthorizations(resolveRoutes().settingsRouteTree)).toEqual(
      [],
    );
  });

  it('keeps the old standalone pages reachable as redirects without a menu entry', () => {
    const resolved = resolveRoutes();
    const flat = flatten(resolved.routes);
    for (const path of ['/intake', '/usage', '/inbox/approvals']) {
      const route = flat.find((candidate) => candidate.path === path);
      expect(route?.path).toBe(path);
      expect(route?.navigation).toBeUndefined();
    }
    expect(flat.find((route) => route.path === '/issues/intake')).toBeDefined();
    expect(
      flat.find((route) => route.path === '/projects/:projectId/intake'),
    ).toBeDefined();
  });

  it('turns batch entry into redirects to the new issue dialog', async () => {
    // Iteration 4 §D: one "New issue" dialog creates one issue or many; the iteration 3 drawer routes keep their names
    // (and grants) but load the redirect that /intake loads, and nothing is in the menu for batch entry.
    const flat = flatten(resolveRoutes().routes);
    const loaded = async (path: string) =>
      (await flat.find((route) => route.path === path)?.componentLoader?.())
        ?.default;
    const redirect = await loaded('/intake');
    expect(redirect).toEqual(expect.any(Function));
    expect(await loaded('/issues/intake')).toBe(redirect);
    expect(await loaded('/projects/:projectId/intake')).toBe(redirect);
    expect(await loaded('/issues/new')).not.toBe(redirect);
    for (const path of ['/issues/intake', '/projects/:projectId/intake']) {
      expect(
        flat.find((route) => route.path === path)?.navigation,
      ).toBeUndefined();
    }
  });

  it('adds the project manager page under my issues', () => {
    const route = flatten(resolveRoutes().routes).find(
      (candidate) => candidate.name === 'np-pm',
    );
    expect(route?.path).toBe('/pm');
    expect(route?.navigation?.title).toBe('navigation.pm');
  });
});

type MenuNode = string | { readonly group: string; readonly items: MenuNode[] };

/** The menu as titles, in the order the sidebar shows them (by `navigation.order`, then registration). */
function menuTree(routes: readonly AppClientRegisteredRoute[]): MenuNode[] {
  return [...routes]
    .filter((route) => route.navigation)
    .sort((a, b) => (a.navigation?.order ?? 0) - (b.navigation?.order ?? 0))
    .map((route): MenuNode => {
      const title = String(route.navigation?.title);
      const children = (route.children ?? []).filter(
        (child) => child.navigation,
      );
      return route.componentLoader || children.length === 0
        ? title
        : { group: title, items: menuTree(children) };
    });
}

function flatten(
  routes: readonly AppClientRegisteredRoute[],
): AppClientRegisteredRoute[] {
  return routes.flatMap((route) => [route, ...flatten(route.children ?? [])]);
}

/** This application's own contribution, registered the way the client runtime registers it. */
function resolveRoutes() {
  return resolveAppClientContributions([
    {
      packageName: '@nocobase/app-template-default',
      routes: applicationRoutes,
      source: 'application',
    },
  ]);
}

/**
 * The paths of the pages a route tree registers. A menu group names no component, so it carries no path of its own
 * and inherits its parent's — filtering on `componentLoader` is what keeps that inherited path out of the list.
 */
function pagePaths(routes: readonly AppClientRegisteredRoute[]): string[] {
  return routes.flatMap((route) => [
    ...(route.componentLoader ? [route.path] : []),
    ...pagePaths(route.children ?? []),
  ]);
}

/** Every page loader in a tree, at any depth. */
function componentLoadersIn(
  routes: readonly AppClientRegisteredRoute[],
): AppClientRouteComponentLoader[] {
  return routes.flatMap((route) => [
    ...(route.componentLoader ? [route.componentLoader] : []),
    ...componentLoadersIn(route.children ?? []),
  ]);
}

/** Every client source file outside `client/pages/reference/`, where the reference pages legitimately name each other. */
function clientSourceFiles(): string[] {
  return readdirSync(clientRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /[.]tsx?$/u.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !isReferencePage(file))
    .sort();
}

/**
 * Every module specifier a client source file names, however it reaches one: a static or side-effect import, a
 * re-export, a dynamic `import()`, or an `import.meta.glob()` pattern. TypeScript reads the file rather than a regular
 * expression because a specifier inside a comment or an ordinary string is not a dependency, and this check must not
 * fail on prose about one.
 */
function moduleSpecifiersIn(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifiers.push(...literalSpecifiers(first));
      } else if (isImportMetaGlob(node.expression)) {
        specifiers.push(...literalSpecifiers(first));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return specifiers;
}

function isImportMetaGlob(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'glob' &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/** A glob takes one pattern or a list of them. Whatever cannot be read statically names no path this check can judge. */
function literalSpecifiers(argument: ts.Expression | undefined): string[] {
  if (!argument) {
    return [];
  }
  if (ts.isArrayLiteralExpression(argument)) {
    return argument.elements.flatMap((element) => literalSpecifiers(element));
  }
  if (ts.isStringLiteralLike(argument)) {
    return [argument.text];
  }
  // A template literal knows its own head: what it interpolates is a runtime choice, but the directory it starts in
  // is already written down.
  if (ts.isTemplateExpression(argument)) {
    return [argument.head.text];
  }
  return [];
}

/**
 * The absolute paths a specifier could name. A bare package specifier resolves into node_modules and names no
 * application source, so it has none.
 */
function specifierPathsIn(specifier: string, fromFile: string): string[] {
  if (specifier.startsWith('.')) {
    return [path.resolve(path.dirname(fromFile), specifier)];
  }
  // `@/` is the client alias in vite.config.ts.
  if (specifier.startsWith('@/')) {
    return [path.join(clientRoot, specifier.slice('@/'.length))];
  }
  if (specifier.startsWith('/')) {
    // Vite resolves a leading `/` from the client root, which is this application's Vite root, while a reader is at
    // least as likely to mean the application root. Both readings name a real file, so both are checked.
    return [
      path.join(clientRoot, specifier),
      path.join(applicationRoot, specifier),
    ];
  }
  return [];
}

/** Whether a path is `client/pages/reference/` itself or something under it. */
function isReferencePage(candidate: string): boolean {
  const relative = path.relative(referenceRoot, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** Settings authorization of every settings page in the tree, at any depth. */
function settingsAuthorizations(
  routes: readonly AppClientRegisteredRoute[],
): { name: string; authorizedAs: string | null }[] {
  return routes.flatMap((route) => [
    ...(route.componentLoader &&
    route.authz !== 'skip' &&
    route.authz !== 'unrestricted'
      ? [
          {
            name: route.name,
            authorizedAs: `${route.authz.resource.type}:${route.authz.resource.id}`,
          },
        ]
      : []),
    ...settingsAuthorizations(route.children ?? []),
  ]);
}

/** Page authorization comes directly from the registered tree. */
function pageAuthorizations(
  routes: readonly AppClientRegisteredRoute[],
): { name: string; authorizedAs: string | null }[] {
  return routes.flatMap((route) => [
    ...(route.componentLoader && route.auth === 'required'
      ? [
          {
            name: route.name,
            authorizedAs:
              route.authz === 'skip'
                ? null
                : route.authz === 'unrestricted'
                  ? 'unrestricted'
                  : route.authz.resource.type === 'page'
                    ? route.authz.resource.id
                    : `${route.authz.resource.type}:${route.authz.resource.id}`,
          },
        ]
      : []),
    ...pageAuthorizations(route.children ?? []),
  ]);
}
