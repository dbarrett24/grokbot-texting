// The repo check wired into `npm test`: 555 numbers outside 555-0100..0199 fail.
// Bad inputs are assembled at runtime (L + line) so this file itself passes the check.
import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { badExampleNumbers } from "../scripts/check-example-numbers.mjs";

const L = "555";
describe("scripts/check-example-numbers.mjs", () => {
  it.each([`call ${L}-1234`, `+1 202 ${L} 1234`, `(202) ${L}-9876`, `+1202${L}0200`, `202.${L}.4321`, `${L} 2368`])("rejects %j", (t) => {
    expect(badExampleNumbers(t)).toHaveLength(1);
  });
  it.each(["+15555550101", "+1 202 555 0142", "(202) 555-0199", "555-0100", "+447700900142", "id 15555", `version 1.${L}.1234x`])("accepts %j", (t) => {
    expect(badExampleNumbers(t)).toEqual([]);
  });
  it("reports the line number", () => {
    expect(badExampleNumbers(`ok\nring ${L}-1234\n`)).toEqual([{ line: 2, match: `${L}-1234` }]);
  });
});
