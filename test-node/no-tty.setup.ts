// Suite guard for the Node project: any /dev/tty open or real-TTY stdin read throws.
// The worker project does not spawn setup dialogs; its runtime has no node:fs to patch.
// @ts-expect-error plain .mjs script, no types
import { installNoTtyGuard } from "../scripts/no-tty-guard.mjs";

/** @type {() => void} */
const install = installNoTtyGuard;
install();
