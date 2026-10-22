// LOCAL WALK HARNESS ONLY. Turns a browser request to 127.0.0.1 / localhost into the request the Worker
// would see on the approve host: https, the approve hostname, a walk Access token, no Authorization.
// The page's own Origin (the local address) is mapped to the approve host too, so same-Origin POSTs from
// the walk page pass. Any other Origin is passed through untouched and still refused.
export function walkForward(req: Request, jwt: string, approveHost: string): Request {
  const url = new URL(req.url);
  const localOrigin = url.origin;
  url.hostname = approveHost;
  url.port = "";
  url.protocol = "https:";
  const headers = new Headers(req.headers);
  headers.set("Cf-Access-Jwt-Assertion", jwt);
  headers.delete("Authorization");
  if (headers.get("Origin") === localOrigin) headers.set("Origin", url.origin);
  return new Request(url, { method: req.method, headers, body: req.body, redirect: "manual" });
}
