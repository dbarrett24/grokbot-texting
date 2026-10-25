// scripts/ci/pii-scan.mjs in throwaway repos: the missing-list warning, fail-closed, a terms.example hit (redacted),
// and the pushed-range email rule (noreply allowed, @gmail.com author or committer rejected).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = realpathSync(new URL("..", import.meta.url).pathname);
const SCAN = join(ROOT, "scripts/ci/pii-scan.mjs");
const EXAMPLE = join(ROOT, "scripts/ci/pii-terms.example");
const NOREPLY = "1+fake@users.noreply.github.com";
let dir: string;
const clean = () => {
  const e: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("GIT_") || k.startsWith("PII_")) delete e[k];
  return e;
};
const git = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("git", args, { cwd: dir, env: { ...clean(), ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const commit = (file: string, body: string, a = NOREPLY, c = NOREPLY, an = "A", cn = "C") => {
  writeFileSync(join(dir, file), body);
  git(["add", file]);
  git(["commit", "-q", "-m", `add ${file}`], { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: a, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: c });
};
const scan = (env: Record<string, string> = {}, args: string[] = []) =>
  spawnSync(process.execPath, [SCAN, ...args], { cwd: dir, env: { ...clean(), ...env }, encoding: "utf8" });

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "relay-pii-"));
  git(["init", "-q", "-b", "main"]);
  commit("a.md", "hello\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pii-scan term list", () => {
  it("no list: loud multi-line WARNING on stderr, exit 0", () => {
    const r = scan();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("WARNING: pii-scan has NO TERM LIST");
    expect(r.stderr.split("\n").length).toBeGreaterThan(4);
    expect(r.stderr).toContain(`Missing file: ${join(dir, ".pii-terms")}`);
    expect(r.stderr).toContain("cp scripts/ci/pii-terms.example .pii-terms");
    expect(r.stderr).toContain("PII_TERMS");
  });
  it.each(["PII_REQUIRE_TERMS", "PII_REQUIRED"])("no list with %s=1: fails closed", (k) => {
    const r = scan({ [k]: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL: no term list");
  });
  it("a terms.example entry in a file is caught, and only redacted in output", () => {
    const term = readFileSync(EXAMPLE, "utf8").split("\n").find((l) => l && !l.startsWith("#")) ?? "";
    expect(term).not.toBe("");
    commit("b.md", `owner is ${term} here\n`);
    for (const env of [{ PII_TERMS_FILE: EXAMPLE }, { PII_TERMS: term }] as Record<string, string>[]) {
      const r = scan(env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`b.md: matches personal-data term #`);
      expect(r.stderr).toContain(`${term.slice(0, 2)}***`);
      expect(r.stderr + r.stdout).not.toContain(term);
    }
  });
  it("reads a gitignored .pii-terms at the repo root", () => {
    commit("b.md", "fake-family-name\n");
    writeFileSync(join(dir, ".pii-terms"), "fake-family-name\n");
    expect(scan().status).toBe(1);
  });
});

describe("pii-scan pushed-range emails", () => {
  const range = () => [`--range`, `${git(["rev-parse", "HEAD~1"])}..HEAD`];
  it("noreply author and committer pass", () => {
    commit("c.md", "x\n");
    const r = scan({ PII_TERMS: "zz-unused" }, range());
    expect(r.status).toBe(0);
  });
  it("gmail author is rejected", () => {
    commit("c.md", "x\n", "someone@gmail.com");
    const r = scan({ PII_TERMS: "zz-unused" }, range());
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/author email so\*\*\*@gmail\.com/);
  });
  it("gmail committer is rejected", () => {
    commit("c.md", "x\n", NOREPLY, "someone@GMAIL.com");
    const r = scan({ PII_TERMS: "zz-unused" }, range());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("committer email");
  });
  it("gmail rule has no env bypass", () => {
    commit("c.md", "x\n", "someone@gmail.com");
    const r = scan({ PII_TERMS: "zz-unused", PII_REQUIRE_TERMS: "0", PII_REQUIRED: "0", PII_ALLOW_GMAIL: "1" }, range());
    expect(r.status).toBe(1);
  });
});

describe("pii-scan review fixes", () => {
  const TERM = "fake-family-name";
  const range = () => [`--range`, `${git(["rev-parse", "HEAD~1"])}..HEAD`];
  it.each(["someone@gmail.com.", "Someone@GMail.COM", "someone@gmail.com..", "someone@googlemail.com"])("gmail variant %s is rejected", (e) => {
    commit("c.md", "x\n", e);
    const r = scan({ PII_TERMS: "zz-unused" }, range());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("author email");
  });
  it("a term in a merge commit message is caught (merges are scanned)", () => {
    const base = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "-b", "side"]);
    commit("s.md", "x\n");
    git(["checkout", "-q", "main"]);
    commit("m.md", "y\n");
    git(["merge", "-q", "--no-ff", "side", "-m", `merge from ${TERM}`], { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: NOREPLY, GIT_COMMITTER_NAME: "C", GIT_COMMITTER_EMAIL: NOREPLY });
    const r = scan({ PII_TERMS: TERM }, ["--range", `${base}..HEAD`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("messages ");
  });
  it.each([["author", TERM, "C"], ["committer", "A", TERM]])("a term in the %s name is caught", (_role, an, cn) => {
    commit("c.md", "x\n", NOREPLY, NOREPLY, an, cn);
    const r = scan({ PII_TERMS: TERM }, range());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("authors ");
  });
  describe("allowed public strings", () => {
    const PUB = "https://example.invalid/owner/";
    beforeEach(() => commit("scripts-pub.md", "")); // placeholder so HEAD~1 exists in every case
    const withPub = (body: string, terms = `${TERM},owner`) => {
      git(["checkout", "-q", "main"]);
      spawnSync("mkdir", ["-p", join(dir, "scripts/ci")]);
      writeFileSync(join(dir, "scripts/ci/pii-public-urls.txt"), `# public\n${PUB}\n`);
      git(["add", "scripts/ci/pii-public-urls.txt"]);
      commit("p.md", body);
      return scan({ PII_TERMS: terms });
    };
    it("an allowed string alone passes even though it contains a term", () => {
      expect(withPub(`see ${PUB}\n`).status).toBe(0);
    });
    it("a term glued onto an allowed prefix is still caught", () => {
      const r = withPub(`see ${PUB}${TERM}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("p.md: matches personal-data term #1");
    });
    it("removing an allowed string never glues its neighbours into a term", () => {
      expect(withPub(`fake-family${PUB}-name\n`, TERM).status).toBe(0); // the old split/join strip read "fake-family-name"
    });
  });
});
