# Fork maintenance

This repository (`gchust/NocoProject-fork`) is a fork of `nocobase/NocoProject`. Changes are never pushed to upstream.

## Branches

- `main` mirrors upstream `main` exactly. Nothing is committed to it. A ruleset blocks deleting it and any push that is
  not a fast-forward.
- `custom/main` is the default branch. The fork's own changes are committed here, or on short-lived branches cut from it
  and merged back.

## Upstream sync

`.github/workflows/upstream-sync.yml` runs every three hours and on demand (Actions → Upstream sync → Run workflow):

1. It fast-forwards `main` to upstream `main`. If `main` holds a commit upstream does not have, the run fails instead of
   overwriting it.
2. If `custom/main` does not contain the new upstream head yet, it opens (or updates) a pull request from `main` into
   `custom/main` and merges it with a merge commit when there are no conflicts. A conflicting pull request stays open;
   resolve it locally:

   ```bash
   git switch main && git pull            # pull from upstream
   git switch custom/main && git merge main
   git push
   ```

The workflow uses `GITHUB_TOKEN`, which cannot push changes to files under `.github/workflows/`. When upstream changes
a workflow the mirror step fails; add a fine-grained token with Contents, Pull requests and Workflows write access on
this fork as the `SYNC_TOKEN` secret to let it through. Pushes made with that token trigger upstream's CI on `main`,
whose deploy job then fails for lack of upstream's secrets; that failure does not deploy anything.

## Local setup

```bash
git remote rename origin upstream          # in a clone of nocobase/NocoProject
git remote set-url --push upstream DISABLED-do-not-push-upstream
git remote add origin git@github.com:gchust/NocoProject-fork.git
git fetch origin && git switch custom/main
```

## Deploying

`cd nocoproject && NP_DEPLOY_HOST=<ssh host> pnpm deploy:server` builds the checkout and deploys it to a server set up
as described in `nocoproject/scripts/server/np-deploy`. Deploy from `custom/main`.
