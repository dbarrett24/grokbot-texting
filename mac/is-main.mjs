// In the repo this re-exports scripts/is-main.mjs, the one copy of the entry-point check.
// mac/install.sh installs scripts/is-main.mjs itself next to the helper under this name.
export * from "../scripts/is-main.mjs";
