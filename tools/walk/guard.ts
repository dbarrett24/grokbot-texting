// The walk entry only runs with the generated local config: WALK_LOCAL = "1" AND a reserved .invalid Access team domain.
export function walkAllowed(env: { ACCESS_TEAM_DOMAIN?: string; WALK_LOCAL?: string }): boolean {
  return env.WALK_LOCAL === "1" && /^https:\/\/[a-z0-9-]+\.invalid\/?$/.test(env.ACCESS_TEAM_DOMAIN || "");
}
