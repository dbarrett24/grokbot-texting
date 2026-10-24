// Contacts page behaviour, inlined into the nonce'd module by contactsLiveScript().
// The function must not close over module scope: toString() is the script the browser runs.
// No on* attributes. Listeners are added here, and the page CSP stays script-src 'self' plus the nonce.

export interface LiveEvent {
  key?: string;
  shiftKey?: boolean;
  target: LiveEl | null;
  preventDefault(): void;
}

export interface LiveEl {
  textContent: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  checked: boolean;
  open: boolean;
  style: { display: string };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  append(...nodes: LiveEl[]): void;
  addEventListener(type: string, fn: (ev: LiveEvent) => void | Promise<void>): void;
  focus(): void;
  querySelector(sel: string): LiveEl | null;
  contains(node: LiveEl): boolean;
  remove(): void;
  showModal?(): void;
  close?(): void;
}

export interface LiveDoc {
  activeElement: LiveEl | null;
  createElement(tag: string): LiveEl;
  querySelector(sel: string): LiveEl | null;
  querySelectorAll(sel: string): Iterable<LiveEl>;
  addEventListener(type: string, fn: (ev: LiveEvent) => void | Promise<void>): void;
}

export interface LiveResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface LiveInit {
  method: string;
  headers: { [k: string]: string };
  body: string;
}

export type LiveFetch = (url: string, init?: LiveInit) => Promise<LiveResponse>;

export interface ContactsLive {
  doc: LiveDoc;
  fetchFn: LiveFetch;
  csrf: string;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  now: () => number;
  confirmFn: (message: string) => boolean;
  toastText: string | null;
}

/** The browser script. `installContacts.name` tracks a minifier rename so the call still matches toString(). */
export function contactsLiveScript(csrf: string, toastText: string | null): string {
  // bind: fetch, confirm and the timers throw if they are called with `this` set to the env object.
  return `const CSRF=${JSON.stringify(csrf)};\n${installContacts.toString()}\n${installContacts.name}({doc:document,fetchFn:fetch.bind(globalThis),csrf:CSRF,setTimer:setTimeout.bind(globalThis),clearTimer:clearTimeout.bind(globalThis),now:Date.now,confirmFn:confirm.bind(globalThis),toastText:${JSON.stringify(toastText)}});`;
}

