// Approve, Direct and Log shells. No asset imports: the worker passes Harbor CSS and the leaf markup in.
import { pickerLiveScript } from "./harbor-picker";
import { approveLiveScript, logLiveScript } from "./pages-live";

export type NavKey = "contacts" | "approve" | "direct" | "log";

/** Placeholder. Swap either line: the address, or the visible text (emoji, then the words). */
export const SUPPORT_URL = "https://example.com/drink";
export const SUPPORT_LABEL = "☕ Buy me a drink";

const NAV: readonly { key: NavKey; href: string; label: string }[] = [
  { key: "contacts", href: "/contacts", label: "Contacts" },
  { key: "approve", href: "/approve", label: "Approve" },
  { key: "direct", href: "/direct", label: "Direct" },
  { key: "log", href: "/log", label: "Log" },
];

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function renderSupport(): string {
  const gap = SUPPORT_LABEL.indexOf(" ");
  const mark = gap > 0 ? esc(SUPPORT_LABEL.slice(0, gap)) : "";
  const name = esc(gap > 0 ? SUPPORT_LABEL.slice(gap + 1) : SUPPORT_LABEL);
  const text = mark === "" ? name : `<span aria-hidden=true>${mark}</span> ${name}`;
  return `<footer><a class=support href="${esc(SUPPORT_URL)}" rel="noopener noreferrer">${text}</a></footer>`;
}

export function renderNav(current: NavKey): string {
  const links = NAV.map((n) => `<a href="${n.href}"${n.key === current ? ' aria-current="page"' : ""}>${n.label}</a>`).join("");
  return `<nav class=sitenav aria-label="Pages">${links}</nav><nav class=tabrow aria-label="Pages">${links}</nav>`;
}

/** Stricter than the old approve/direct policy (nonce styles, no unsafe-inline) and adds the sources Copy, Undo and photos need. */
export function pageCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`;
}

export function pageHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "content-security-policy": pageCsp(nonce),
  };
}

/** Groups of at most 3 digits so the HTML source never contains a phone-number-like run. textContent still reads the full number. */
export function splitE164(e164: string): string {
  const parts: string[] = [];
  const digits = e164.startsWith("+") ? e164.slice(1) : e164;
  if (e164.startsWith("+")) parts.push("+");
  for (let i = 0; i < digits.length; i += 3) parts.push(digits.slice(i, i + 3));
  return `<span class=e164>${parts.map((p) => `<span>${esc(p)}</span>`).join("")}</span>`;
}

function dirLabel(d: "in" | "out"): string {
  switch (d) {
    case "in":
      return "In";
    case "out":
      return "Out";
    default: {
      const never: never = d;
      return never;
    }
  }
}

export interface ShellOpts {
  nonce: string;
  css: string;
  leaves: string;
  current: NavKey;
  body: string;
  script: string;
}

export function renderShell(o: ShellOpts): string {
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>GrokBot Texting</title>
<style nonce="${o.nonce}">
${o.css}
</style>
${o.leaves}<header class=brand><img class=brand-logo src="/harbor/grokbot-logo.svg" alt="" width=96 height=96><h1 class=product>GrokBot Texting</h1></header>
${renderNav(o.current)}
${o.body}
${renderSupport()}
<div id=toast role=status aria-live=polite></div>
<button type=button id=undo data-act=undo hidden>Undo</button>
<script type=module nonce="${o.nonce}">
${o.script}
${pickerLiveScript()}
</script></html>`;
}

export function errorBanner(on: boolean): string {
  return on ? `<p class=banner role=alert>Couldn't load this page. Reload to try again.</p>` : "";
}

export function countsLine(owner: number, phone: number): string {
  return `<p class=ro>Waiting on you: ${owner} · Waiting on the phone: ${phone}</p>`;
}

export interface ApproveItem {
  id: string;
  label: string;
  e164: string;
  text: string;
  csrf: string;
  open: boolean;
  status: string;
  sha: string;
}

export function renderApproveList(items: readonly ApproveItem[], error: boolean): string {
  const rows = items.length
    ? `<ul id=list>${items.map((r) => `<li data-card><p><b>To:</b> ${esc(r.label)} (${splitE164(r.e164)}) <button type=button class=copy data-act=copy>Copy</button></p><pre>${esc(r.text)}</pre><p class=ro><a href="/approve/${r.id}">Review</a> · ${esc(r.status)}</p></li>`).join("")}</ul>`
    : `<p id=empty>No texts waiting.</p>`;
  return `${errorBanner(error)}<h2>Approve</h2>${rows}`;
}

export function renderApproveOne(r: ApproveItem, error: boolean): string {
  const form = r.open
    ? `<form method=post><input type=hidden name=csrf value="${r.csrf}"><button name=action value=approve data-act=approve>Approve and send</button> <button name=action value=deny>Deny</button></form>`
    : "";
  return `${errorBanner(error)}<h2>Send this text?</h2><article data-card><p><b>To:</b> ${esc(r.label)} (${splitE164(r.e164)}) <button type=button class=copy data-act=copy>Copy</button></p><pre>${esc(r.text)}</pre><p><small>ref ${r.id.slice(0, 8)} · sha256 ${esc(r.sha)} · ${esc(r.status)}</small></p>${form}</article>`;
}

export function approveScript(): string {
  return approveLiveScript();
}

export interface LogItem {
  id: string;
  direction: "in" | "out";
  mask: string;
  body: string | null;
  when: string;
}

export function renderLog(items: readonly LogItem[], error: boolean): string {
  const filters = ([["all", "All"], ["in", "In"], ["out", "Out"]] as const)
    .map(([k, t], i) => `<button type=button data-act=filter data-dir="${k}" aria-pressed="${i === 0}">${t}</button>`)
    .join("");
  const rows = items
    .map((r) => {
      const body = r.body === null ? `<span class=body data-stored=0>(not stored)</span>` : `<span class=body data-stored=1>${esc(r.body)}</span> <button type=button data-act=copy-body data-id="${r.id}">Copy</button>`;
      return `<li data-dir="${r.direction}"><b class=dir>${dirLabel(r.direction)}</b> <span class=mask>${esc(r.mask)}</span> <button type=button data-act=copy-num data-id="${r.id}">Copy number</button> ${body} <span class=ro>${esc(r.when)}</span></li>`;
    })
    .join("");
  const emptyHidden = items.length ? " hidden" : "";
  return `${errorBanner(error)}<h2>Log</h2><label for=q class=ro>Search</label><input type=search id=q autocomplete=off>
<div class=tools><div class=seg role=group aria-label="Direction">${filters}</div></div>
<ul id=list>${rows}</ul><p id=empty${emptyHidden}>No texts yet.</p>`;
}

export function logScript(): string {
  return logLiveScript();
}
