// Approve and Log page behaviour, inlined by toString() into the nonce'd module.
// The functions must not close over module scope. Methods, not nested function declarations:
// esbuild keepNames injects __name() beside a nested function, and toString() would ship that call.

export interface LiveEl {
  textContent: string;
  hidden: boolean;
  value: string;
  style: { display: string };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(sel: string): LiveEl | null;
  closest(sel: string): LiveEl | null;
  append(node: LiveEl): void;
  addEventListener(type: string, fn: (ev: LiveEvent) => void): void;
}

export interface LiveEvent {
  target: LiveEl | null;
  preventDefault(): void;
}

export interface LiveDoc {
  querySelector(sel: string): LiveEl | null;
  querySelectorAll(sel: string): Iterable<LiveEl>;
  createElement(tag: string): LiveEl;
  addEventListener(type: string, fn: (ev: LiveEvent) => void): void;
}

export interface LiveResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export interface ApproveLive {
  doc: LiveDoc;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  writeText: (text: string) => Promise<void>;
  submit: (form: LiveEl) => void;
}

export interface LogLive {
  doc: LiveDoc;
  fetchFn: (url: string) => Promise<LiveResponse>;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  writeText: (text: string) => Promise<void>;
}

export function approveLiveScript(): string {
  return `${installApprove.toString()}\n${installApprove.name}({doc:document,setTimer:setTimeout.bind(globalThis),clearTimer:clearTimeout.bind(globalThis),writeText:function(t){return navigator.clipboard.writeText(t)},submit:function(f){f.submit()}});`;
}

export function logLiveScript(): string {
  return `${installLog.toString()}\n${installLog.name}({doc:document,fetchFn:fetch.bind(globalThis),setTimer:setTimeout.bind(globalThis),clearTimer:clearTimeout.bind(globalThis),writeText:function(t){return navigator.clipboard.writeText(t)}});`;
}

export function installApprove(env: ApproveLive): void {
  const UNDO_MS = 5000;
  const doc = env.doc;
  let timer = 0;
  const ui = {
    toast(text: string): void {
      const el = doc.querySelector("#toast");
      if (!el) return;
      el.textContent = text;
      el.style.display = text ? "block" : "none";
    },
    undoBtn(): LiveEl | null {
      return doc.querySelector("#undo");
    },
  };
  const api = {
    onClick(ev: LiveEvent): void {
      const t = ev.target;
      if (!t) return;
      const act = t.getAttribute("data-act");
      if (act === "copy") {
        const card = t.closest("[data-card]");
        const num = card ? card.querySelector(".e164") : null;
        if (num) void env.writeText(num.textContent);
        return;
      }
      if (act === "undo") {
        env.clearTimer(timer);
        timer = 0;
        ui.toast("");
        const u = ui.undoBtn();
        if (u) u.hidden = true;
        return;
      }
      if (act === "approve") {
        ev.preventDefault();
        const form = t.closest("form");
        if (!form) return;
        ui.toast("Sending in 5 seconds.");
        const u = ui.undoBtn();
        if (u) u.hidden = false;
        env.clearTimer(timer);
        timer = env.setTimer(() => {
          const input = doc.createElement("input");
          input.setAttribute("type", "hidden");
          input.setAttribute("name", "action");
          input.setAttribute("value", "approve");
          form.append(input);
          env.submit(form);
        }, UNDO_MS);
      }
    },
  };
  doc.addEventListener("click", (ev) => api.onClick(ev));
}

export function installLog(env: LogLive): void {
  const LOG_UNDO_MS = 5000;
  const doc = env.doc;
  let dir = "all";
  let q = "";
  let timer = 0;
  const past: { dir: string; q: string }[] = [];
  const ui = {
    toast(text: string): void {
      const el = doc.querySelector("#toast");
      if (!el) return;
      el.textContent = text;
      el.style.display = text ? "block" : "none";
    },
    showUndo(on: boolean): void {
      const u = doc.querySelector("#undo");
      if (u) u.hidden = !on;
    },
    apply(): void {
      const needle = q.trim().toLowerCase();
      let n = 0;
      for (const li of doc.querySelectorAll("#list li")) {
        const d = li.getAttribute("data-dir") ?? "";
        const show = (dir === "all" || d === dir) && (!needle || li.textContent.toLowerCase().includes(needle));
        li.hidden = !show;
        if (show) n += 1;
      }
      const empty = doc.querySelector("#empty");
      if (empty) empty.hidden = n !== 0;
      for (const b of doc.querySelectorAll("[data-dir]")) {
        if (b.getAttribute("data-act") !== "filter") continue;
        b.setAttribute("aria-pressed", b.getAttribute("data-dir") === dir ? "true" : "false");
      }
    },
  };
  const api = {
    push(): void {
      past.push({ dir, q });
      ui.toast("Filter updated.");
      ui.showUndo(true);
      env.clearTimer(timer);
      timer = env.setTimer(() => {
        past.length = 0;
        ui.toast("");
        ui.showUndo(false);
      }, LOG_UNDO_MS);
    },
    undo(): void {
      const prev = past.pop();
      if (!prev) return;
      env.clearTimer(timer);
      dir = prev.dir;
      q = prev.q;
      const box = doc.querySelector("#q");
      if (box) box.value = q;
      ui.apply();
      ui.toast(past.length ? "Filter updated." : "");
      ui.showUndo(past.length > 0);
    },
    onClick(ev: LiveEvent): void {
      const t = ev.target;
      if (!t) return;
      const act = t.getAttribute("data-act");
      if (act === "undo") {
        api.undo();
        return;
      }
      if (act === "copy-num") {
        const id = t.getAttribute("data-id");
        if (!id) return;
        void env.fetchFn("/messages/" + id).then((r) => {
          if (!r.ok) {
            ui.toast("Couldn't copy.");
            return;
          }
          void r.json().then((j) => {
            const num = j && typeof j === "object" && !Array.isArray(j) ? (j as { number?: unknown }).number : null;
            if (typeof num === "string") void env.writeText(num);
          });
        });
        return;
      }
      if (act === "copy-body") {
        const card = t.closest("li");
        const body = card ? card.querySelector(".body") : null;
        if (body && body.getAttribute("data-stored") === "1") void env.writeText(body.textContent);
        return;
      }
      if (act === "filter") {
        const next = t.getAttribute("data-dir");
        if (next && next !== dir) {
          api.push();
          dir = next;
          ui.apply();
        }
      }
    },
    onInput(ev: LiveEvent): void {
      const t = ev.target;
      if (!t || t.getAttribute("id") !== "q") return;
      api.push();
      q = t.value;
      ui.apply();
    },
  };
  doc.addEventListener("click", (ev) => api.onClick(ev));
  const box = doc.querySelector("#q");
  if (box) box.addEventListener("input", (ev) => api.onInput(ev));
  ui.apply();
}
