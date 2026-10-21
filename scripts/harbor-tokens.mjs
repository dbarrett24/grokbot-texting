#!/usr/bin/env node
// @ts-check
// Copies the Everyday Harbor values the pages use from @evolve.ui/theme-system (pinned devDependency) into the
// generated block at the top of src/harbor.css, so the plain-CSS pages can't drift from the design system.
//   node scripts/harbor-tokens.mjs          rewrite the block
//   node scripts/harbor-tokens.mjs --check  exit 1 if the block differs from what theme-system gives (npm test runs this)
// OVERRIDES are Dave's Harbor picks that are on evolve-ui main (e3de05d, #89) but not yet in the published 1.2.0.
// When theme-system publishes them, the override becomes a no-op and --check fails until it is deleted here.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cssDir = require.resolve("@evolve.ui/theme-system/css/EverydayHarbor.css").replace(/EverydayHarbor\.css$/, "");
const TARGET = new URL("../src/harbor.css", import.meta.url);
const START = "/* @generated harbor-tokens: do not edit by hand; run node scripts/harbor-tokens.mjs */";
const END = "/* @end harbor-tokens */";

/** First `.brand-harbor { ... }` block of a theme-system CSS file, as name -> raw value.
 * @param {string} file @returns {Map<string, string>} */
function vars(file) {
  const css = readFileSync(cssDir + file, "utf8");
  const body = css.slice(css.indexOf(".brand-harbor {"), css.indexOf("}", css.indexOf(".brand-harbor {")));
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out.set(String(m[1]), String(m[2]).trim());
  return out;
}
const theme = vars("EverydayHarbor.css");
const fx = vars("EverydayHarbor.effects.css");
/** Resolves `var(--x)` chains in the theme file down to an "r g b" triplet, then to #rrggbb.
 * @param {string} name */
function color(name) {
  let v = theme.get(name);
  for (let i = 0; v && v.startsWith("var(--") && i < 5; i++) v = theme.get(v.slice(6, -1));
  if (!v || !/^\d+ \d+ \d+$/.test(v)) throw new Error(`theme-system: --${name} is not an rgb triplet (${v})`);
  return "#" + v.split(" ").map((/** @type {string} */ n) => Number(n).toString(16).padStart(2, "0")).join("");
}
const rgb = (/** @type {string} */ n) => { const v = fx.get(n); if (!v || !/^\d+ \d+ \d+$/.test(v)) throw new Error(`theme-system: --effect-${n} missing`); return "#" + v.split(" ").map((/** @type {string} */ x) => Number(x).toString(16).padStart(2, "0")).join(""); };
const raw = (/** @type {Map<string, string>} */ map, /** @type {string} */ n) => { const v = map.get(n); if (!v) throw new Error(`theme-system: --${n} missing`); return v; };

/** [published 1.2.0 value, value to use]. Each must match exactly, so a theme-system change is noticed.
 * @type {Record<string, [string, string] | undefined>} */
const OVERRIDES = {
  "cta-fill": ["linear-gradient(90deg, #f2cf7a, #e3b341 55%, #d9963e)", "linear-gradient(135deg, #f2cf7a, #e3b341 55%, #d9963e)"], // CTA angle 135deg
  backdrop: ["rgba(91, 155, 216, 0.38)", "rgba(91, 155, 216, 0.34)"], // glow alpha 0.34
};
/** @param {string} n */
function fxv(n) {
  let v = raw(fx, "effect-" + n);
  const o = OVERRIDES[n];
  if (o) { if (!v.includes(o[0])) throw new Error(`theme-system changed --effect-${n}; review OVERRIDES (${v})`); v = v.replace(o[0], o[1]); }
  return v;
}

export function tokens() {
  const t = {
    text: color("color-text-primary"), muted: rgb("effect-text-muted-rgb"), success: rgb("effect-text-success-rgb"),
    critical: rgb("effect-text-critical-glass-rgb"), link: color("color-link-primary"), focus: color("color-focus-primary"),
    border: color("color-border-primary"), "warning-bg": color("color-background-warning-light"), "warning-border": color("color-border-warning"),
    "cta-ink": rgb("effect-cta-ink-rgb"), solid: raw(fx, "effect-solid-fill"),
    backdrop: fxv("backdrop"), surface: fxv("surface-fill"), "surface-filter": fxv("surface-filter"), "surface-shadow": fxv("surface-shadow"),
    "hover-fill": fxv("hover-fill"), "cta-fill": fxv("cta-fill"), "cta-fill-hover": fxv("cta-fill-hover"), glow: fxv("glow"),
    "surface-radius": fxv("surface-radius"), "button-radius": raw(theme, "button-border-radius"), "input-radius": raw(theme, "input-border-radius"),
    serif: fxv("font-serif").replace("'Source Serif 4'", "'Source Serif 4 Harbor'"), sans: raw(theme, "font-family-primary"),
  };
  return t;
}
export function block() {
  const lines = Object.entries(tokens()).map(([k, v]) => `--h-${k}:${v};`);
  return `${START}\n:root{\n${lines.join("\n")}\n}\n${END}`;
}
const file = readFileSync(TARGET, "utf8");
const i = file.indexOf(START), j = file.indexOf(END);
if (i < 0 || j < 0) throw new Error("src/harbor.css: generated block markers missing");
const next = file.slice(0, i) + block() + file.slice(j + END.length);
if (process.argv.includes("--check")) {
  if (next !== file) { console.error("src/harbor.css is out of date with @evolve.ui/theme-system: run node scripts/harbor-tokens.mjs"); process.exit(1); }
  console.log("harbor tokens: in sync with @evolve.ui/theme-system");
} else writeFileSync(TARGET, next);
