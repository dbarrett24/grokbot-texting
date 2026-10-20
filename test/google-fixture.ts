// Typed helpers for the google-connect tests (no `any`: new files start at 0 lint findings).
import { runInDurableObject } from "cloudflare:test";
import type { Relay } from "../src/relay";
import type { Harness } from "./helpers";

export type Row = Record<string, SqlStorageValue>;

/** Run against the Relay instance (public methods) and its storage. */
export function inRelay<R>(h: Harness, f: (relay: Relay, state: DurableObjectState) => Promise<R> | R): Promise<R> {
  return runInDurableObject(h.relay as DurableObjectStub<Relay>, async (relay: Relay, state: DurableObjectState) => f(relay, state));
}
export function sql(h: Harness, q: string, ...a: SqlStorageValue[]): Promise<Row[]> {
  return inRelay(h, (_r, state) => state.storage.sql.exec(q, ...a).toArray());
}
export function must<T>(v: T | null | undefined, what = "value"): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

export type FakeGoogle = { tokenCalls: URLSearchParams[]; revokeCalls: URLSearchParams[]; tokenReply: { status: number; body: Record<string, unknown> }; revokeStatus: number; peopleNumber: string };

/** Fake Google token, revoke and People endpoints in front of the harness network. All values are TEST-ONLY. */
export async function fakeGoogle(h: Harness): Promise<FakeGoogle> {
  const g: FakeGoogle = { tokenCalls: [], revokeCalls: [], tokenReply: { status: 200, body: { access_token: "TEST-ONLY-at" } }, revokeStatus: 200, peopleNumber: "+15555550131" };
  await inRelay(h, (relay) => {
    const base = relay.net;
    relay.net = async (req: Request) => {
      const u = new URL(req.url);
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
        g.tokenCalls.push(new URLSearchParams(await req.text()));
        return Response.json(g.tokenReply.body, { status: g.tokenReply.status });
      }
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") {
        g.revokeCalls.push(new URLSearchParams(await req.text()));
        return new Response("", { status: g.revokeStatus });
      }
      if (u.host === "people.googleapis.com")
        return Response.json({ connections: [{ names: [{ displayName: "Riley Test", givenName: "Riley" }], phoneNumbers: [{ value: g.peopleNumber, canonicalForm: g.peopleNumber, type: "mobile" }] }] });
      return base(req);
    };
  });
  return g;
}
