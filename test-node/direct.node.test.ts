import { describe, it, expect } from "vitest";
import { phoneLabel as phoneLabelWorker, peopleToContacts, looksLikePhone, normalizeName, matchName, toE164 as toE164Worker, parseOptionalLimit, parseHours, insideHours, safeName, parseAccounts } from "../src/direct";
// @ts-expect-error plain .mjs script, no types
import { toE164, buildSnapshot, phoneLabel, vcardLabel, parseCountryCode as parseCcScript } from "../scripts/import-contacts.mjs";
import { parseCountryCode } from "../src/direct";

describe("phone-number scanner rule", () => {
  it.each(["+15555550101", "call 555-555-0101 now", "(555) 555-0101", "5555550101", "555.555.0101", "555 0101 555", "1 555 555 0101", "id 5555550101", "to_hmac=5555550101"])("flags %j", (s) => {
    expect(looksLikePhone(s)).toBe(true);
  });
  it.each(["…0101", "ref 1234abcd", "ref 12345678", "sha256 123456789012", "to_hmac=" + "1".repeat(64), "hmac:" + "2".repeat(64), "2026-10-17T06:00:00Z", "a1b2c3d4e5f6a7b8", "deadbeef1234567", "gw-12", "6:00 PM MDT", "n 24", "contacts=2 numbers=2"])("ignores %j", (s) => {
    expect(looksLikePhone(s)).toBe(false);
  });
});

describe("names", () => {
  const rows = ["Jordan Bauer", "Jordan Ortiz", "José  Núñez", "Ana María López"].map((n) => {
    const name_norm = normalizeName(n);
    return { name_norm, given_norm: normalizeName(n.split(" ")[0]), first_norm: name_norm.split(" ")[0] };
  });
  it("normalizes case, whitespace and diacritics only", () => {
    expect(normalizeName("  JOSÉ \t Núñez ")).toBe("jose nunez");
    expect(normalizeName("O'Brien")).toBe("o'brien");
  });
  it("matches full name, given name or first word, never a prefix or last name", () => {
    expect(matchName(rows, "jordan")).toHaveLength(2);
    expect(matchName(rows, "Jordan Ortiz")).toHaveLength(1);
    expect(matchName(rows, "ana maria lopez")).toHaveLength(1);
    expect(matchName(rows, "kels")).toHaveLength(0);
    expect(matchName(rows, "Ortiz")).toHaveLength(0);
    expect(matchName(rows, "")).toHaveLength(0);
  });
  it("safeName drops names that are numbers", () => {
    expect(safeName("555-555-0117")).toBe("(unnamed contact)");
    expect(safeName("  ")).toBe("(unnamed contact)");
    expect(safeName("Apt 5550")).toBe("(unnamed contact)");
    expect(safeName("Jordan")).toBe("Jordan");
  });
});

describe("config parsing", () => {
  it("optional limits", () => {
    expect(parseOptionalLimit(undefined)).toBeNull();
    expect(parseOptionalLimit("off")).toBeNull();
    expect(parseOptionalLimit("7")).toBe(7);
    for (const bad of ["0", "-1", "7 ", "1e2", "x", "100001"]) expect(() => parseOptionalLimit(bad)).toThrow("direct_config_invalid");
  });
  it("hours, including a window over midnight", () => {
    const w = parseHours("22:00-06:00")!;
    expect(insideHours(23 * 60, w)).toBe(true);
    expect(insideHours(6 * 60, w)).toBe(false);
    expect(parseHours(undefined)).toBeNull();
    expect(() => parseHours("9-5")).toThrow();
  });
  it("account labels", () => {
    expect(parseAccounts("primary, Work ,club")).toEqual({ valid: ["PRIMARY", "WORK", "CLUB"], invalid: [] });
    expect(parseAccounts("a-b,upload,x,X").invalid).toEqual(["a?b", "upload", "X(repeat)"]);
  });
});

