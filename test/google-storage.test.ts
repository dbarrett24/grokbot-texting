// google-connect PR 1: per-deploy OAuth client + refresh tokens sealed (AES-GCM) in the Relay DO, GOOGLE_* secrets as fallback.
import { beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./helpers";
import { fakeGoogle, inRelay, must, sql as sqlOf, type FakeGoogle } from "./google-fixture";
import { aadFor, decodeAccountRow, importTokenKey, open, parseTokenKeyBytes, seal, type TokenKey } from "../src/google";

const KEY_A = "ab".repeat(32); // obviously fake test keys
const KEY_B = "cd".repeat(32);
const RT = "TEST-ONLY-stored-rt-riley";
const CLIENT_ID = "123-testonly.apps.googleusercontent.com";
const CLIENT_SECRET = "TEST-ONLY-stored-client-secret";

let h: Harness;
let g: FakeGoogle;
const sql = (q: string, ...a: SqlStorageValue[]) => sqlOf(h, q, ...a);
const key = async (raw: string): Promise<TokenKey> => must(await importTokenKey(raw), "key");
const saveAccount = () => inRelay(h, (r) => r.saveGoogleAccount("WORK", RT, "s", null));

beforeEach(async () => {
  h = await harness();
  g = await fakeGoogle(h);
  await h.setEnv({ GOOGLE_ACCOUNTS: "", GOOGLE_TOKEN_KEY: KEY_A, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
});

describe("seal/open (src/google.ts)", () => {
  it("round-trips, uses a fresh 12-byte IV per write, and the ciphertext never contains the plaintext", async () => {
    const k = (await key(KEY_A));
    const a = await seal(k, RT, aadFor("rt", "WORK"));
    const b = await seal(k, RT, aadFor("rt", "WORK"));
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(atob(a.iv).length).toBe(12);
    expect(atob(a.ct)).not.toContain(RT);
    expect((await open([k], a, aadFor("rt", "WORK"))).plaintext).toBe(RT);
  });

  it("refuses a tampered ciphertext, a token replayed under another label, and the wrong key", async () => {
    const k = (await key(KEY_A));
    const kb = (await key(KEY_B));
    const s = await seal(k, RT, aadFor("rt", "WORK"));
    const raw = atob(s.ct);
    const flipped = btoa(raw.slice(0, 3) + String.fromCharCode(raw.charCodeAt(3) ^ 1) + raw.slice(4));
    await expect(open([k], { ...s, ct: flipped }, aadFor("rt", "WORK"))).rejects.toThrow("google_token_decrypt_failed");
    await expect(open([k], s, aadFor("rt", "PRIMARY"))).rejects.toThrow("google_token_decrypt_failed");
    await expect(open([k], s, aadFor("client", "WORK"))).rejects.toThrow("google_token_decrypt_failed");
    await expect(open([kb], s, aadFor("rt", "WORK"))).rejects.toThrow("google_token_key_missing");
    await expect(open([{ ...kb, kid: k.kid }], s, aadFor("rt", "WORK"))).rejects.toThrow("google_token_decrypt_failed");
  });

  it("GOOGLE_TOKEN_KEY: 64 hex or base64 of 32 bytes; unset = off; anything else refuses", () => {
    expect(parseTokenKeyBytes(undefined)).toBeNull();
    expect(parseTokenKeyBytes(" ")).toBeNull();
    expect(must(parseTokenKeyBytes(KEY_A)).length).toBe(32);
    expect(must(parseTokenKeyBytes(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))).length).toBe(32);
    for (const bad of ["ab".repeat(31), "short", btoa("x".repeat(31)), "zz".repeat(32)]) expect(() => parseTokenKeyBytes(bad)).toThrow("google_token_key_invalid");
  });
});

describe("typed decoders", () => {
  const good = { label: "WORK", email: null, rt_ct: "x", rt_iv: "y", scope: "s", connected_ms: 1, key_ver: "k" };
  it("accept a well-formed row and refuse every malformed one", () => {
    expect(decodeAccountRow(good)).toEqual(good);
    for (const bad of [null, [], { ...good, label: "work" }, { ...good, label: "UPLOAD" }, { ...good, rt_ct: "" }, { ...good, connected_ms: "1" }, { ...good, email: 5 }, { ...good, key_ver: undefined }])
      expect(() => decodeAccountRow(bad)).toThrow("google_row_invalid");
  });
});

describe("Relay storage", () => {
  it("stores the refresh token sealed: no plaintext in any SQLite column", async () => {
    await saveAccount();
    const dump = JSON.stringify(await sql("SELECT * FROM google_accounts"));
    expect(dump).not.toContain(RT);
    expect(dump).not.toContain(CLIENT_SECRET);
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
    expect(await inRelay(h, (i) => i.googleClient())).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET, source: "secrets" });
  });

  it("refuses to store a refresh token without GOOGLE_TOKEN_KEY (never plaintext)", async () => {
    await h.setEnv({ GOOGLE_TOKEN_KEY: "" });
    await expect(inRelay(h, (i) => i.saveGoogleAccount("WORK", RT, "s", null))).rejects.toThrow();
    expect(await sql("SELECT * FROM google_accounts")).toEqual([]);
  });

  it("uses the Worker secrets and deletes a stale pasted client instead of preferring it", async () => {
    await sql("INSERT INTO google_client(id, blob_ct, blob_iv, key_ver, saved_ms) VALUES(1,?,?,?,?)", "TEST-ONLY-stale-client-secret", "iv", "old", 1);
    expect(await inRelay(h, (i) => i.googleClient())).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET, source: "secrets" });
    expect(await sql("SELECT * FROM google_client")).toEqual([]);
    await h.setEnv({ GOOGLE_RT_WORK: "TEST-ONLY-env-rt" });
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe("TEST-ONLY-env-rt");
    await saveAccount();
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
    await h.setEnv({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
    expect(await inRelay(h, (i) => i.googleClient())).toBeNull();
  });

  it("sync uses the stored token and the Worker client for a label connected in-app (not in GOOGLE_ACCOUNTS)", async () => {
    await saveAccount();
    const r = await inRelay(h, (i) => i.syncContacts({ alert: false }));
    expect(r).toEqual({ updated: ["WORK"], failed: [] });
    expect(must(g.tokenCalls[0]).get("refresh_token")).toBe(RT);
    expect(must(g.tokenCalls[0]).get("client_id")).toBe(CLIENT_ID);
    expect(must(g.tokenCalls[0]).get("client_secret")).toBe(CLIENT_SECRET);
    expect((await sql("SELECT account FROM contacts")).map((x) => x["account"])).toEqual(["WORK"]);
  });

  it("GOOGLE_ACCOUNTS labels come first (name precedence), stored labels after", async () => {
    await h.setEnv({ GOOGLE_ACCOUNTS: "primary" });
    await inRelay(h, async (i) => { await i.saveGoogleAccount("WORK", RT, "s", null, 1); await i.saveGoogleAccount("CLUB", RT, "s", null, 2); await i.saveGoogleAccount("PRIMARY", RT, "s", null, 3); });
    expect(await inRelay(h, (i) => i.googleLabels())).toEqual(["PRIMARY", "WORK", "CLUB"]);
  });

  it("rotation: GOOGLE_TOKEN_KEY_OLD decrypts, and the sign-in is re-sealed under the new key; without it the sync fails closed", async () => {
    await saveAccount();
    const kidA = (await key(KEY_A)).kid, kidB = (await key(KEY_B)).kid;
    await h.setEnv({ GOOGLE_TOKEN_KEY: KEY_B });
    const r = await inRelay(h, (i) => i.syncContacts({ alert: false }));
    expect(r.failed).toEqual([{ account: "WORK", reason: "google_token_key_missing" }]);
    await h.setEnv({ GOOGLE_TOKEN_KEY_OLD: KEY_A });
    expect((await sql("SELECT key_ver FROM google_accounts"))[0]?.["key_ver"]).toBe(kidA);
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
    expect((await inRelay(h, (i) => i.googleClient()))?.secret).toBe(CLIENT_SECRET);
    expect((await sql("SELECT key_ver FROM google_accounts"))[0]?.["key_ver"]).toBe(kidB);
    expect(await sql("SELECT * FROM google_client")).toEqual([]);
    await h.setEnv({ GOOGLE_TOKEN_KEY_OLD: "" });
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
  });

  it("googleKeyStatus counts sign-ins still on the old key until each is re-sealed (rotation check)", async () => {
    await saveAccount();
    await inRelay(h, (i) => i.saveGoogleAccount("CLUB", RT, "s", null));
    expect(await inRelay(h, (i) => i.googleKeyStatus())).toEqual({ total: 2, onCurrent: 2, onOld: 0 });
    await h.setEnv({ GOOGLE_TOKEN_KEY: KEY_B, GOOGLE_TOKEN_KEY_OLD: KEY_A });
    expect(await inRelay(h, (i) => i.googleKeyStatus())).toEqual({ total: 2, onCurrent: 0, onOld: 2 });
    await inRelay(h, (i) => i.googleRefreshToken("WORK"));
    expect(await inRelay(h, (i) => i.googleKeyStatus())).toEqual({ total: 2, onCurrent: 1, onOld: 1 });
    await inRelay(h, (i) => i.syncContacts({ alert: false }));
    expect(await inRelay(h, (i) => i.googleKeyStatus())).toEqual({ total: 2, onCurrent: 2, onOld: 0 });
  });

  it("a tampered stored row fails that account's sync with a code, keeps the old list, and leaks nothing", async () => {
    await saveAccount();
    await sql("UPDATE google_accounts SET rt_iv=?", btoa("x".repeat(12)));
    const r = await inRelay(h, (i) => i.syncContacts({ alert: false }));
    expect(r.failed).toEqual([{ account: "WORK", reason: "google_token_decrypt_failed" }]);
    expect(JSON.stringify(await sql("SELECT detail FROM log"))).not.toContain(RT);
  });

  it("deleteGoogleAccount removes the row", async () => {
    await inRelay(h, (i) => i.saveGoogleAccount("WORK", RT, "s", null));
    expect(await inRelay(h, (i) => i.deleteGoogleAccount("WORK"))).toBe(true);
    expect(await sql("SELECT * FROM google_accounts")).toEqual([]);
    expect(await inRelay(h, (i) => i.deleteGoogleAccount("WORK"))).toBe(false);
  });
});
