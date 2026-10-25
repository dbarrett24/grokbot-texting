// Approve and Log behaviour without a browser: undo, copy, filters, split numbers, and the template flags.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { looksLikePhone } from "../src/direct";
import { splitE164 } from "../src/pages";
import { installApprove, installLog, type LiveDoc, type LiveEl, type LiveEvent } from "../src/pages-live";

const FRIEND = "+15555550101";

class El implements LiveEl {
  private text = "";
  hidden = false;
  value = "";
  style = { display: "" };
  kids: El[] = [];
  parent: El | null = null;
  attrs: { [k: string]: string } = {};
  listeners: { [k: string]: ((ev: LiveEvent) => void)[] } = {};
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text + this.kids.map((k) => k.textContent).join(""); }
  set textContent(v: string) { this.text = v; this.kids = []; }
  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? (this.attrs[name] ?? null) : null;
  }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  append(node: LiveEl): void {
    if (!(node instanceof El)) return;
    node.parent = this;
    this.kids.push(node);
  }
  addEventListener(type: string, fn: (ev: LiveEvent) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  querySelector(sel: string): LiveEl | null { return this.queryAll(sel)[0] ?? null; }
  closest(sel: string): LiveEl | null {
    if (this.matches(sel)) return this;
    return this.parent ? this.parent.closest(sel) : null;
  }
  matches(sel: string): boolean {
    if (sel.startsWith("#")) return this.getAttribute("id") === sel.slice(1);
    if (sel.startsWith(".")) return (this.getAttribute("class") ?? "").split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith("[") && sel.endsWith("]")) {
      const body = sel.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq < 0) return this.getAttribute(body) !== null;
      const key = body.slice(0, eq);
      const raw = body.slice(eq + 1);
      const val = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
      return this.getAttribute(key) === val;
    }
    return this.tag === sel;
  }
  queryAll(sel: string): El[] {
    const space = sel.indexOf(" ");
    if (space > 0) {
      const head = sel.slice(0, space);
      const tail = sel.slice(space + 1);
      const out: El[] = [];
      for (const parent of this.queryAll(head)) out.push(...parent.queryAll(tail));
      return out;
    }
    const out: El[] = [];
    const walk = (n: El): void => {
      for (const k of n.kids) { if (k.matches(sel)) out.push(k); walk(k); }
    };
    walk(this);
    return out;
  }
  fire(type: string): void {
    const ev: LiveEvent = { target: this, preventDefault() { /* the filter does not cancel input */ } };
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

class Doc implements LiveDoc {
  root = new El("document");
  prevented = false;
  listeners: { [k: string]: ((ev: LiveEvent) => void)[] } = {};
  createElement(tag: string): LiveEl { return new El(tag); }
  querySelector(sel: string): LiveEl | null { return this.root.querySelector(sel); }
  querySelectorAll(sel: string): Iterable<LiveEl> { return this.root.queryAll(sel); }
  addEventListener(type: string, fn: (ev: LiveEvent) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string, target: El): void {
    const ev: LiveEvent = { target, preventDefault: () => { this.prevented = true; } };
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

function el(tag: string, attrs: { [k: string]: string } = {}): El {
  const node = new El(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

interface Timer { id: number; ms: number; fn: () => void }

function clock(): { timers: Timer[]; setTimer: (fn: () => void, ms: number) => number; clearTimer: (id: number) => void } {
  const timers: Timer[] = [];
  let n = 1;
  return {
    timers,
    setTimer(fn, ms) { const id = n++; timers.push({ id, ms, fn }); return id; },
    clearTimer(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("split numbers", () => {
  it("the HTML source is not a phone number and the visible text is the full number", () => {
    const html = splitE164(FRIEND);
    expect(looksLikePhone(html)).toBe(false);
    expect(html.replace(/<[^>]+>/g, "")).toBe(FRIEND);
    expect(html).toContain("<span>+</span><span>155</span><span>555</span><span>501</span><span>01</span>");
  });
});

describe("approve undo and copy", () => {
  it("waits 5 seconds, undo cancels the send, and copy writes the full number", () => {
    const doc = new Doc();
    const card = el("article", { "data-card": "1" });
    const num = el("span", { class: "e164" });
    num.textContent = FRIEND;
    const copy = el("button", { "data-act": "copy" });
    const form = el("form");
    const approve = el("button", { "data-act": "approve" });
    const undo = el("button", { id: "undo", "data-act": "undo" });
    undo.hidden = true;
    card.append(num);
    card.append(copy);
    form.append(approve);
    card.append(form);
    doc.root.append(el("div", { id: "toast" }));
    doc.root.append(undo);
    doc.root.append(card);
    const t = clock();
    const written: string[] = [];
    const submitted: LiveEl[] = [];
    installApprove({ doc, setTimer: t.setTimer, clearTimer: t.clearTimer, writeText: (text) => { written.push(text); return Promise.resolve(); }, submit: (f) => { submitted.push(f); } });
    doc.fire("click", copy);
    expect(written).toEqual([FRIEND]);
    doc.fire("click", approve);
    expect(doc.prevented).toBe(true);
    expect(t.timers.map((x) => x.ms)).toEqual([5000]);
    expect(submitted).toHaveLength(0);
    doc.fire("click", undo);
    expect(t.timers).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    doc.fire("click", approve);
    t.timers[0]?.fn();
    expect(submitted).toEqual([form]);
    expect(form.kids.some((k) => k.getAttribute("name") === "action" && k.getAttribute("value") === "approve")).toBe(true);
  });
});

describe("log filters, undo and copy", () => {
  function page(): { doc: Doc; inn: El; out: El; box: El; buttons: { all: El; inb: El; outb: El }; t: ReturnType<typeof clock>; written: string[]; fetched: string[] } {
    const doc = new Doc();
    const inn = el("li", { "data-dir": "in" });
    const innText = el("span");
    innText.textContent = "alpha inbound note";
    const body = el("span", { class: "body", "data-stored": "1" });
    body.textContent = "alpha inbound note";
    const copyNum = el("button", { "data-act": "copy-num", "data-id": "abc" });
    const copyBody = el("button", { "data-act": "copy-body" });
    inn.append(innText);
    inn.append(body);
    inn.append(copyNum);
    inn.append(copyBody);
    const out = el("li", { "data-dir": "out" });
    const outText = el("span");
    outText.textContent = "beta outbound note";
    out.append(outText);
    const list = el("ul", { id: "list" });
    list.append(inn);
    list.append(out);
    const box = el("input", { id: "q" });
    const all = el("button", { "data-act": "filter", "data-dir": "all" });
    const inb = el("button", { "data-act": "filter", "data-dir": "in" });
    const outb = el("button", { "data-act": "filter", "data-dir": "out" });
    const undo = el("button", { id: "undo", "data-act": "undo" });
    doc.root.append(el("div", { id: "toast" }));
    doc.root.append(undo);
    doc.root.append(box);
    doc.root.append(all);
    doc.root.append(inb);
    doc.root.append(outb);
    doc.root.append(list);
    doc.root.append(el("p", { id: "empty" }));
    const t = clock();
    const written: string[] = [];
    const fetched: string[] = [];
    installLog({
      doc,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      writeText: (text) => { written.push(text); return Promise.resolve(); },
      fetchFn: (url) => { fetched.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve({ number: FRIEND }) }); },
    });
    return { doc, inn, out, box, buttons: { all, inb, outb }, t, written, fetched };
  }

  it("filters by direction and search, and undo restores the previous filter within 5 seconds", () => {
    const p = page();
    expect(p.inn.hidden).toBe(false);
    expect(p.out.hidden).toBe(false);
    p.doc.fire("click", p.buttons.inb);
    expect(p.inn.hidden).toBe(false);
    expect(p.out.hidden).toBe(true);
    expect(p.t.timers.map((x) => x.ms)).toEqual([5000]);
    expect(p.buttons.inb.getAttribute("aria-pressed")).toBe("true");
    p.doc.fire("click", p.doc.root.queryAll("#undo")[0] ?? p.buttons.all);
    expect(p.inn.hidden).toBe(false);
    expect(p.out.hidden).toBe(false);
    expect(p.t.timers).toHaveLength(0);
    p.box.value = "beta";
    p.box.fire("input");
    expect(p.inn.hidden).toBe(true);
    expect(p.out.hidden).toBe(false);
    expect(p.t.timers.map((x) => x.ms)).toEqual([5000]);
    p.doc.fire("click", p.doc.root.queryAll("#undo")[0] ?? p.buttons.all);
    expect(p.box.value).toBe("");
    expect(p.inn.hidden).toBe(false);
    expect(p.out.hidden).toBe(false);
  });

  it("copies the full number from the messages endpoint and the body from the page", async () => {
    const p = page();
    const copyNum = p.inn.queryAll("[data-act=copy-num]")[0];
    const copyBody = p.inn.queryAll("[data-act=copy-body]")[0];
    if (!copyNum || !copyBody) throw new Error("buttons");
    p.doc.fire("click", copyNum);
    await flush();
    expect(p.fetched).toEqual(["/messages/abc"]);
    expect(p.written).toEqual([FRIEND]);
    p.doc.fire("click", copyBody);
    expect(p.written).toEqual([FRIEND, "alpha inbound note"]);
    const hidden = el("span", { class: "body", "data-stored": "0" });
    hidden.textContent = "not this";
    const card = el("li");
    const blocked = el("button", { "data-act": "copy-body" });
    card.append(hidden);
    card.append(blocked);
    p.doc.root.append(card);
    p.doc.fire("click", blocked);
    expect(p.written).toEqual([FRIEND, "alpha inbound note"]);
  });
});

describe("template flags", () => {
  it("ships both store flags off, documents LOG_ENC_KEY, and seeds no messages", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toContain('STORE_MESSAGE_BODIES = "0"');
    expect(toml).toContain('CAPTURE_INBOUND = "0"');
    expect(toml).not.toMatch(/^LOG_ENC_KEY\s*=/m);
    expect(toml).toContain("LOG_ENC_KEY");
    const sql = readFileSync(new URL("../migrations/0002_messages.sql", import.meta.url), "utf8");
    expect(sql).not.toMatch(/insert/i);
    expect(sql).toContain("30");
    expect(sql).toContain("90");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("Inbound texts");
    expect(readme).toContain("30 days");
    expect(readme).toContain("90 days");
    expect(readme).toContain("purge-all");
    expect(readme).toContain("LOG_ENC_KEY");
    const pages = readFileSync(new URL("../src/pages.ts", import.meta.url), "utf8");
    const url = /export const SUPPORT_URL = "([^"]+)"/.exec(pages)?.[1] ?? "";
    const label = /export const SUPPORT_LABEL = "([^"]+)"/.exec(pages)?.[1] ?? "";
    expect(url).toBe("https://dave-barrett.kit.com/products/buy-me-a-drink");
    expect(pages).not.toContain("example.com");
    expect(readme).not.toMatch(/example\.com\/drink/);
    expect(label).toBe("☕ Buy me a drink");
    expect(pages).toContain('href="${esc(SUPPORT_URL)}" rel="noopener noreferrer"');
    expect(pages).toContain("SUPPORT_LABEL.slice(gap + 1)");
    const badge = `https://img.shields.io/badge/${encodeURIComponent(label)}-12223a?style=flat`;
    expect(readme).toContain(`[![${label}](${badge})](${url})`);
    expect(pages).not.toContain("img.shields.io");
    expect(readme).not.toMatch(/cocoa|coffee|hot chocolate|hot-chocolate/i);
    expect(pages).not.toMatch(/cocoa|coffee|hot chocolate|hot-chocolate/i);
  });
});