describe("scripts/import-contacts.mjs", () => {
  const INPUTS = ["(555) 555-0101", "+1 555 555 0101", "1-555-555-0101", "555-0101", "011 44 555 0101", "0044 555 0101", "0555 0101", "555 0101", "+44 555 0101", "abc", ""];
  it.each(["+1", "+44", null])("normalizes the same way as the Worker (country code %j)", (cc) => {
    for (const s of INPUTS) expect(toE164(s, cc)).toBe(toE164Worker(s, cc));
  });
  it("+1 path: 10 digits get +1, 11 starting with 1 get +, 011 is the exit code", () => {
    expect(toE164Worker("(555) 555-0101", "+1")).toBe("+15555550101");
    expect(toE164Worker("1-555-555-0101", "+1")).toBe("+15555550101");
    expect(toE164Worker("011 44 555 0101", "+1")).toBe("+445550101");
    expect(toE164Worker("555-0101", "+1")).toBeNull(); // 7 digits: not enough
  });
  it("another country code: trunk 0 dropped, 00 is the exit code, never +1", () => {
    expect(toE164Worker("0555 0101", "+44")).toBe("+445550101");
    expect(toE164Worker("555 0101", "+44")).toBe("+445550101");
    expect(toE164Worker("0044 555 0101", "+44")).toBe("+445550101");
    expect(toE164Worker("(555) 555-0101", "+44")).toBe("+445555550101"); // not read as +1
  });
  it("strict path (none): only +E.164 is kept; nothing is ever assumed", () => {
    expect(toE164Worker("+1 555 555 0101", null)).toBe("+15555550101");
    expect(toE164Worker("(555) 555-0101", null)).toBeNull();
    expect(toE164Worker("1-555-555-0101", null)).toBeNull();
  });
  it.each([["+1", "+1"], ["+44", "+44"], ["+358", "+358"], ["none", null]])("DEFAULT_COUNTRY_CODE %j is accepted", (raw, want) => {
    expect(parseCountryCode(raw)).toBe(want);
    expect(parseCcScript(raw)).toBe(want);
  });
  it.each([undefined, "", "1", "+0", "+1234", "44", "US", "+1 ", "NONE", "off"])("DEFAULT_COUNTRY_CODE %j is refused (no silent +1)", (raw) => {
    expect(() => parseCountryCode(raw as string | undefined)).toThrow("default_country_code_invalid");
    expect(() => parseCcScript(raw)).toThrow(/country-code/);
  });
  it("buildSnapshot needs a country code or null; never defaults", () => {
    expect(() => buildSnapshot([], new Date())).toThrow(/country code required/);
    expect(() => buildSnapshot([], new Date(), "1")).toThrow(/country code required/);
    expect(buildSnapshot([], new Date(), null).summary.numbers).toBe(0);
  });
  const TYPES: [string, string | null][] = [
    ["", "unlabeled"], ["mobile", "mobile"], ["* Mobile", "mobile"], ["cell", "mobile"], ["CELL", "mobile"], ["iPhone", "iphone"],
    ["main", "main"], ["workMobile", "work mobile"], ["Work Mobile", "work mobile"], ["home", "home"], ["Home", "home"], ["work", "work"],
    ["other", "other"], ["googleVoice", "google voice"], ["Grandma's", "other"], ["Ranch", "ranch"], ["x".repeat(30), "other"],
    ["homeFax", null], ["workFax", null], ["otherFax", null], ["Fax", null], ["Home Fax", null], ["pager", null], ["workPager", null],
  ];
  it.each(TYPES)("phone type %j → %j (script and Worker agree)", (raw, want) => {
    expect(phoneLabel(raw)).toBe(want);
    expect(phoneLabelWorker(raw)).toBe(want);
  });
  it("vCard types: fax/pager dropped, cell wins, none → unlabeled", () => {
    expect(vcardLabel(["CELL", "VOICE"])).toBe("mobile");
    expect(vcardLabel(["WORK", "CELL"])).toBe("work mobile");
    expect(vcardLabel(["HOME", "VOICE"])).toBe("home");
    expect(vcardLabel(["IPHONE"])).toBe("iphone");
    expect(vcardLabel(["MAIN"])).toBe("main");
    expect(vcardLabel(["VOICE", "pref"])).toBe("unlabeled");
    expect(vcardLabel([])).toBe("unlabeled");
    expect(vcardLabel(["WORK", "FAX"])).toBeNull();
    expect(vcardLabel(["PAGER"])).toBeNull();
  });
  it("peopleToContacts keeps every type but fax and pager, and counts the dropped ones", () => {
    const stats = { dropped: 0 };
    const out = peopleToContacts([{ names: [{ displayName: "Pat" }], phoneNumbers: [
      { value: "+15555550131", type: "mobile" }, { value: "+15555550132", type: "home" }, { value: "+15555550133", type: "workFax" },
      { value: "+15555550134", type: "main" }, { value: "+15555550135", type: "workMobile" }, { value: "+15555550136", type: "pager" },
      { value: "+15555550137" }, { value: "+15555550138", type: "iPhone" },
    ] }], stats, "+1");
    expect(out[0].numbers.map((n: any) => n.label)).toEqual(["mobile", "home", "main", "work mobile", "unlabeled", "iphone"]);
    expect(stats.dropped).toBe(2);
  });
  it("reads Google CSV and vCard, keeps every phone type but fax/pager, drops other fields, dedupes across files", () => {
    const csv = [
      "First Name,Middle Name,Last Name,E-mail 1 - Value,Notes,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value",
      'Jordan,,Bauer,k@example.test,secret note,* Mobile,(555) 555-0111 ::: 555-555-0119,Home Fax,555-555-0118',
      'Zoë,,Hall,,,,+1 555 555 0114,Work,555 555 0110',
    ].join("\n");
    const vcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Coach Taylor\nN:Taylor;Coach;;;\nEMAIL:p@example.test\nTEL;TYPE=CELL:555-555-0115\nTEL;TYPE=HOME:555-555-0116\nTEL;TYPE=WORK,FAX:555-555-0117\nEND:VCARD\nBEGIN:VCARD\nFN:Dup\nTEL:555-555-0111\nEND:VCARD\n";
    const { snapshot, summary } = buildSnapshot([{ name: "primary.csv", text: csv }, { name: "work.vcf", text: vcf }], new Date("2026-10-17T06:00:00Z"), "+1");
    expect(snapshot).toEqual({
      generated_at: "2026-10-17T06:00:00Z",
      contacts: [
        { name: "Jordan Bauer", given: "Jordan", numbers: [{ e164: "+15555550111", label: "mobile" }, { e164: "+15555550119", label: "mobile" }] },
        { name: "Zoë Hall", given: "Zoë", numbers: [{ e164: "+15555550114", label: "unlabeled" }, { e164: "+15555550110", label: "work" }] },
        { name: "Coach Taylor", given: "Coach", numbers: [{ e164: "+15555550115", label: "mobile" }, { e164: "+15555550116", label: "home" }] },
      ],
    });
    expect(summary).toEqual({ contacts: 3, numbers: 6, droppedType: 2, invalid: 0, duplicates: 1 });
    expect(JSON.stringify(snapshot)).not.toMatch(/example\.test|note/);
    // Strict mode: the same files keep only the numbers written with "+".
    const strict = buildSnapshot([{ name: "primary.csv", text: csv }, { name: "work.vcf", text: vcf }], new Date("2026-10-17T06:00:00Z"), null);
    expect(strict.snapshot.contacts).toEqual([{ name: "Zoë Hall", given: "Zoë", numbers: [{ e164: "+15555550114", label: "unlabeled" }] }]);
    expect(strict.summary.invalid).toBe(6);
  });
  it("peopleToContacts uses the country code only when Google gives no canonical form", () => {
    const people = [{ names: [{ displayName: "Lee" }], phoneNumbers: [{ value: "0555 0101", type: "mobile" }, { value: "x", canonicalForm: "+15555550102" }] }];
    expect(peopleToContacts(people, { dropped: 0 }, "+44")[0].numbers.map((n: any) => n.e164)).toEqual(["+445550101", "+15555550102"]);
    expect(peopleToContacts(people, { dropped: 0 }, null)[0].numbers.map((n: any) => n.e164)).toEqual(["+15555550102"]);
  });
});

