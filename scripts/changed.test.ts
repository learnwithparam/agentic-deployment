// Proves check:changed skips verify for a README-only diff and limits it to the changed step.
// It builds a throwaway git repo and reads the dry-run plan, so no real check runs.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "changed.ts");
const dir = mkdtempSync(join(tmpdir(), "changed-"));

function git(...args: string[]) {
  const done = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
  });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
}
function write(path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
function plan(): string {
  const env = { ...process.env };
  env.CHANGED_ROOT = dir;
  env.CHANGED_BASE = "main";
  const done = Bun.spawnSync(["bun", script, "--dry-run"], { cwd: dir, env });
  return done.stdout.toString();
}

test("README-only skips verify; a step change verifies that step only", () => {
  try {
    git("init", "-q", "-b", "main");
    write("README.md", "one\n");
    write("parts/01-a/01-run-it/problem/README.md", "one\n");
    write("parts/01-a/02-fix-it/problem/README.md", "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "work");

    write("README.md", "two\n");
    git("commit", "-qam", "readme");
    const readmeOnly = plan();
    expect(readmeOnly).toContain("SKIP  verify");
    expect(readmeOnly).not.toContain("RUN   verify");
    expect(readmeOnly).toContain("RUN   prose");

    write("parts/01-a/02-fix-it/problem/README.md", "two\n");
    git("commit", "-qam", "step");
    const stepChange = plan();
    expect(stepChange).toContain("RUN   verify fix-it");
    expect(stepChange).not.toContain("run-it");

    write("scripts/anything.ts", "export {};\n");
    git("add", ".");
    git("commit", "-qm", "scripts");
    expect(plan()).toContain("RUN   full check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
