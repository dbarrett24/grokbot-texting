// The glass border is darker than theme-system's published primary so the switch outline stays visible.
// --check fails when the generator and src/harbor.css disagree, including a revert to #56708f.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("harbor token generator", () => {
  it("emits the contrast border and matches src/harbor.css", () => {
    const stdout = execFileSync(process.execPath, ["scripts/harbor-tokens.mjs", "--check"], { encoding: "utf8", cwd: ROOT });
    expect(stdout).toContain("harbor tokens: in sync");
  });
});
