// The wrangler asset-rule check: harbor CSS/font/photos fail the build when [[rules]] is missing,
// and a config in a subfolder must point main at src/index.ts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { configProblems, filesToCheck, rulesProblems } from "../scripts/check-wrangler-assets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test-node", "fixtures", "wrangler");
const read = (name: string) => readFileSync(join(FIX, name), "utf8");

function run(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/check-wrangler-assets.mjs", ...args], { encoding: "utf8", cwd: ROOT });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

/** The Step 2 example, as a new user would paste it into .relay-local/wrangler.toml. */
function step2Example(): string {
  const doc = readFileSync(join(ROOT, "docs", "SETUP.md"), "utf8");
  const start = doc.indexOf("cat > .relay-local/wrangler.toml << 'EOF'\n");
  const from = start + "cat > .relay-local/wrangler.toml << 'EOF'\n".length;
  const end = doc.indexOf("\nEOF\n", from);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(from);
  return doc.slice(from, end + 1);
}

describe("wrangler asset rules", () => {
  it("accepts the committed template and a fixture that has both rules", () => {
    expect(rulesProblems(readFileSync(join(ROOT, "wrangler.toml"), "utf8"))).toEqual([]);
    expect(configProblems(join(FIX, "rules-present.toml"), ROOT)).toEqual([]);
  });

  it("fails when either rule is missing or wrong", () => {
    const missing = configProblems(join(FIX, "rules-missing.toml"), ROOT);
    expect(missing.some((p: string) => p.startsWith("missing Text rule"))).toBe(true);
    expect(missing.some((p: string) => p.startsWith("missing Data rule"))).toBe(true);
    const textOnly = read("rules-present.toml").replace(/\[\[rules\]\]\ntype = "Text"[\s\S]*?fallthrough = false\n\n/, "");
    expect(rulesProblems(textOnly).some((p: string) => p.startsWith("missing Text rule"))).toBe(true);
    expect(rulesProblems(textOnly).some((p: string) => p.includes("Data"))).toBe(false);
    const dataOnly = read("rules-present.toml").replace(/\[\[rules\]\]\ntype = "Data"[\s\S]*?fallthrough = false\n/, "");
    expect(rulesProblems(dataOnly).some((p: string) => p.startsWith("missing Data rule"))).toBe(true);
    expect(rulesProblems(dataOnly).some((p: string) => p.includes("Text"))).toBe(false);
    const open = read("rules-present.toml").replace("fallthrough = false\n\n[[rules]]\ntype = \"Data\"", "fallthrough = true\n\n[[rules]]\ntype = \"Data\"");
    expect(rulesProblems(open).some((p: string) => p.includes("Text rule is wrong") && p.includes("fallthrough = true"))).toBe(true);
  });

  it("fails when main does not resolve to src/index.ts", () => {
    const problems = configProblems(join(FIX, "wrong-main.toml"), ROOT);
    expect(problems).toEqual(['main = "../../../src/relay.ts" resolves to src/relay.ts, not src/index.ts']);
  });
});

describe("check CLI", () => {
  it("passes the repo template and the rules-present fixture", () => {
    const ok = run([]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("check-wrangler: OK (wrangler.toml");
    const present = run(["--config", "test-node/fixtures/wrangler/rules-present.toml"]);
    expect(present.status).toBe(0);
    expect(present.stdout).toContain("rules-present.toml");
  });

  it("fails a config with no rules, and a config whose main is wrong", () => {
    const missing = run(["--config=test-node/fixtures/wrangler/rules-missing.toml"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("missing Text rule");
    expect(missing.stderr).toContain("missing Data rule");
    expect(missing.stderr).toContain('globs = ["**/*.css"]');
    expect(missing.stderr).toContain('globs = ["**/*.woff2", "**/*.webp"]');
    expect(missing.stderr).toContain("check-wrangler: FAIL");
    const wrong = run(["--config=test-node/fixtures/wrangler/wrong-main.toml"]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("not src/index.ts");
  });

  it("checks .relay-local/wrangler.toml only when that file is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-check-"));
    try {
      writeFileSync(join(dir, "wrangler.toml"), 'name = "sms-relay"\nmain = "src/index.ts"\n');
      mkdirSync(join(dir, "src"), { recursive: true });
      symlinkSync(join(ROOT, "src", "index.ts"), join(dir, "src", "index.ts"));
      expect(filesToCheck(dir, undefined, dir).map((p: string) => p.endsWith("wrangler.toml"))).toEqual([true]);
      mkdirSync(join(dir, ".relay-local"));
      writeFileSync(join(dir, ".relay-local", "wrangler.toml"), "name = \"x\"\n");
      const files = filesToCheck(dir, undefined, dir);
      expect(files.some((p: string) => p.includes(`${join(".relay-local", "wrangler.toml")}`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docs/SETUP.md Step 2 example", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("is a subfolder config whose rules and main pass the check", () => {
    const example = step2Example();
    expect(example).toContain('main = "../src/index.ts"');
    expect(example).toContain('type = "Text"');
    expect(example).toContain('"**/*.css"');
    expect(example).toContain('type = "Data"');
    expect(example).toContain('"**/*.woff2"');
    expect(example).toContain('"**/*.webp"');
    expect(example).toContain("fallthrough = false");
    const dir = mkdtempSync(join(tmpdir(), "relay-example-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    symlinkSync(join(ROOT, "src", "index.ts"), join(dir, "src", "index.ts"));
    mkdirSync(join(dir, ".relay-local"));
    const path = join(dir, ".relay-local", "wrangler.toml");
    writeFileSync(path, example);
    expect(configProblems(path, dir)).toEqual([]);
  });

  it("names the stable steps and the send-field rules", () => {
    const doc = readFileSync(join(ROOT, "docs", "SETUP.md"), "utf8");
    for (const id of ["step-1", "step-2", "step-3", "step-4", "step-5", "step-6", "step-7", "step-8"]) {
      expect(doc).toContain(`id="${id}"`);
    }
    for (const id of ["step-7-draft", "step-7-read-back", "step-7-yes", "step-7-send"]) {
      expect(doc).toContain(`id="${id}"`);
    }
    expect(doc).toContain("multi_send_needs_2_to_3");
    expect(doc).toContain("to_name");
    expect(doc).not.toContain("America/Denver");
    expect(doc).not.toContain("Dave's");
  });
});
