// Cloudflare Access JWT check (defense in depth; Access itself blocks unauthenticated traffic).
import { unb64 } from "./e2e";

export type Net = (req: Request) => Promise<Response>;

function b64urlToBytes(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return unb64(p + "=".repeat((4 - (p.length % 4)) % 4));
}
/** Decode one JWT segment. Anything that isn't a JSON object (bad base64, bad JSON, null, a number) is malformed. */
function b64urlJson(s: string): Record<string, any> {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
  } catch {
    throw new Error("access_jwt_malformed");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("access_jwt_malformed");
  return v as Record<string, any>;
}

export interface AccessConfig {
  teamDomain: string;
  aud: string;
  approverEmail: string;
  requiredAmr: string[];
  /** ALLOW_EMAIL_OTP === "1" exactly. Opt-in, temporary. */
  allowEmailOtp: boolean;
  nowMs: number;
}

export type SignInMethod = "amr" | "email_otp" | "email_otp_or_policy";

export async function verifyAccess(req: Request, cfg: AccessConfig, net: Net): Promise<{ email: string; method: SignInMethod }> {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("access_jwt_missing");
  if (!cfg.teamDomain.startsWith("https://") || !cfg.aud || !cfg.approverEmail) throw new Error("access_not_configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("access_jwt_malformed");
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("access_jwt_alg");
  const certs = await net(new Request(cfg.teamDomain.replace(/\/$/, "") + "/cdn-cgi/access/certs"));
  if (!certs.ok) throw new Error("access_certs_unavailable");
  const { keys } = (await certs.json()) as { keys: JsonWebKey[] & { kid?: string }[] };
  const jwk = (keys as any[]).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("access_jwt_unknown_kid");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("access_jwt_signature");
  const now = Math.floor(cfg.nowMs / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("access_jwt_expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) throw new Error("access_jwt_not_yet_valid");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(cfg.aud)) throw new Error("access_jwt_aud");
  if (payload.iss !== cfg.teamDomain.replace(/\/$/, "")) throw new Error("access_jwt_iss");
  if (typeof payload.email !== "string" || payload.email.toLowerCase() !== cfg.approverEmail.toLowerCase()) throw new Error("access_wrong_identity");
  // Everything above (signature, alg, kid, exp, nbf, aud, iss, approver email) always applies.
  // Fail closed: an empty/missing REQUIRED_AMR or the unedited placeholder refuses every approval,
  // unless the narrow email-OTP bypass below applies.
  const required = cfg.requiredAmr.filter((a) => a && !/^REPLACE/i.test(a));
  const amr: unknown = payload.amr;
  if (required.length && Array.isArray(amr) && amr.some((a) => required.includes(a))) return { email: payload.email, method: "amr" };
  // TEMPORARY, only when ALLOW_EMAIL_OTP === "1". Two ways past the amr check, both still behind every
  // identity check above:
  //   1. idp.type === "cloudflare" (exact): Access's own one-time PIN -> method=email_otp.
  //   2. no amr claim AND no idp claim at all -> method=email_otp_or_policy (see FALLBACK below).
  // Anything else (idp present but not "cloudflare", idp null, amr present but not matching) must pass
  // REQUIRED_AMR. With the flag on, the security key is NOT checked here; the Access application must be
  // One-time PIN only, 15-minute session, the owner's email only.
  const idp: unknown = payload.idp;
  const idpType = idp && typeof idp === "object" ? (idp as { type?: unknown }).type : undefined;
  if (cfg.allowEmailOtp && idpType === "cloudflare") return { email: payload.email, method: "email_otp" };
  // FALLBACK: Cloudflare documents no idp claim in the Access app token. With the flag on,
  // a token with NO amr claim AND NO idp claim at all is accepted, trusting the Access policy (One-time PIN only,
  // 15-minute session) for how the owner signed in. An idp that is present but not "cloudflare" (including null),
  // or an amr that is present but doesn't match, still has to pass REQUIRED_AMR.
  if (cfg.allowEmailOtp && !("idp" in payload) && !("amr" in payload)) return { email: payload.email, method: "email_otp_or_policy" };
  if (!required.length) throw new Error("access_amr_not_configured");
  throw new Error("access_amr_not_passkey");
}