export function installContacts(env: ContactsLive): void {
  const UNDO_MS = 5000;
  interface Person {
    key: string | null;
    name: string;
    label: string;
    last4: string;
    enabled: boolean;
    starred: boolean;
    migrated: boolean;
    isNew: boolean;
    readonly: boolean;
    undoFrom: boolean | null;
    timer: number;
    error: string;
    busy: boolean;
  }

  // Methods, not nested functions. esbuild keepNames injects a __name() call beside a nested
  // function, and toString() would ship that call without the helper (the page then throws).
  const doc = env.doc;
  const dom = {
    must(sel: string): LiveEl {
      const n = doc.querySelector(sel);
      if (!n) throw new Error("missing " + sel);
      return n;
    },
    el(tag: string): LiveEl {
      return doc.createElement(tag);
    },
  };
  const toastEl = dom.must("#toast");
  const q = dom.must("#q");
  const nAll = dom.must("#n-All");
  const nOn = dom.must("#n-On");
  const nOff = dom.must("#n-Off");
  const nStar = dom.must("#n-starred");
  const nMig = dom.must("#n-migrated");
  const nNew = dom.must("#n-new");
  const fcount = dom.must("#fcount");
  const countEl = dom.must("#count");
  const enall = dom.must("#enall");
  const pageEl = dom.must("#page");
  const prev = dom.must("#prev");
  const next = dom.must("#next");
  const perEl = dom.must("#per");
  const list = dom.must("#list");
  const fclear = dom.must("#fclear");
  const ask = dom.must("#ask");
  const askP = dom.must("#ask-p");
  const askNo = dom.must("#ask-no");
  const askYes = dom.must("#ask-yes");
  const live = dom.must("#live");
  const more = dom.must(".more");
  const review = doc.querySelector("#review");
  const migoff = doc.querySelector("#migoff");
  const segs: LiveEl[] = [];
  for (const b of doc.querySelectorAll("[data-s]")) segs.push(b);
  const boxes: LiveEl[] = [];
  for (const c of doc.querySelectorAll("[data-x]")) boxes.push(c);

  let rows: Person[] = [];
  let status = "All";
  const extra = new Set<string>();
  let page = 0;
  let toastTimer = 0;
  let pending: Person[] = [];

  const api = {
    message(e: unknown): string {
      return e instanceof Error ? e.message : "Error";
    },
    async readJson(r: LiveResponse): Promise<{ [k: string]: unknown }> {
      let raw: unknown;
      try {
        raw = await r.json();
      } catch {
        return {};
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: { [k: string]: unknown } = {};
      for (const [k, v] of Object.entries(raw)) out[k] = v;
      return out;
    },
    toast(t: string): void {
      toastEl.textContent = t;
      toastEl.style.display = "block";
      if (toastTimer) env.clearTimer(toastTimer);
      toastTimer = env.setTimer(() => { toastEl.style.display = "none"; }, 4000);
    },
    announce(t: string): void {
      live.textContent = "";
      live.textContent = t;
    },
    async post(path: string, body: { [k: string]: unknown }): Promise<{ [k: string]: unknown }> {
      const r = await env.fetchFn(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ csrf: env.csrf, ...body }) });
      const j = await api.readJson(r);
      if (!r.ok) {
        const m = j["message"];
        const err = j["error"];
        throw new Error(typeof m === "string" ? m : typeof err === "string" ? err : "http_" + String(r.status));
      }
      return j;
    },
    str(o: { [k: string]: unknown }, k: string): string | null {
      const v = o[k];
      return typeof v === "string" ? v : null;
    },
    personFrom(x: unknown): Person | null {
      if (!x || typeof x !== "object" || Array.isArray(x)) return null;
      const o: { [k: string]: unknown } = {};
      for (const [k, v] of Object.entries(x)) o[k] = v;
      const name = api.str(o, "name");
      const last4 = api.str(o, "last4");
      if (name === null || last4 === null) return null;
      const key = o["key"];
      return {
        key: typeof key === "string" ? key : null, name, label: api.str(o, "label") ?? "", last4,
        enabled: o["enabled"] === true, starred: o["starred"] === true, migrated: o["migrated"] === true,
        isNew: o["new"] === true, readonly: o["readonly"] === true, undoFrom: null, timer: 0, error: "", busy: false,
      };
    },
    flag(r: Person, k: string): boolean {
      switch (k) {
        case "starred": return r.starred;
        case "migrated": return r.migrated;
        case "new": return r.isNew;
        default: return false;
      }
    },
    matchQ(): Person[] {
      const query = q.value.trim().toLowerCase();
      return rows.filter((r) => query === "" || r.name.toLowerCase().includes(query));
    },
    base(): Person[] {
      return api.matchQ().filter((r) => { for (const k of extra) if (!api.flag(r, k)) return false; return true; });
    },
    shown(): Person[] {
      return api.base().filter((r) => status === "All" || (status === "On" && r.enabled) || (status === "Off" && !r.enabled));
    },
    pageSize(): number {
      const n = Number(perEl.value);
      if (n === 10 || n === 25 || n === 50 || n === 100) return n;
      return 25;
    },
    clearUndo(r: Person): void {
      if (r.timer) env.clearTimer(r.timer);
      r.timer = 0;
      r.undoFrom = null;
    },
    armUndo(r: Person, from: boolean): void {
      api.clearUndo(r);
      r.undoFrom = from;
      r.timer = env.setTimer(() => {
        r.undoFrom = null;
        r.timer = 0;
        if (!rows.some((x) => x.undoFrom !== null)) live.textContent = "";
        api.render();
      }, UNDO_MS);
    },
    who(r: Person, allow: boolean): LiveEl {
      const w = dom.el("div");
      w.className = "who";
      w.textContent = r.name;
      const sm = dom.el("small");
      sm.textContent = (allow ? "ALLOWLIST" : r.label) + " \u2022\u2022\u2022\u2022 " + r.last4 + (r.migrated ? " \u00b7 migrated" : "") + (r.isNew ? " \u00b7 new" : "");
      w.append(sm);
      if (r.error !== "") {
        const p = dom.el("p");
        p.className = "rowerr";
        p.setAttribute("role", "alert");
        p.textContent = r.error;
        w.append(p);
      }
      return w;
    },
    row(r: Person): LiveEl {
      const li = dom.el("li");
      const w = api.who(r, r.readonly);
      if (r.readonly) {
        const sp = dom.el("span");
        sp.className = "starsp";
        sp.setAttribute("aria-hidden", "true");
        const b = dom.el("span");
        b.className = "always";
        b.textContent = "Always on";
        li.append(sp, w, b);
        return li;
      }
      const st = dom.el("button");
      st.className = "star";
      st.setAttribute("type", "button");
      st.textContent = r.starred ? "\u2605" : "\u2606";
      st.setAttribute("aria-pressed", String(r.starred));
      st.setAttribute("aria-label", (r.starred ? "Unstar " : "Star ") + r.name);
      st.addEventListener("click", () => api.onStar(r));
      const sw = dom.el("button");
      sw.className = "sw";
      sw.setAttribute("type", "button");
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(r.enabled));
      sw.setAttribute("aria-label", "Bot may text " + r.name);
      if (r.key !== null) sw.setAttribute("data-sw", r.key);
      sw.addEventListener("click", () => api.onFlip(r));
      li.append(st, w);
      if (r.undoFrom !== null && r.key !== null) {
        const u = dom.el("button");
        u.className = "link undo";
        u.setAttribute("type", "button");
        u.textContent = "Undo";
        u.setAttribute("data-undo", r.key);
        u.setAttribute("aria-label", "Undo change for " + r.name);
        u.addEventListener("click", () => api.onUndo(r));
        li.append(u);
      }
      li.append(sw);
      return li;
    },
    render(): void {
      const b = api.base();
      const onCount = b.filter((r) => r.enabled).length;
      nAll.textContent = String(b.length);
      nOn.textContent = String(onCount);
      nOff.textContent = String(b.length - onCount);
      const matched = api.matchQ();
      nStar.textContent = String(matched.filter((r) => r.starred).length);
      nMig.textContent = String(matched.filter((r) => r.migrated).length);
      nNew.textContent = String(matched.filter((r) => r.isNew).length);
      fcount.textContent = String(extra.size);
      fcount.hidden = extra.size === 0;
      for (const btn of segs) btn.setAttribute("aria-pressed", String(btn.getAttribute("data-s") === status));
      const s = api.shown();
      const size = api.pageSize();
      const pages = Math.max(1, Math.ceil(s.length / size));
      if (page > pages - 1) page = pages - 1;
      if (page < 0) page = 0;
      const view = s.slice(page * size, (page + 1) * size);
      const off = s.filter((r) => !r.readonly && !r.enabled).length;
      countEl.textContent = String(s.length) + (s.length === 1 ? " person" : " people") + (off > 0 ? " \u00b7 " + String(off) + " off" : "");
      enall.hidden = off === 0;
      pageEl.textContent = s.length > 0 ? String(page * size + 1) + "\u2013" + String(page * size + view.length) + " of " + String(s.length) : "";
      prev.disabled = page <= 0;
      next.disabled = page + 1 >= pages;
      list.textContent = "";
      if (view.length === 0) {
        const li = dom.el("li");
        li.className = "empty";
        li.textContent = rows.length > 0 ? "No one matches. " : "No contacts yet. Connect a Google account above, then Sync now.";
        if (rows.length > 0 && (extra.size > 0 || status !== "All" || q.value !== "")) {
          const c = dom.el("button");
          c.className = "link";
          c.setAttribute("type", "button");
          c.textContent = "Clear filters";
          c.addEventListener("click", () => { api.clearAll(); });
          li.append(c);
        }
        list.append(li);
        return;
      }
      for (const r of view) list.append(api.row(r));
    },
    sort(): void {
      rows.sort((a, b) => Number(b.starred) - Number(a.starred) || a.name.localeCompare(b.name));
    },
    async load(): Promise<void> {
      const r = await env.fetchFn("/contacts/list");
      if (!r.ok) { api.toast("Could not load the list"); return; }
      const j = await api.readJson(r);
      const raw = j["people"];
      const nextRows: Person[] = [];
      if (Array.isArray(raw)) for (const item of raw) { const p = api.personFrom(item); if (p) nextRows.push(p); }
      rows = nextRows;
      api.sort();
      api.render();
    },
    setStatus(v: string): void {
      status = v;
      page = 0;
      api.render();
    },
    setExtra(k: string, on: boolean): void {
      if (k !== "starred" && k !== "migrated" && k !== "new") return;
      if (on) extra.add(k);
      else extra.delete(k);
      for (const c of boxes) if (c.getAttribute("data-x") === k) c.checked = on;
      page = 0;
      api.render();
    },
    clearAll(): void {
      q.value = "";
      extra.clear();
      for (const c of boxes) c.checked = false;
      api.setStatus("All");
    },
    async onStar(r: Person): Promise<void> {
      if (r.busy || r.key === null) return;
      r.busy = true;
      const starred = !r.starred;
      try {
        await api.post("/contacts/prefs", { changes: [{ key: r.key, starred }] });
        r.starred = starred;
        api.toast(starred ? "Starred " + r.name : "Unstarred " + r.name);
        api.sort();
        api.render();
      } catch (e) {
        api.toast("Error: " + api.message(e));
      } finally {
        r.busy = false;
      }
    },
    async onFlip(r: Person): Promise<void> {
      if (r.busy || r.readonly || r.key === null) return;
      const on = !r.enabled;
      r.busy = true;
      r.error = "";
      api.clearUndo(r);
      r.enabled = on;
      api.render();
      try {
        await api.post("/contacts/prefs", { changes: [{ key: r.key, enabled: on }] });
        r.migrated = false;
        api.armUndo(r, !on);
        api.announce(r.name + (on ? " is on. Undo." : " is off. Undo."));
        api.toast((on ? "On: " : "Off: ") + r.name);
        api.render();
        const u = doc.querySelector('[data-undo="' + r.key + '"]');
        if (u) u.focus();
      } catch (e) {
        r.enabled = !on;
        r.error = api.message(e);
        api.toast("Error: " + r.error);
        api.render();
        const sw = doc.querySelector('[data-sw="' + r.key + '"]');
        if (sw) sw.focus();
      } finally {
        r.busy = false;
      }
    },
    async onUndo(r: Person): Promise<void> {
      if (r.busy || r.undoFrom === null || r.key === null) return;
      const back = r.undoFrom;
      const applied = r.enabled;
      r.busy = true;
      api.clearUndo(r);
      r.error = "";
      r.enabled = back;
      api.render();
      try {
        await api.post("/contacts/prefs", { changes: [{ key: r.key, enabled: back }] });
        api.announce(r.name + (back ? " is on." : " is off."));
        api.toast("Undone: " + r.name);
        api.render();
        const sw = doc.querySelector('[data-sw="' + r.key + '"]');
        if (sw) sw.focus();
      } catch (e) {
        r.enabled = applied;
        r.error = api.message(e);
        api.toast("Error: " + r.error);
        api.render();
        const sw = doc.querySelector('[data-sw="' + r.key + '"]');
        if (sw) sw.focus();
      } finally {
        r.busy = false;
      }
    },
    closeAsk(): void {
      if (ask.open) { if (ask.close) ask.close(); else ask.removeAttribute("open"); }
      ask.open = false;
      enall.focus();
    },
    openAsk(): void {
      pending = api.shown().filter((r) => !r.readonly && !r.enabled && r.key !== null);
      if (!pending.length) { api.toast("Everyone shown is already on"); return; }
      askP.textContent = "Turn on " + String(pending.length) + " people? The bot can then text them.";
      if (ask.showModal) ask.showModal();
      ask.open = true;
      askNo.focus();
    },
    async enableAll(keys: string[], n: number): Promise<void> {
      try {
        const j = await api.post("/contacts/enable-all", { keys, confirm_count: n });
        const updated = j["updated"];
        const skipped = j["skipped_example"];
        const skip = typeof skipped === "number" && skipped > 0 ? " (" + String(skipped) + " example numbers skipped)" : "";
        api.toast("Turned on " + (typeof updated === "number" ? String(updated) : "0") + skip);
        await api.load();
      } catch (e) {
        api.toast("Error: " + api.message(e));
      }
    },
    async migratedOff(): Promise<void> {
      const n = rows.filter((r) => r.migrated && r.enabled).length;
      if (!env.confirmFn("Turn off all " + String(n) + " migrated people?")) return;
      try {
        const j = await api.post("/contacts/migrated-off", { confirm_count: n });
        const updated = j["updated"];
        api.toast("Turned off " + (typeof updated === "number" ? String(updated) : "0"));
        const banner = doc.querySelector("#banner");
        if (banner) banner.remove();
        await api.load();
      } catch (e) {
        api.toast("Error: " + api.message(e));
      }
    },
  };
  q.addEventListener("input", () => { page = 0; api.render(); });
  for (const b of segs) b.addEventListener("click", () => { const v = b.getAttribute("data-s"); if (v) api.setStatus(v); });
  for (const c of boxes) c.addEventListener("change", () => { const k = c.getAttribute("data-x"); if (k) api.setExtra(k, c.checked); });
  fclear.addEventListener("click", () => { extra.clear(); for (const c of boxes) c.checked = false; page = 0; api.render(); });
  perEl.addEventListener("change", () => { page = 0; api.render(); });
  prev.addEventListener("click", () => { page = Math.max(0, page - 1); api.render(); });
  next.addEventListener("click", () => { page += 1; api.render(); });
  enall.addEventListener("click", () => { api.openAsk(); });
  askNo.addEventListener("click", () => { api.closeAsk(); });
  askYes.addEventListener("click", () => {
    const keys: string[] = [];
    for (const r of pending) if (r.key !== null) keys.push(r.key);
    const n = keys.length;
    api.closeAsk();
    return api.enableAll(keys, n);
  });
  doc.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (ask.open) { ev.preventDefault(); api.closeAsk(); return; }
    if (more.open) {
      ev.preventDefault();
      more.open = false;
      const summary = more.querySelector("summary");
      if (summary) summary.focus();
    }
  });
  doc.addEventListener("click", (ev) => {
    const t = ev.target;
    if (more.open && t && !more.contains(t)) more.open = false;
  });
  if (review) review.addEventListener("click", () => { extra.clear(); for (const c of boxes) c.checked = false; api.setExtra("migrated", true); api.setStatus("All"); });
  if (migoff) migoff.addEventListener("click", () => api.migratedOff());
  for (const f of doc.querySelectorAll("form[data-confirm]")) {
    f.addEventListener("submit", (ev) => {
      const msg = f.getAttribute("data-confirm");
      if (!env.confirmFn(msg ?? "")) ev.preventDefault();
    });
  }
  if (env.toastText) api.toast(env.toastText);
  void api.load();
}
