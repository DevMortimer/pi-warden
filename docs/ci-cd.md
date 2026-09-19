# CI and continuous delivery

The `CI` workflow runs for pull requests to `main`, pushes to `main`, `v*` tags,
and manual runs from the Actions page. It does not publish to npm.

## Checks

- **Workflow lint** runs actionlint, including its shell checks.
- **Check (Node 22.19.0)** tests the minimum supported Node version.
- **Check (Node 24)** and **Check (Node 26)** test the newer supported releases.
- Each Node job installs the lockfile with `npm ci`, then runs `npm run check`
  (typecheck, offline tests, build).
- **Package** runs only after all checks pass. It builds an npm tarball, installs
  it in a clean directory with the Pi peer versions from the lockfile and install
  scripts disabled, imports the library and extension, and checks that the public
  JavaScript, type declarations, and Pi entry point are present.

The package smoke test covers the Pi-host environment. Standalone use without
Pi peers is not covered: the existing library entry point imports `pi-tui` through
its widget module even though that peer is marked optional. This workflow does
not change that runtime dependency.

Successful runs retain an `npm-package` artifact for 14 days. It contains the
npm tarball and `SHA256SUMS`. Tag runs also include the version's changelog notes.
To require CI before merging, select all five check names above in the GitHub
branch rules for `main`; requiring only **Package** is not sufficient because a
failed prerequisite causes that job to be skipped. This PR does not change
repository branch rules.

No TypeSafe credentials are needed. Live tests, calibration scripts, and
benchmarks are not run. Action references use full commit SHAs; update each SHA
and its version comment together when upgrading an action.

## Release delivery

A `vX.Y.Z` tag runs the same checks and packaging. Before building a release
package, the workflow requires:

1. The tagged commit is an ancestor of `origin/main`.
2. `package.json` has a stable `X.Y.Z` version, and the tag is exactly `vX.Y.Z`.
3. `CHANGELOG.md` has a nonempty section headed `## X.Y.Z`.

After these checks pass, **Draft release** downloads that run's artifact,
verifies its checksum, and creates a draft GitHub release. The draft has the
changelog notes, npm tarball, and checksum file. It is not published automatically.
A branch or pull-request run cannot create a release.

Only the draft-release job has `contents: write`; it uses the built-in GitHub
token and does not check out or execute repository code. Other jobs have read-only
repository access, and checkout does not retain credentials. No npm token or
additional repository secret is required.

An existing release for the tag makes draft creation fail instead of overwriting
it. If a run fails after creating a draft, inspect that draft and its assets before
retrying; a maintainer must resolve the existing draft explicitly.

## Maintainer release steps

Keep the existing manual npm publication process:

1. Put feature and fix notes under `## Unreleased` during development.
2. Make the last commit on the PR the version bump: change only `package.json`
   and `CHANGELOG.md`, move the notes under `## X.Y.Z`, and leave `## Unreleased`
   at the top. Use `chore: version bump to X.Y.Z` as the commit message.
3. After approval and passing CI, squash-merge the PR on GitHub. If `main` gained
   a version bump during development, update the branch and give this change its
   own version before merging.
4. Pull the merged `main`, run `npm ci` and `npm run check`, and run `npm publish`
   manually with maintainer credentials.
5. Create and push the matching tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. Wait for the tag's `CI` run, review the draft and its assets, then publish the
   GitHub release manually.

Merging this workflow does not publish a package, push a tag, or publish a GitHub
release. A manual workflow run on a branch is a check-and-package run, not a
publication command.
