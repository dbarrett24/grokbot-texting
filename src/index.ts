import type { Env } from "./env";
export { Relay } from "./relay";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Single relay instance holds all state, so caps and single-use are serialized.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;
