// .gitignore must keep every local relay config folder out of git, not only one name.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const ROOT = realpathSync(new URL("..", import.meta.url).pathname);

function checkIgnore(path: string) {
  return spawnSync("git", ["check-ignore", "-v", "--", path], { cwd: ROOT, encoding: "utf8" });
}

describe(".gitignore", () => {
  it("ignores .relay-local/ and any .relay-<name>/ folder", () => {
    for (const path of [".relay-local/", ".relay-local/wrangler.toml", ".relay-foo/wrangler.toml"]) {
      const r = checkIgnore(path);
      expect(r.status, path).toBe(0);
      expect(r.stdout, path).toContain(".relay-*/");
    }
    const kept = checkIgnore("wrangler.toml");
    expect(kept.status).toBe(1);
  });
});
