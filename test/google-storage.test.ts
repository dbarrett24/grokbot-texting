// google-connect PR 1: per-deploy OAuth client + refresh tokens sealed (AES-GCM) in the Relay DO, GOOGLE_* secrets as fallback.
import { beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./helpers";
import { fakeGoogle, inRelay, must, sql as sqlOf, type FakeGoogle } from "./google-fixture";
import { aadFor, decodeAccountRow, decodeClientBlob, decodeClientRow, importTokenKey, open, parseTokenKeyBytes, seal, type TokenKey } from "../src/google";

const KEY_A = "ab".repeat(32); // obviously fake test keys
const KEY_B = "cd".repeat(32);
const RT = "TEST-ONLY-stored-rt-riley";
const CLIENT_ID = "123-testonly.apps.googleusercontent.com";
const CLIENT_SECRET = "TEST-ONLY-stored-client-secret";

let h: Harness;
let g: FakeGoogle;
const sql = (q: string, ...a: SqlStorageValue[]) => sqlOf(h, q, ...a);
const key = async (raw: string): Promise<TokenKey> => must(await importTokenKey(raw), "key");
const saveBoth = () => inRelay(h, async (r) => { await r.saveGoogleAccount("WORK", RT, "s", null); await r.saveGoogleClient(CLIENT_ID, CLIENT_SECRET); });

beforeEach(async () => {
  h = await harness();
  g = await fakeGoogle(h);
  await h.setEnv({ GOOGLE_ACCOUNTS: "", GOOGLE_TOKEN_KEY: KEY_A });
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
    expect(decodeClientRow({ blob_ct: "a", blob_iv: "b", key_ver: "c", saved_ms: 2 })).toEqual({ blob_ct: "a", blob_iv: "b", key_ver: "c", saved_ms: 2 });
    expect(() => decodeClientRow({ blob_ct: "a", blob_iv: "b", key_ver: "c" })).toThrow("google_row_invalid");
  });
  it("client blob: exactly {id, secret}, both well-formed", () => {
    expect(decodeClientBlob(JSON.stringify({ id: CLIENT_ID, secret: CLIENT_SECRET }))).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET });
    for (const bad of ["nope", "[]", JSON.stringify({ id: CLIENT_ID }), JSON.stringify({ id: "x", secret: CLIENT_SECRET }), JSON.stringify({ id: CLIENT_ID, secret: CLIENT_SECRET, extra: 1 })])
      expect(() => decodeClientBlob(bad)).toThrow("google_client_blob_invalid");
  });
});

describe("Relay storage", () => {
  it("stores the refresh token and client sealed: no plaintext in any SQLite column", async () => {
    await saveBoth();
    const dump = JSON.stringify([await sql("SELECT * FROM google_accounts"), await sql("SELECT * FROM google_client")]);
    expect(dump).not.toContain(RT);
    expect(dump).not.toContain(CLIENT_SECRET);
    expect(dump).not.toContain(CLIENT_ID);
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
    expect(await inRelay(h, (i) => i.googleClient())).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET, source: "stored" });
  });

  it("refuses to store anything without GOOGLE_TOKEN_KEY (never plaintext)", async () => {
    await h.setEnv({ GOOGLE_TOKEN_KEY: "" });
    await expect(inRelay(h, (i) => i.saveGoogleAccount("WORK", RT, "s", null))).rejects.toThrow();
    await expect(inRelay(h, (i) => i.saveGoogleClient(CLIENT_ID, CLIENT_SECRET))).rejects.toThrow();
    expect(await sql("SELECT * FROM google_accounts")).toEqual([]);
    expect(await sql("SELECT * FROM google_client")).toEqual([]);
  });

  it("falls back to the GOOGLE_* secrets when nothing is stored, and prefers the stored values when both exist", async () => {
    await h.setEnv({ GOOGLE_CLIENT_ID: "TEST-ONLY-env-client", GOOGLE_CLIENT_SECRET: "TEST-ONLY-env-secret", GOOGLE_RT_WORK: "TEST-ONLY-env-rt" });
    expect(await inRelay(h, (i) => i.googleClient())).toEqual({ id: "TEST-ONLY-env-client", secret: "TEST-ONLY-env-secret", source: "secrets" });
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe("TEST-ONLY-env-rt");
    await saveBoth();
    expect((await inRelay(h, (i) => i.googleClient()))?.source).toBe("stored");
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
    await h.setEnv({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
    await sql("DELETE FROM google_client");
    expect(await inRelay(h, (i) => i.googleClient())).toBeNull();
  });

  it("sync uses the stored token and client for a label connected in-app (not in GOOGLE_ACCOUNTS)", async () => {
    await saveBoth();
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

  it("rotation: GOOGLE_TOKEN_KEY_OLD decrypts, and the row is re-sealed under the new key; without it the sync fails closed", async () => {
    await saveBoth();
    const kidA = (await key(KEY_A)).kid, kidB = (await key(KEY_B)).kid;
    await h.setEnv({ GOOGLE_TOKEN_KEY: KEY_B });
    const r = await inRelay(h, (i) => i.syncContacts({ alert: false }));
    expect(r.failed).toEqual([{ account: "WORK", reason: "google_token_key_missing" }]);
    await h.setEnv({ GOOGLE_TOKEN_KEY_OLD: KEY_A });
    expect((await sql("SELECT key_ver FROM google_accounts"))[0]?.["key_ver"]).toBe(kidA);
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
    expect((await inRelay(h, (i) => i.googleClient()))?.secret).toBe(CLIENT_SECRET);
    expect((await sql("SELECT key_ver FROM google_accounts"))[0]?.["key_ver"]).toBe(kidB);
    expect((await sql("SELECT key_ver FROM google_client"))[0]?.["key_ver"]).toBe(kidB);
    await h.setEnv({ GOOGLE_TOKEN_KEY_OLD: "" });
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
  });

  it("googleKeyStatus counts rows still on the old key until each is re-sealed (rotation check)", async () => {
    await saveBoth();
    await inRelay(h, (i) => i.saveGoogleAccount("CLUB", RT, "s", null));
    expect(await inRelay(h, (i) => i.googleKeyStatus())).toEqual({ total: 3, onCurrent: 3, onOld: 0 });
    await h.setEnv({ GOOGLE_TOKEN_KEY: KEY_B, GOOGLE_TOKEN_KEY_OLD: KEY_A });
    expect(await inRelay(h, (i) => i.googleKeyStatus())).toEqual({ total: 3, onCurrent: 0, onOld: 3 });
    await inRelay(h, (i) => i.googleRefreshToken("WORK"));
    expect(await inRelay(h, (i) => i.googleKeyStatus())).toEqual({ total: 3, onCurrent: 1, onOld: 2 });
    await inRelay(h, (i) => i.syncContacts({ alert: false }));
    expect(await inRelay(h, (i) => i.googleKeyStatus())).toEqual({ total: 3, onCurrent: 3, onOld: 0 });
  });

  it("a tampered stored row fails that account's sync with a code, keeps the old list, and leaks nothing", async () => {
    await saveBoth();
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
