// @ts-check
// Repo-specific lint rules. Each one encodes a mistake that already shipped and was caught in review.
// The message says what to write instead, so it can be fixed without reading this file.

/**
 * Minimal shapes of the ESTree nodes these rules read (oxlint passes ESLint-compatible nodes).
 * @typedef {{ type: string, value?: unknown }} Node
 * @typedef {{ type: string, elements: (Node | null)[] }} ArrayNode
 * @typedef {{ type: string, expression: { type: string, typeAnnotation?: { type: string } } }} AsNode
 * @typedef {{ report: (d: { node: unknown, message: string }) => void }} Context
 */

/** F2 (PR #2, mac/relay-device.mjs:103 at 5900beb): `["--text", text]` lets a value that starts with "-" be read as an option. */
const argvFlagValue = {
  meta: { type: "problem", docs: { description: "argv: pass --flag=value, never --flag followed by a variable" } },
  /** @param {Context} context */
  create(context) {
    return {
      /** @param {ArrayNode} node */
      ArrayExpression(node) {
        const els = node.elements;
        for (let i = 0; i < els.length - 1; i++) {
          const a = els[i];
          const b = els[i + 1];
          if (!a || !b || a.type !== "Literal" || typeof a.value !== "string") continue;
          if (!/^--[a-z][a-z0-9-]*$/.test(a.value) || b.type === "Literal" || b.type === "SpreadElement") continue;
          context.report({ node: a, message: `argv: "${a.value}" is followed by a runtime value, which is read as an option if it starts with "-". Use \`"${a.value}=" + value\` (one element). See AGENTS.md rule R4.` });
        }
      },
    };
  },
};

/** `x as unknown as T` skips narrowing. Parse with a type guard that returns T or a refusal (AGENTS.md rule R2). */
const noDoubleCast = {
  meta: { type: "problem", docs: { description: "no `as unknown as T`" } },
  /** @param {Context} context */
  create(context) {
    return {
      /** @param {AsNode} node */
      TSAsExpression(node) {
        if (node.expression.type === "TSAsExpression" && node.expression.typeAnnotation?.type === "TSUnknownKeyword") {
          context.report({ node, message: "`as unknown as T` hides a type error. Narrow the value with a parser/type guard that returns T or a refusal (AGENTS.md rule R2)." });
        }
      },
    };
  },
};

export default { meta: { name: "relay" }, rules: { "argv-flag-value": argvFlagValue, "no-double-cast": noDoubleCast } };
