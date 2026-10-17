// Runs inside workerd (worker project). Records what LOCAL workerd does with PBKDF2 and how long
// one passphrase-mode send takes. NOTE: local workerd does not enforce production's 100,000 cap
// (see README), so this cannot prove the production limit, only our own guard and timing.
import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness } from "./helpers";

const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
const PASS = "TEST-ONLY-passphrase-not-real-0123456789";

describe("workerd PBKDF2 probe", () => {
  it("records local workerd behaviour at 100000 / 100001 / 300000", async () => {
    const out: string[] = [`navigator.userAgent=${navigator.userAgent}`];
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASS), "PBKDF2", false, ["deriveBits"]);
    for (const iterations of [100000, 100001, 300000]) {
      const t = performance.now();
      try {
        const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-1", salt: new Uint8Array(16), iterations }, base, 256);
        out.push(`iterations=${iterations} OK bytes=${bits.byteLength} t=${(performance.now() - t).toFixed(1)}ms`);
      } catch (e: any) {
        out.push(`iterations=${iterations} ERROR name=${e?.name} message=${e?.message}`);
      }
    }
    console.log("PROBE\n" + out.join("\n"));
    expect(out[1]).toMatch(/^iterations=100000 OK/); // the value we ship must always work
  });

  it("times one passphrase-mode send inside the Durable Object (2 fields x PBKDF2 100k + the rest)", async () => {
    const h = await harness();
    h.device.value = { id: "test-device", publicKey: null, keyVersion: null };
    await h.setEnv({ GATEWAY_PASSPHRASE: PASS });
    const res = await runIn(h.relay, async (inst) => {
      const sends: number[] = [];
      const kdf: number[] = [];
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASS), "PBKDF2", false, ["deriveBits"]);
      for (let i = 0; i < 7; i++) {
        let t = performance.now();
        await inst.gatewaySend("+15555550101", "Running 10 min late, see you soon");
        sends.push(performance.now() - t);
        t = performance.now();
        await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-1", salt: crypto.getRandomValues(new Uint8Array(16)), iterations: 100000 }, base, 256);
        kdf.push(performance.now() - t);
      }
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return { sendsMs: sends.map((x) => +x.toFixed(1)), medianSendMs: med(sends), kdfMs: kdf.map((x) => +x.toFixed(1)), medianKdfMs: med(kdf) };
    });
    console.log("CPU\n" + JSON.stringify(res));
    expect(res.medianSendMs).toBeGreaterThan(0);
  });
});
