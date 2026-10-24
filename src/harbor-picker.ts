// Contacts-page picker behaviour. The page inlines these functions inside its nonce'd module.
// No on* attribute: /contacts CSP is script-src 'self' plus that nonce, and this must not ask for 'unsafe-inline'.
// Approve, Direct and Log inline this script under a nonce, same as /contacts. Their tiles are radios.

interface LeafNode {
  className: string;
  remove(): void;
  setAttribute(name: string, value: string): void;
}

interface PickerDoc {
  querySelector(selector: string): LeafNode | null;
  querySelectorAll(selector: string): Iterable<{ remove(): void }>;
  createElement(tag: string): LeafNode;
  body: { prepend(node: LeafNode): void };
}

interface PickerForm {
  tagName: string;
  action: string;
  addEventListener(type: string, listener: () => void): void;
}

interface PickerFields {
  get(name: string): string | null;
  forEach(fn: (value: string, key: string) => void): void;
}

type FetchInit = {
  method: "POST";
  body: URLSearchParams;
  headers: { "content-type": "application/x-www-form-urlencoded" };
  credentials: "same-origin";
};

type FetchLike = (url: string, init: FetchInit) => unknown;

/** Sets or clears the leaf layer for a picker value. Unknown values do nothing. */
export function applyPickerChoice(doc: PickerDoc, value: string): void {
  const name = value.startsWith("photo-") ? value.slice(6) : "";
  for (const n of doc.querySelectorAll("svg.hl-leaves")) n.remove();
  const el = doc.querySelector(".hl-photo");
  if (value === "none") {
    if (el) el.remove();
    return;
  }
  if(!/^(corners|vines|scatter|dock|willow|lantern)$/.test(name))return;
  if (!el) {
    const created = doc.createElement("div");
    created.className = "hl-photo hl-photo-" + name;
    created.setAttribute("aria-hidden", "true");
    doc.body.prepend(created);
    return;
  }
  el.className = "hl-photo hl-photo-" + name;
}

/** Paint the choice immediately, then POST the same form the Apply button used to submit. */
export function installPicker(doc: PickerDoc, form: PickerForm | null, fields: new (form: PickerForm) => PickerFields, fetchFn: FetchLike): void {
  if (!form || form.tagName !== "FORM") return;
  form.addEventListener("change", () => {
    const data = new fields(form);
    const v = data.get("leaves");
    if (typeof v !== "string") return;
    applyPickerChoice(doc, v);
    const body = new URLSearchParams();
    data.forEach((val, key) => { if (typeof val === "string") body.set(key, val); });
    void fetchFn(form.action, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, credentials: "same-origin" });
  });
}

export function pickerLiveScript(): string {
  // fetch throws Illegal invocation unless its receiver is the window.
  return `${applyPickerChoice.toString()}\n${installPicker.toString()}\ninstallPicker(document,document.querySelector("#hb-bg"),FormData,fetch.bind(globalThis));`;
}
