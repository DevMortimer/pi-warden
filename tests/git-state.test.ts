import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { cleanHardReset, matchPatterns, safeLeasePush } from "../src/guard.js";

let repo: string;
let notRepo: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "pipe" });
const severity = (command: string, cwd: string, id: string) => matchPatterns("bash", { command }, cwd).find(hit => hit.id === id)?.severity;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "pi-warden-git-state-"));
  notRepo = await mkdtemp(join(tmpdir(), "pi-warden-no-git-"));
  git("init", "-q", "-b", "feature");
  git("config", "push.default", "simple");
  await writeFile(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "one");
  // A remote whose HEAD is `trunk`, set up from local refs only: no network.
  git("remote", "add", "origin", "https://example.invalid/repo.git");
  git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  git("update-ref", "refs/remotes/origin/feature", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
});
after(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(notRepo, { recursive: true, force: true });
});

test("git reset --hard warns on a clean tree and holds with uncommitted changes", async () => {
  assert.equal(cleanHardReset("git reset --hard HEAD~1", repo), true);
  assert.equal(severity("git reset --hard HEAD~1", repo, "git-reset-hard"), "risky");
  await writeFile(join(repo, "a.txt"), "changed\n");
  assert.equal(severity("git reset --hard HEAD~1", repo, "git-reset-hard"), "destructive");
  await writeFile(join(repo, "a.txt"), "one\n");
  await writeFile(join(repo, "new.txt"), "untracked\n");
  assert.equal(severity("git reset --hard", repo, "git-reset-hard"), "destructive", "an untracked file counts as a change");
  await rm(join(repo, "new.txt"));
  assert.equal(severity("git reset --hard", repo, "git-reset-hard"), "risky");
});

test("git reset --hard holds when the status check fails or the command is not plain", () => {
  assert.equal(severity("git reset --hard", notRepo, "git-reset-hard"), "destructive", "git status fails outside a repository");
  assert.equal(severity("git reset --hard", join(repo, "missing"), "git-reset-hard"), "destructive", "git status fails in a missing directory");
  assert.equal(matchPatterns("bash", { command: "git reset --hard" }).find(hit => hit.id === "git-reset-hard")?.severity, "destructive", "no cwd");
  for (const command of ["cd other && git reset --hard", "git reset --hard $REF", "git reset --hard; rm x"]) {
    assert.equal(severity(command, repo, "git-reset-hard"), "destructive", command);
  }
});

test("git reset --hard with -C, --git-dir, or --work-tree holds, even on a clean tree", () => {
  assert.equal(severity("git reset --hard", repo, "git-reset-hard"), "risky", "the tree is clean");
  const held = [
    `git -C ${repo} reset --hard`, "git -C . reset --hard HEAD~1", `git -C "${repo}" reset --hard`, "git --git-dir=.git reset --hard",
    "git --git-dir .git reset --hard", "git --work-tree=. reset --hard", "git --work-tree . --git-dir=.git reset --hard",
    "git -c core.quotepath=off reset --hard", "git --no-pager -C . reset --hard",
  ];
  for (const command of held) assert.equal(severity(command, repo, "git-reset-hard"), "destructive", command);
  for (const command of ["git -C . reset --soft HEAD~1", "git -C . log --oneline", "grep -rn \"git -C x reset --hard\" docs/"]) {
    assert.equal(severity(command, repo, "git-reset-hard"), undefined, command);
  }
});

test("git push --force and --force-with-lease with -C, --git-dir, or --work-tree hold", () => {
  assert.equal(severity("git push --force-with-lease origin feature", repo, "git-force-with-lease"), "risky", "the plain form warns");
  for (const options of [`-C ${repo}`, "-C .", `-C "${repo}"`, "--git-dir=.git", "--git-dir .git", "--work-tree=.", "-c push.default=simple", "--no-pager -C ."]) {
    const lease = `git ${options} push --force-with-lease origin feature`;
    assert.equal(severity(lease, repo, "git-force-with-lease"), "destructive", lease);
    for (const force of ["--force", "-f"]) {
      const command = `git ${options} push ${force} origin feature`;
      assert.equal(severity(command, repo, "git-force-push"), "destructive", command);
    }
  }
  for (const command of ["git -C . push origin feature", "git -C . log --force-with-lease", "grep -rn \"git -C x push --force\" docs/"]) {
    const ids = matchPatterns("bash", { command }, repo).map(hit => hit.id);
    assert.ok(!ids.includes("git-force-push") && !ids.includes("git-force-with-lease"), command);
  }
});

test("git push --force-with-lease warns only for a named or current branch that is not the default", () => {
  for (const command of ["git push --force-with-lease", "git push --force-with-lease origin feature", "git push --force-with-lease origin HEAD", "git push -u --force-with-lease origin feature", "git push --force-with-lease=feature origin HEAD:refs/heads/feature"]) {
    assert.equal(safeLeasePush(command, repo), true, command);
    assert.equal(severity(command, repo, "git-force-with-lease"), "risky", command);
  }
});

test("git push --force-with-lease holds for the default branch, a plain force, and a failed check", () => {
  const held = [
    "git push --force-with-lease origin main", "git push --force-with-lease origin master", "git push --force-with-lease origin trunk",
    "git push --force-with-lease origin feature:main", "git push --force-with-lease origin refs/heads/main",
    "git push --force --force-with-lease origin feature", "git push -f --force-with-lease origin feature", "git push -uf --force-with-lease origin feature",
    "git push --force-with-lease origin +feature", "git push --force-with-lease origin :feature", "git push --force-with-lease --all origin",
    "git push --force-with-lease --mirror origin", "git push --force-with-lease origin feature main", "git push --force-with-lease git@host:o/r.git feature",
    "git push --force-with-lease origin refs/tags/v1", "cd x && git push --force-with-lease origin feature",
  ];
  for (const command of held) assert.equal(severity(command, repo, "git-force-with-lease"), "destructive", command);
  assert.equal(severity("git push --force-with-lease origin feature", notRepo, "git-force-with-lease"), "destructive", "the remote check fails outside a repository");
  assert.equal(matchPatterns("bash", { command: "git push --force-with-lease origin feature" }).find(hit => hit.id === "git-force-with-lease")?.severity, "destructive", "no cwd");
});

test("a bare lease push holds when the current branch tracks the default branch or push.default is matching", () => {
  git("config", "push.default", "matching");
  assert.equal(safeLeasePush("git push --force-with-lease", repo), false);
  git("config", "push.default", "upstream");
  git("config", "branch.feature.remote", "origin");
  git("config", "branch.feature.merge", "refs/heads/trunk");
  assert.equal(safeLeasePush("git push --force-with-lease", repo), false, "the upstream is the remote HEAD branch");
  git("config", "branch.feature.merge", "refs/heads/feature");
  assert.equal(safeLeasePush("git push --force-with-lease", repo), true);
  git("config", "push.default", "simple");
  git("checkout", "-q", "--detach");
  assert.equal(safeLeasePush("git push --force-with-lease", repo), false, "a detached HEAD has no current branch");
  assert.equal(safeLeasePush("git push --force-with-lease origin HEAD", repo), false);
  git("checkout", "-q", "feature");
});
