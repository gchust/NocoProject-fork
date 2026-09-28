// Pre-cutover guard (nocoproject/docs/phase1/workspace.md): a root `pnpm install` would move nocoproject/node_modules
// into a root virtual store while the dev server runs from it, and the nested pnpm-workspace.yaml files would make Vite
// refuse to serve the relinked dependencies. readPackage runs only while resolving, so root `pnpm run` scripts still
// work. Delete this file as part of the cutover (or set NOCOPROJECT_WORKSPACE_CUTOVER=1 for a deliberate trial).
function guard() {
  if (process.env.NOCOPROJECT_WORKSPACE_CUTOVER === '1') return;
  throw new Error(
    'Root `pnpm install` is disabled until the workspace cutover (nocoproject/docs/phase1/workspace.md). ' +
      'Install inside nocoproject/ or nocoproject-cli/ instead.',
  );
}

module.exports = {
  hooks: {
    readPackage(pkg) {
      guard();
      return pkg;
    },
  },
};
