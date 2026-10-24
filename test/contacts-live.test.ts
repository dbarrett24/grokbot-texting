// Contacts page behaviour (src/contacts-live.ts): switches, undo, filters, empty state, pager, and the Turn all on dialog.
// A small document double stands in for the browser. Names and keys are the walk/test fakes.
import { describe, expect, it } from "vitest";
import { installContacts, type ContactsLive, type LiveDoc, type LiveEl, type LiveEvent, type LiveFetch, type LiveResponse } from "../src/contacts-live";

const KEY_A = "ab".repeat(32);
const KEY_B = "cd".repeat(32);
const KEY_C = "ef".repeat(32);

interface Person {
  key: string | null;
  name: string;
  label: string;
  last4: string;
  enabled: boolean;
  starred: boolean;
  migrated: boolean;
  new: boolean;
  readonly: boolean;
}

class E implements LiveEl {
  tag: string;
  attrs: { [k: string]: string } = {};
  kids: E[] = [];
  parent: E | null = null;
  doc: Doc;
  text = "";
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  checked = false;
  open = false;
  style = { display: "" };
  listeners: { [k: string]: ((ev: LiveEvent) => void | Promise<void>)[] } = {};
  constructor(doc: Doc, tag: string) { this.doc = doc; this.tag = tag; }
  get textContent(): string { return this.text + this.kids.map((k) => k.textContent).join(""); }
  set textContent(v: string) { this.text = v; this.kids = []; }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  getAttribute(name: string): string | null { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? (this.attrs[name] ?? null) : null; }
  removeAttribute(name: string): void { delete this.attrs[name]; }
  append(...nodes: LiveEl[]): void {
    for (const n of nodes) {
      if (!(n instanceof E)) continue;
      n.parent = this;
      this.kids.push(n);
    }
  }
  addEventListener(type: string, fn: (ev: LiveEvent) => void | Promise<void>): void {
    (this.listeners[type] ??= []).push(fn);
  }
  focus(): void { this.doc.activeElement = this; }
  querySelector(sel: string): LiveEl | null { return this.queryAll(sel)[0] ?? null; }
  queryAll(sel: string): E[] {
    const out: E[] = [];
    const walk = (n: E) => { for (const k of n.kids) { if (k.matches(sel)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
  contains(node: LiveEl): boolean {
    if (node === this) return true;
    return this.kids.some((k) => k.contains(node));
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  showModal(): void {
    this.open = true;
    const btn = this.querySelector("button");
    if (btn) btn.focus();
  }
  close(): void { this.open = false; }
  matches(sel: string): boolean {
    if (sel.startsWith("#")) return this.getAttribute("id") === sel.slice(1);
    if (sel.startsWith(".")) return this.className.split(/\s+/).includes(sel.slice(1));
    const m = /^([a-z]+)?(?:\[([a-z0-9-]+)(?:="([^"]*)")?\])?$/i.exec(sel);
    if (!m) return false;
    const tag = m[1];
    const attr = m[2];
    const val = m[3];
    if (tag && this.tag !== tag) return false;
    if (!attr) return tag !== undefined;
    const have = this.getAttribute(attr);
    if (have === null) return false;
    return val === undefined || have === val;
  }
  async emit(type: string, extra: { key?: string; shiftKey?: boolean; target?: LiveEl | null } = {}): Promise<void> {
    const ev: LiveEvent = {
      target: extra.target === undefined ? this : extra.target,
      preventDefault() { /* the dialog and menu handlers call this */ },
    };
    if (extra.key !== undefined) ev.key = extra.key;
    if (extra.shiftKey !== undefined) ev.shiftKey = extra.shiftKey;
    for (const fn of this.listeners[type] ?? []) await fn(ev);
    if (this.parent) await this.parent.emit(type, { ...extra, target: ev.target });
  }
  click(): Promise<void> { return this.emit("click"); }
}

class Doc implements LiveDoc {
  activeElement: LiveEl | null = null;
  root: E;
  listeners: { [k: string]: ((ev: LiveEvent) => void | Promise<void>)[] } = {};
  constructor() { this.root = new E(this, "document"); }
  createElement(tag: string): LiveEl { return new E(this, tag); }
  querySelector(sel: string): LiveEl | null { return this.root.querySelector(sel); }
  querySelectorAll(sel: string): Iterable<LiveEl> { return this.root.queryAll(sel); }
  addEventListener(type: string, fn: (ev: LiveEvent) => void | Promise<void>): void {
    (this.listeners[type] ??= []).push(fn);
  }
  async emit(type: string, extra: { key?: string; target?: LiveEl | null } = {}): Promise<void> {
    const ev: LiveEvent = {
      target: extra.target === undefined ? null : extra.target,
      preventDefault() { /* recorded by the caller when it cares */ },
    };
    if (extra.key !== undefined) ev.key = extra.key;
    for (const fn of this.listeners[type] ?? []) await fn(ev);
  }
}

function add(doc: Doc, parent: E, tag: string, id?: string): E {
  const n = new E(doc, tag);
  if (id) n.setAttribute("id", id);
  parent.append(n);
  return n;
}

interface Harness {
  doc: Doc;
  people: Person[];
  calls: { url: string; body: string }[];
  timers: { id: number; fn: () => void; ms: number }[];
  confirms: string[];
  confirmOk: boolean;
  failPosts: number;
  list: E;
  enall: E;
  ask: E;
  askNo: E;
  askYes: E;
  more: E;
  summary: E;
}

function harness(people: Person[]): Harness {
  const doc = new Doc();
  const h: Harness = {
    doc, people, calls: [], timers: [], confirms: [], confirmOk: true, failPosts: 0,
    list: add(doc, doc.root, "ul", "list"), enall: add(doc, doc.root, "button", "enall"),
    ask: add(doc, doc.root, "dialog", "ask"), askNo: new E(doc, "button"), askYes: new E(doc, "button"),
    more: add(doc, doc.root, "details"), summary: new E(doc, "summary"),
  };
  h.more.className = "more";
  h.more.append(h.summary);
  h.ask.append(h.askNo, add(doc, h.ask, "p", "ask-p"), h.askYes);
  h.askNo.setAttribute("id", "ask-no");
  h.askYes.setAttribute("id", "ask-yes");
  for (const id of ["toast", "q", "n-All", "n-On", "n-Off", "n-starred", "n-migrated", "n-new", "fcount", "count", "page", "prev", "next", "per", "fclear", "live"]) add(doc, doc.root, "span", id);
  const per = doc.root.queryAll("#per")[0];
  if (per) per.value = "10";
  const q = doc.root.queryAll("#q")[0];
  if (q) q.value = "";
  h.enall.hidden = true;
  const fcount = doc.root.queryAll("#fcount")[0];
  if (fcount) fcount.hidden = true;
  for (const [id, name] of [["all", "All"], ["on", "On"], ["off", "Off"]] as const) {
    const b = add(doc, doc.root, "button");
    b.setAttribute("data-s", name);
    b.setAttribute("id", id);
  }
  const menu = add(doc, h.more, "div");
  for (const name of ["starred", "migrated", "new"]) {
    const box = add(doc, menu, "input");
    box.setAttribute("data-x", name);
  }
  let seq = 1;
  const fetchFn: LiveFetch = (url, init) => {
    if (url === "/contacts/list") {
      const body = { people: h.people };
      const res: LiveResponse = { ok: true, status: 200, json: () => Promise.resolve(body) };
      return Promise.resolve(res);
    }
    h.calls.push({ url, body: init?.body ?? "" });
    if (h.failPosts > 0) {
      h.failPosts -= 1;
      const res: LiveResponse = { ok: false, status: 422, json: () => Promise.resolve({ error: "example_number", message: "this looks like a documentation example" }) };
      return Promise.resolve(res);
    }
    if (url === "/contacts/enable-all") {
      const parsed = jsonObj(init?.body ?? "");
      const keys = parsed["keys"];
      if (Array.isArray(keys)) for (const p of h.people) if (p.key !== null && keys.includes(p.key)) p.enabled = true;
    }
    const res: LiveResponse = { ok: true, status: 200, json: () => Promise.resolve({ updated: 1, skipped_example: 0 }) };
    return Promise.resolve(res);
  };
  const env: ContactsLive = {
    doc, fetchFn, csrf: "a".repeat(32),
    setTimer: (fn, ms) => { const id = seq++; h.timers.push({ id, fn, ms }); return id; },
    clearTimer: (id) => { h.timers = h.timers.filter((t) => t.id !== id); },
    now: () => 0,
    confirmFn: (message) => { h.confirms.push(message); return h.confirmOk; },
    toastText: null,
  };
  installContacts(env);
  return h;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function jsonObj(s: string): { [k: string]: unknown } {
  const raw: unknown = JSON.parse(s);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: { [k: string]: unknown } = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v;
  return out;
}

function enabledOf(x: unknown): boolean | undefined {
  if (!x || typeof x !== "object" || Array.isArray(x) || !("enabled" in x)) return undefined;
  const enabled = x.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

function changeEnabled(body: string): boolean | undefined {
  const changes = jsonObj(body)["changes"];
  if (!Array.isArray(changes)) return undefined;
  for (const item of changes) return enabledOf(item);
  return undefined;
}

function switches(h: Harness): E[] {
  return h.list.queryAll('[role="switch"]');
}

function fire(h: Harness, ms: number): void {
  for (const t of h.timers.filter((x) => x.ms === ms)) t.fn();
}

const riley = (over: Partial<Person> = {}): Person => ({ key: KEY_A, name: "Walk Riley", label: "mobile", last4: "0101", enabled: false, starred: false, migrated: false, new: false, readonly: false, ...over });
const sam = (over: Partial<Person> = {}): Person => ({ key: KEY_B, name: "Walk Sam", label: "mobile", last4: "0102", enabled: false, starred: false, migrated: false, new: false, readonly: false, ...over });

describe("switch, undo, and row errors", () => {
  it("a switch is role=switch with aria-checked, no On/Off text, and a  flip applies without confirm", async () => {
    const h = harness([riley(), sam({ enabled: true })]);
    await settle();
    const sw = switches(h);
    expect(sw).toHaveLength(2);
    expect(sw[0]?.getAttribute("role")).toBe("switch");
    expect(sw[0]?.getAttribute("aria-checked")).toBe("false");
    expect(sw[0]?.getAttribute("aria-label")).toBe("Bot may text Walk Riley");
    expect(sw[0]?.textContent).toBe("");
    expect(sw[1]?.getAttribute("aria-checked")).toBe("true");
    await sw[0]?.click();
    expect(h.confirms).toEqual([]);
    expect(h.calls.map((c) => c.url)).toEqual(["/contacts/prefs"]);
    expect(changeEnabled(h.calls[0]?.body ?? "")).toBe(true);
    const after = switches(h);
    expect(after[0]?.getAttribute("aria-checked")).toBe("true");
    const undo = h.list.queryAll('[data-undo="' + KEY_A + '"]')[0];
    expect(undo?.textContent).toBe("Undo");
    expect(undo?.tag).toBe("button");
    expect(h.doc.activeElement).toBe(undo);
    expect(h.doc.querySelector("#live")?.textContent).toContain("Undo");
    expect(h.timers.some((t) => t.ms === 5000)).toBe(true);
  });

  it("Undo sends the reverse prefs write and puts the switch back; after 5s the Undo is gone", async () => {
    const h = harness([riley()]);
    await settle();
    await switches(h)[0]?.click();
    const undo = h.list.queryAll(".undo")[0];
    await undo?.click();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.url).toBe("/contacts/prefs");
    expect(changeEnabled(h.calls[1]?.body ?? "")).toBe(false);
    expect(switches(h)[0]?.getAttribute("aria-checked")).toBe("false");
    expect(h.list.queryAll(".undo")).toHaveLength(0);
    const again = harness([riley()]);
    await settle();
    await switches(again)[0]?.click();
    expect(again.list.queryAll(".undo")).toHaveLength(1);
    fire(again, 5000);
    expect(again.list.queryAll(".undo")).toHaveLength(0);
    expect(switches(again)[0]?.getAttribute("aria-checked")).toBe("true");
    expect(again.calls).toHaveLength(1);
  });

  it("a failed flip reverts the switch and shows the error on the row; a failed Undo does too", async () => {
    const h = harness([riley()]);
    h.failPosts = 1;
    await settle();
    await switches(h)[0]?.click();
    expect(switches(h)[0]?.getAttribute("aria-checked")).toBe("false");
    expect(h.list.queryAll(".rowerr")[0]?.textContent).toBe("this looks like a documentation example");
    expect(h.list.queryAll(".rowerr")[0]?.getAttribute("role")).toBe("alert");
    expect(h.list.queryAll(".undo")).toHaveLength(0);
    await switches(h)[0]?.click();
    expect(switches(h)[0]?.getAttribute("aria-checked")).toBe("true");
    h.failPosts = 1;
    await h.list.queryAll(".undo")[0]?.click();
    expect(switches(h)[0]?.getAttribute("aria-checked")).toBe("true");
    expect(h.list.queryAll(".rowerr")[0]?.textContent).toBe("this looks like a documentation example");
    expect(h.calls).toHaveLength(3);
    expect(changeEnabled(h.calls[2]?.body ?? "")).toBe(false);
  });
});

describe("ALLOWLIST, empty state, pager, filters", () => {
  it("an ALLOWLIST row says Always on once and has no switch", async () => {
    const allow: Person = { key: null, name: "Walk Friend", label: "always on (ALLOWLIST)", last4: "0100", enabled: true, starred: false, migrated: false, new: false, readonly: true };
    const h = harness([allow, riley()]);
    await settle();
    const row = h.list.kids[0];
    expect(row?.textContent).toContain("ALLOWLIST");
    expect(row?.textContent).toContain("Always on");
    expect(row?.textContent.match(/Always on/g)).toEqual(["Always on"]);
    expect(row?.textContent).not.toContain("always on (ALLOWLIST)");
    expect(row?.queryAll('[role="switch"]')).toHaveLength(0);
    expect(h.list.queryAll(".always")).toHaveLength(1);
  });

  it("an empty filter shows No one matches and Clear filters restores the list", async () => {
    const h = harness([riley(), sam()]);
    await settle();
    const on = h.doc.root.queryAll("#on")[0];
    await on?.click();
    const empty = h.list.queryAll(".empty")[0];
    expect(empty?.textContent).toContain("No one matches.");
    const clear = empty?.queryAll("button")[0];
    expect(clear?.textContent).toBe("Clear filters");
    await clear?.click();
    expect(h.list.queryAll(".empty")).toHaveLength(0);
    expect(switches(h)).toHaveLength(2);
    expect(h.doc.root.queryAll("#all")[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("the pager reads 1–10 of 12 and the next page is 11–12 of 12", async () => {
    const people: Person[] = [];
    for (let i = 0; i < 12; i++) people.push({ key: (i % 2 === 0 ? "ab" : "cd").repeat(31) + i.toString(16).padStart(2, "0"), name: "Walk Person " + String(i), label: "mobile", last4: String(1000 + i), enabled: false, starred: false, migrated: false, new: false, readonly: false });
    const h = harness(people);
    await settle();
    expect(h.doc.querySelector("#page")?.textContent).toBe("1\u201310 of 12");
    expect(h.doc.querySelector("#prev")?.disabled).toBe(true);
    await h.doc.root.queryAll("#next")[0]?.click();
    expect(h.doc.querySelector("#page")?.textContent).toBe("11\u201312 of 12");
    expect(h.doc.querySelector("#next")?.disabled).toBe(true);
  });

  it("Filters combine with On, and the badge counts them", async () => {
    const h = harness([riley({ starred: true, enabled: true }), sam({ migrated: true }), { key: KEY_C, name: "Walk Alex", label: "work", last4: "0103", enabled: false, starred: false, migrated: true, new: true, readonly: false }]);
    await settle();
    expect(h.doc.querySelector("#fcount")?.hidden).toBe(true);
    expect(h.doc.querySelector("#n-All")?.textContent).toBe("3");
    expect(h.doc.querySelector("#n-On")?.textContent).toBe("1");
    expect(h.doc.querySelector("#n-Off")?.textContent).toBe("2");
    const migrated = h.more.queryAll('[data-x="migrated"]')[0];
    if (migrated) migrated.checked = true;
    await migrated?.emit("change");
    expect(h.doc.querySelector("#fcount")?.hidden).toBe(false);
    expect(h.doc.querySelector("#fcount")?.textContent).toBe("1");
    expect(h.doc.querySelector("#n-All")?.textContent).toBe("2");
    await h.doc.root.queryAll("#on")[0]?.click();
    expect(switches(h)).toHaveLength(0);
    expect(h.list.queryAll(".empty")).toHaveLength(1);
  });
});

describe("Turn all on dialog", () => {
  it("confirm posts the bulk change and focus returns; cancel and Esc change nothing and return focus", async () => {
    const h = harness([riley(), sam(), sam({ key: KEY_C, name: "Walk Alex", enabled: true })]);
    await settle();
    h.enall.focus();
    await h.enall.click();
    expect(h.ask.open).toBe(true);
    expect(h.doc.querySelector("#ask-p")?.textContent).toBe("Turn on 2 people? The bot can then text them.");
    expect(h.doc.activeElement).toBe(h.askNo);
    expect(h.calls).toEqual([]);
    await h.askNo.click();
    expect(h.ask.open).toBe(false);
    expect(h.doc.activeElement).toBe(h.enall);
    expect(h.calls).toEqual([]);
    await h.enall.click();
    await h.doc.emit("keydown", { key: "Escape" });
    expect(h.ask.open).toBe(false);
    expect(h.doc.activeElement).toBe(h.enall);
    expect(h.calls).toEqual([]);
    await h.enall.click();
    expect(h.doc.activeElement).toBe(h.askNo);
    await h.askYes.click();
    expect(h.ask.open).toBe(false);
    expect(h.doc.activeElement).toBe(h.enall);
    expect(h.calls.map((c) => c.url)).toEqual(["/contacts/enable-all"]);
    const body = jsonObj(h.calls[0]?.body ?? "");
    expect(body["confirm_count"]).toBe(2);
    expect(body["keys"]).toEqual([KEY_A, KEY_B]);
    expect(h.people.filter((p) => p.enabled).map((p) => p.name).sort()).toEqual(["Walk Alex", "Walk Riley", "Walk Sam"]);
  });

  it("Escape closes the Filters menu and focuses its summary", async () => {
    const h = harness([riley()]);
    await settle();
    h.more.open = true;
    await h.doc.emit("keydown", { key: "Escape" });
    expect(h.more.open).toBe(false);
    expect(h.doc.activeElement).toBe(h.summary);
  });
});