// @ts-expect-error plain .mjs script, no types
import { labelToSecret, authUrl, SCOPE, waitForCode, refreshTokenFrom, openerFor, showConsentUrl } from "../scripts/google-consent.mjs";
describe("scripts/google-consent.mjs", () => {
  it("label → secret name, same rule as the Worker", () => {
    expect(labelToSecret("work")).toBe("GOOGLE_RT_WORK");
    expect(() => labelToSecret("ch-urch")).toThrow();
    expect(() => labelToSecret("upload")).toThrow();
  });
  it("the loopback listener times out, closes its port, and saves nothing", async () => {
    let url = "";
    await expect(waitForCode({ state: "s", timeoutMs: 50, onListening: (r: string) => { url = r; } })).rejects.toThrow(/no answer from Google/);
    await expect(fetch(url)).rejects.toThrow(); // port closed
  });
  it("the loopback listener returns the code and rejects a wrong state", async () => {
    const ok = waitForCode({ state: "good", timeoutMs: 5000, onListening: (r: string) => void fetch(`${r}?state=good&code=TEST-ONLY-code`) });
    await expect(ok).resolves.toBe("TEST-ONLY-code");
    const bad = waitForCode({ state: "good", timeoutMs: 5000, onListening: (r: string) => void fetch(`${r}?state=evil&code=x`) });
    await expect(bad).rejects.toThrow("state mismatch");
  });
  it("asks for read-only contacts, offline access, PKCE", () => {
    const u = new URL(authUrl({ clientId: "TEST-ONLY-client", redirect: "http://127.0.0.1:1/cb", challenge: "c", state: "s" }));
    expect(u.searchParams.get("scope")).toBe(SCOPE);
    expect(SCOPE).toBe("https://www.googleapis.com/auth/contacts.readonly");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });
  const URL_ = "https://accounts.example.com/auth?a=1&b=2";
  it.each([
    ["darwin", "open", [URL_]],
    ["linux", "xdg-open", [URL_]],
    ["freebsd", "xdg-open", [URL_]],
    ["win32", "cmd", ["/d", "/s", "/c", `start "" "${URL_}"`]],
  ])("browser opener on %s is %s", (platform, cmd, args) => {
    const o = openerFor(platform, URL_);
    expect(o.cmd).toBe(cmd);
    expect(o.args).toEqual(args);
    if (platform === "win32") expect(o.opts).toEqual({ windowsVerbatimArguments: true }); // keeps the quoted & intact
  });
  it.each(["darwin", "linux", "win32"])("always prints the URL before trying to open it (%s)", (platform) => {
    const out: string[] = [];
    const ran: string[] = [];
    const ok = showConsentUrl(URL_, { platform, log: (s: string) => out.push(`log:${s}`), run: (cmd: string) => (ran.push(cmd), out.push(`run:${cmd}`), { status: 0 }) });
    expect(ok).toBe(true);
    expect(out.indexOf(`log:${URL_}`)).toBeGreaterThanOrEqual(0);
    expect(out.indexOf(`log:${URL_}`)).toBeLessThan(out.findIndex((x) => x.startsWith("run:")));
    expect(ran).toEqual([openerFor(platform, URL_).cmd]);
  });
  it.each([{ status: 1 }, { error: new Error("ENOENT"), status: null }, "throw"])("a failed opener is not fatal; the printed link is the fallback (%j)", (r) => {
    const out: string[] = [];
    const run = () => {
      if (r === "throw") throw new Error("spawn failed");
      return r;
    };
    expect(showConsentUrl(URL_, { platform: "linux", log: (s: string) => out.push(s), run })).toBe(false);
    expect(out).toContain(URL_);
    expect(out.at(-1)).toMatch(/copy the link above/);
  });
});

