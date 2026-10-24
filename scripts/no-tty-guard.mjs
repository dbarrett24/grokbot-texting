// Installed while tests run (vitest setup, and setup-lib when VITEST or SETUP_NONINTERACTIVE is set).
// Opening /dev/tty or reading a TTY stdin throws, so the suite fails instead of prompting.
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const REFUSE_OPEN = "refusing_tty_open:/dev/tty";
const REFUSE_STDIN = "refusing_tty_stdin";

/**
 * @typedef {import("node:fs").PathLike} PathLike
 * @typedef {import("node:fs").OpenMode} OpenMode
 * @typedef {(err: NodeJS.ErrnoException | null, fd: number) => void} OpenCb
 * @typedef {(err: NodeJS.ErrnoException | null, data: string | Buffer) => void} ReadCb
 * Simple callable shapes. Node's real exports are overloaded; tests only need the path check.
 * @typedef {{
 *   openSync: (path: PathLike, flags: OpenMode, mode?: import("node:fs").Mode | null) => number,
 *   open: (path: PathLike, flags: OpenMode, mode?: OpenMode | OpenCb, cb?: OpenCb) => void,
 *   readFile: (path: PathLike | number, options?: unknown, cb?: ReadCb) => void,
 *   createReadStream: (path: PathLike, options?: unknown) => import("node:fs").ReadStream,
 *   promises: {
 *     open: (path: PathLike, flags?: OpenMode, mode?: import("node:fs").Mode) => Promise<import("node:fs/promises").FileHandle>,
 *     readFile: (path: PathLike | import("node:fs/promises").FileHandle, options?: unknown) => Promise<string | Buffer>,
 *   },
 * }} MutableFs
 */

/**
 * @param {(id: string) => unknown} load
 * @returns {MutableFs}
 */
function loadFs(load) {
  const loaded = load("node:fs");
  if (!isFs(loaded)) throw new Error("node_fs_unavailable");
  return loaded;
}

/** @param {unknown} v @returns {v is MutableFs} */
function isFs(v) {
  if (!v || typeof v !== "object") return false;
  if (!("openSync" in v) || typeof v.openSync !== "function") return false;
  if (!("open" in v) || typeof v.open !== "function") return false;
  if (!("readFile" in v) || typeof v.readFile !== "function") return false;
  if (!("createReadStream" in v) || typeof v.createReadStream !== "function") return false;
  if (!("promises" in v) || !v.promises || typeof v.promises !== "object") return false;
  return "open" in v.promises && typeof v.promises.open === "function" && "readFile" in v.promises && typeof v.promises.readFile === "function";
}

/** @param {unknown} p */
export function isTtyPath(p) {
  if (typeof p === "string") return p === "/dev/tty";
  if (p instanceof URL) return p.pathname === "/dev/tty";
  return false;
}

/** @param {unknown} p */
function refusePath(p) {
  if (isTtyPath(p)) throw new Error(REFUSE_OPEN);
}

/**
 * @param {unknown} err
 * @param {unknown} cb
 * @returns {void}
 */
function failOpen(err, cb) {
  const error = err instanceof Error ? err : new Error(REFUSE_OPEN);
  if (typeof cb !== "function") throw error;
  const call = /** @type {(e: Error) => void} */ (cb);
  call(error);
}

let installed = false;

/**
 * ESM `import { openSync } from "node:fs"` keeps its own binding, so replacing
 * `require("node:fs").openSync` does not affect it. Both call `process.binding("fs")`.
 * @returns {void}
 */
function patchFsBinding() {
  const bindingFn = /** @type {{ binding?: (name: string) => unknown }} */ (process).binding;
  if (typeof bindingFn !== "function") return;
  const loaded = bindingFn("fs");
  if (!loaded || typeof loaded !== "object") return;
  const binding = /** @type {Record<string, unknown>} */ (loaded);
  for (const name of ["open", "openFileHandle"]) {
    const current = binding[name];
    if (typeof current !== "function") continue;
    const orig = /** @type {(this: unknown, path: unknown, ...rest: unknown[]) => unknown} */ (current);
    /**
     * @this {unknown}
     * @param {unknown} path
     * @param {...unknown} rest
     * @returns {unknown}
     */
    function guardedOpen(path, ...rest) {
      refusePath(path);
      return orig.call(this, path, ...rest);
    }
    binding[name] = guardedOpen;
  }
}

/** Patch this process. Idempotent. */
export function installNoTtyGuard() {
  if (installed) return;
  installed = true;
  patchFsBinding();
  const fs = loadFs(nodeRequire);
  const openSync = fs.openSync;
  const open = fs.open;
  const readFile = fs.readFile;
  const createReadStream = fs.createReadStream;
  const openPromise = fs.promises.open;
  const readFilePromise = fs.promises.readFile;
  fs.openSync = (p, flags, mode) => { refusePath(p); return openSync(p, flags, mode); };
  fs.open = (p, flags, mode, cb) => {
    try { refusePath(p); } catch (err) { return failOpen(err, typeof mode === "function" ? mode : cb); }
    if (typeof mode === "function") return open(p, flags, mode);
    return open(p, flags, mode, cb);
  };
  fs.readFile = (p, options, cb) => {
    try { refusePath(p); } catch (err) { return failOpen(err, typeof options === "function" ? options : cb); }
    if (typeof options === "function") return readFile(p, options);
    return readFile(p, options, cb);
  };
  fs.createReadStream = (p, options) => { refusePath(p); return createReadStream(p, options); };
  fs.promises.open = async (p, flags, mode) => { refusePath(p); return openPromise(p, flags, mode); };
  fs.promises.readFile = async (p, options) => { refusePath(p); return readFilePromise(p, options); };
  const stdin = process.stdin;
  if (stdin.isTTY) {
    const boom = () => { throw new Error(REFUSE_STDIN); };
    stdin.read = boom;
    stdin.resume = () => { boom(); return stdin; };
  }
}
