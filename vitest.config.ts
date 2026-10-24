import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Obviously-fake test values only. Phone numbers are in the fictional 555-01xx range.
export const TEST_BINDINGS = {
  CAP_START_DATE: "2026-10-01",
  // Required vars with no default in the template. A Mountain-time zone so the -06:00 test times line up.
  TIMEZONE: "America/Edmonton",
  DEFAULT_COUNTRY_CODE: "+1",
  ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  REQUIRED_AMR: "test-passkey-amr",
  DISABLED: "0",
  ALLOW_EMAIL_OTP: "0",
  DIRECT_SEND: "0",
  // The template turns DIRECT_SEND on and both guard switches off. Tests pin DIRECT_SEND off and the guards ON,
  // and flip them per test, so every default is exercised on purpose.
  RUNAWAY_PAUSE: "1",
  CONTACTS_SNAPSHOT_ONLY: "1",
  REQUEST_HOST: "api.example.test",
  APPROVE_HOST: "approve.example.test",
  NOTIFY_MODE: "sms",
  REQUEST_TOKEN: "TEST-ONLY-request-token",
  ACCESS_AUD: "TEST-ONLY-aud",
  APPROVER_EMAIL: "approver@example.test",
  GATEWAY_USER: "TEST-ONLY-user",
  GATEWAY_PASS: "TEST-ONLY-pass",
  GATEWAY_DEVICE_ID: "test-device",
  GATEWAY_PINNED_FINGERPRINT: "SET-PER-TEST",
  GATEWAY_KEY_VERSION: "1",
  ALLOWLIST: JSON.stringify({ "+15555550101": "Test Friend", "+15555550102": "Test Two" }),
  OWNER_NUMBER: "+15555550100",
  LOG_HASH_KEY: "TEST-ONLY-log-hash-key-not-a-real-secret",
  GATEWAY_PASSPHRASE: "", // set per test; obvious fakes only
};

export default defineConfig({
  test: {
    projects: [
      {
        // Worker tests: run inside workerd via Miniflare.
        test: { name: "worker", include: ["test/**/*.test.ts"], setupFiles: ["test/phone-scan.ts"] },
        plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: TEST_BINDINGS,
        // Backstop: any real outbound request fails the test run.
        outboundService: () => {
          throw new Error("real network call attempted in tests");
        },
      },
    }),
        ],
      },
      {
        // Independent checks with Node's own crypto (not the Worker runtime).
        test: { name: "node", include: ["test-node/**/*.test.ts"], environment: "node", setupFiles: ["test-node/no-tty.setup.ts"] },
      },
    ],
  },
});