import { readFileSync } from "node:fs";
describe("wrangler.toml template", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const v = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  it("product defaults: direct send on, guards off, email OTP the normal setting; no cap, links allowed", () => {
    expect(v("DIRECT_SEND")).toBe("1");
    expect(v("RUNAWAY_PAUSE")).toBe("0");
    expect(v("CONTACTS_SNAPSHOT_ONLY")).toBe("0");
    expect(v("ALLOW_EMAIL_OTP")).toBe("1");
    expect(v("DISABLED")).toBe("0");
    expect(v("RUNAWAY_MAX")).toBe("10");
    expect(v("GOOGLE_ACCOUNTS")).toBe("");
    // opt-in switches and tap limits are documented but commented out (unset = off / built-in default)
    expect(toml).not.toMatch(/^(BLOCK_LINKS|DIRECT_(DAILY_CAP|PER_MINUTE_MAX|HOURS|NOTIFY_EACH))\s*=/m);
    expect(toml).toMatch(/^# BLOCK_LINKS = "1"/m);
    expect(toml).toMatch(/^# DIRECT_DAILY_CAP = /m);
    for (const k of ["PENDING_CAP_PER_DAY", "SEND_CAP_INITIAL", "SEND_CAP_AFTER", "CAP_RAISE_AFTER_DAYS", "REQUEST_TTL_SECONDS", "MIN_SECONDS_BETWEEN_SENDS", "MAX_TEXT_CHARS"])
      expect(toml).toMatch(new RegExp(`^# ${k} = "\\d+"`, "m"));
    expect(toml).not.toMatch(/^(LOG_HASH_KEY|DIRECT_LOOKUP_MAX_PER_HOUR)\s*=/m); // a secret, and an optional var left at its default
  });
  it("iPhone delivery is documented but off: DELIVERY unset means android; DEVICE_TOKEN is a secret", () => {
    expect(toml).not.toMatch(/^(DELIVERY|DEVICE_TOKEN|SHORTCUT_PING|PING_FROM|PING_TO|SHORTCUT_NAME|UNCLAIMED_EXPIRY_MINUTES)\s*=/m);
    expect(toml).not.toMatch(/^\[\[send_email\]\]/m);
    expect(toml).toMatch(/^# DELIVERY = "mac"/m);
    expect(toml).toMatch(/^# UNCLAIMED_EXPIRY_MINUTES = "30"/m);
    expect(toml).toMatch(/^# DEVICE_TOKEN \(/m);
  });
  it("required settings have placeholders, never a default zone or country code", () => {
    expect(v("TIMEZONE")).toMatch(/^REPLACE/);
    expect(v("DEFAULT_COUNTRY_CODE")).toMatch(/^REPLACE/);
    expect(v("CAP_START_DATE")).toMatch(/^REPLACE/);
    expect(v("ACCESS_TEAM_DOMAIN")).toBe("https://REPLACE_WITH_TEAM.cloudflareaccess.com");
  });
  it("placeholder hosts only (example.com); no account id, zone or real team domain", () => {
    expect(v("REQUEST_HOST")).toBe("api.example.com");
    expect(v("APPROVE_HOST")).toBe("app.example.com");
    expect(toml).not.toMatch(/^\s*(account_id|zone_id|zone_name)\s*=/m);
    expect(toml).not.toMatch(/^routes\s*=/m); // routes stay commented until the deployer fills them in
    const hosts = [...toml.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/gi)].map((m) => m[1].toLowerCase());
    for (const h of hosts) expect(h).toMatch(/(^|\.)example\.com$|^api\.sms-gate\.app$|^replace_with_team\.cloudflareaccess\.com$/);
  });
});

describe("link rule (every outbound path)", async () => {
  const { hasLink } = await import("../src/rules");
  it.each([
    "see example.com", "https://x.test", "www thing",
    "ex\u200Bample\u200C.\u200Dcom", "exa\u00ADmple.com", "bad\u2060.com", "x\u200E.com", // zero-width, soft hyphen, word joiner, bidi mark
    "example\u3002com", "example\uFF0Ecom", "example\uFF61com", "example\uFE52com", // look-alike dots
    "ｅｘａｍｐｌｅ．ｃｏｍ", // fullwidth
    "192.168.1.1", "go to 192.168.1.1/x", "10.0.0.1:8080", "1.2.3.4",
    "6.Ok", // known false positive, accepted (fails closed)
  ])("refuses %j", (s) => expect(hasLink(s)).toBe(true));
  it.each(["On my way", "Running 5 min late.", "Meet at 6. Ok?", "v1.2.3", "Score 3.5 to 2", "1.2.3", "Thanks!\u200D"])("allows %j", (s) => expect(hasLink(s)).toBe(false));
});

describe("google-consent: granted scope check", () => {
  const RT = "TEST-ONLY-refresh-token";
  it("exactly contacts.readonly → returns the refresh token", () => {
    expect(refreshTokenFrom({ scope: SCOPE, refresh_token: RT })).toBe(RT);
    expect(refreshTokenFrom({ scope: ` ${SCOPE} `, refresh_token: RT })).toBe(RT);
  });
  it.each([
    [{ refresh_token: RT }],
    [{ scope: "", refresh_token: RT }],
    [{ scope: "https://www.googleapis.com/auth/contacts", refresh_token: RT }],
    [{ scope: `${SCOPE} https://www.googleapis.com/auth/gmail.readonly`, refresh_token: RT }],
    [{ scope: `${SCOPE} ${SCOPE}`, refresh_token: RT }],
    [{ scope: "openid email", refresh_token: RT }],
    [null],
  ])("refuses %j and never echoes the token", (j) => {
    let msg = "";
    try {
      refreshTokenFrom(j);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/nothing was saved/);
    expect(msg).not.toContain(RT);
  });
  it("right scope but no refresh token → refused", () => {
    expect(() => refreshTokenFrom({ scope: SCOPE })).toThrow(/no refresh token/);
  });
});
