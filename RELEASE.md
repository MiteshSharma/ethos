# Releasing Ethos

How to ship a new version of the public `@ethosagent/*` packages to npm.

> **v1 is manual.** No CI auto-publish — the maintainer runs `make release` from their local machine using the `ethos.ai` npm account, which is already a member of the `@ethosagent` org. CI auto-publish is a follow-up phase.

## What gets published

Five packages publish in lockstep (all share the same version, applied uniformly by `make version-*`):

| Package | Source | Audience |
|---|---|---|
| `@ethosagent/cli` | `apps/ethos/` | end users — the `ethos` binary |
| `@ethosagent/types` | `packages/types/` | plugin authors — interface contracts |
| `@ethosagent/core` | `packages/core/` | plugin authors + advanced embedders |
| `@ethosagent/plugin-sdk` | `packages/plugin-sdk/` | plugin authors |
| `@ethosagent/plugin-contract` | `packages/plugin-contract/` | marketplace + plugin authors |

Everything else (`extensions/*`, `apps/{tui,vscode-extension,web}`, `packages/agent-bridge`, `plugins/example-*`) is `"private": true` and bundled into the cli tarball at build time. None of those publish.

## Prerequisites — first time only

```bash
# 1. Confirm Node 24
node --version    # must be v24.x

# 2. Log in to npm as a member of the @ethosagent org
npm login
npm whoami        # should print: ethos.ai (or another @ethosagent member)
npm org ls @ethosagent    # confirms membership
```

If `npm whoami` doesn't show a member of the `@ethosagent` org, ask an existing maintainer to add you (`npm org set @ethosagent <username> developer`).

## The one-command release

For a routine patch release (most common):

```bash
make release
```

That's it. The target:

1. Verifies the working tree is clean
2. Bumps the patch version on all five public packages
3. Shows you the diff and waits for confirmation
4. Builds all five `dist/` outputs
5. Publishes to npm (skips packages whose version didn't change)
6. Commits the version bump as `release: v0.x.y`
7. Tags `v0.x.y` and pushes main + tag

For a minor or major release:

```bash
make release-minor    # 0.1.0 → 0.2.0
make release-major    # 0.1.0 → 1.0.0
```

You'll see this confirmation gate before any side effects beyond the version bump:

```
Version bumped to: v0.1.1

Diff:
 apps/ethos/package.json                  | 2 +-
 packages/core/package.json               | 2 +-
 packages/plugin-contract/package.json    | 2 +-
 packages/plugin-sdk/package.json         | 2 +-
 packages/types/package.json              | 2 +-

Continue with build + publish + tag + push? [y/N]
```

Answer `n` (or anything other than `y`) and run `git checkout .` to revert.

## Granular targets (when you want manual control)

If you want to break the flow into pieces — for example, to inspect the build output before publishing, or to amend the version bump commit message — use the building-block targets:

```bash
# 1. Bump versions (patch / minor / major)
make version-patch

# 2. Review the diff, commit
git diff --stat
git add .
git commit -m "release: v0.x.y"

# 3. Build all five public packages
make build-publishable

# 4. Publish to npm (skips up-to-date packages automatically)
make publish

# 5. Tag and push
git tag "v$(node -p "require('./apps/ethos/package.json').version")"
git push --follow-tags
```

## Dry run

To see what would publish without actually publishing:

```bash
make publish-dry
```

Output looks like:

```
Dry run — packages that would be published:
  ✓  @ethosagent/types@0.1.0 — up to date
  ✓  @ethosagent/core@0.1.0 — up to date
  ✓  @ethosagent/plugin-contract@0.1.0 — up to date
  ✓  @ethosagent/plugin-sdk@0.1.0 — up to date
  →  @ethosagent/cli@0.1.0  (npm has: unpublished)  ← would publish
```

The `→` lines are the ones that need publishing. The `✓` lines are already on npm at the matching version.

## Verification — after publish

```bash
# All 5 packages on npm at the new version?
for pkg in cli types core plugin-sdk plugin-contract; do
  npm view "@ethosagent/$pkg" version
done

# Install on a fresh prefix to confirm the cli works
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
echo '{"name":"verify"}' > package.json
npm install @ethosagent/cli@latest
./node_modules/.bin/ethos --version    # should print the new version
```

## Common issues

**`401 Unauthorized` on publish.** Run `npm login` again. The session token may have expired.

**`403 Forbidden` on a specific package.** You're not on the org with publish access for that package. Ask an existing maintainer to add you (`npm org set @ethosagent <username> developer`).

**`make release` fails midway through publish.** npm doesn't support transactions — some of the five packages may have published, others not. The `make publish` target is idempotent: re-running it skips packages that already published at the new version and only retries the missing ones. So:

```bash
make publish    # picks up where the failed run left off
```

If the failure is due to your local being dirty (rare since `release` checks first), `git diff` will show why. Fix and re-run.

**Published the wrong thing.** npm allows unpublishing within 72 hours: `npm unpublish @ethosagent/cli@0.x.y`. After 72 hours, the version is locked forever — ship a fix as the next version.

**Forgot to `make build-publishable` between version-bump and publish.** The `make publish` target builds first via its dependency on `build-publishable`, so this can't happen in the standard flow. If you ran a custom flow and skipped the build, the published tarball ships stale `dist/`. Recover by bumping again and re-publishing.

**`make release` says "working tree is dirty".** Commit or stash your unstaged changes before running release. Releases require a clean tree so the version-bump commit is the only thing in the release commit.

## Quick reference

```bash
# routine patch (most common)
make release

# minor or major release
make release-minor
make release-major

# preview without publishing
make publish-dry

# break the flow apart manually
make version-patch && git commit -am "release: v0.x.y" && make publish && git tag v0.x.y && git push --follow-tags

# verify
npm view @ethosagent/cli version
```

## CI auto-publish (future)

When release cadence picks up, `make release` gets replaced with a GitHub Actions workflow that:
1. Watches for tag pushes (`v*`)
2. Runs `make build-publishable`
3. Publishes via `make publish` using an `NPM_TOKEN` org-scoped publish secret
4. Skips republish for packages whose version didn't change (already idempotent)

Tracked under Phase 29 follow-ups, not in v1.
