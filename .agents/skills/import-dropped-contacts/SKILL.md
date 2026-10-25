---
name: import-dropped-contacts
description: What the bot does when the owner drops a contacts file (.vcf vCard or .csv from Google, Outlook or a plain name,phone list) into the chat, or asks to switch on one person so it can text them.
---

# A dropped contacts file, or a one-person add

The bot never switches anyone on. It files a proposal; the owner approves it with one tap on the private page.

## A file was dropped
1. Only `.vcf`, `.vcard` or `.csv`. Anything else: say it isn't a contacts file and stop.
2. `POST https://<API_HOST>/import-contacts` with the bot token and JSON
   `{"filename": "<as dropped>", "content": "<file text, unchanged>", "allowlist": "add"}`.
   - `"replace"` only when the owner said the file is the complete list (people on now but missing from it are proposed for OFF,
     except numbers in the `ALLOWLIST` secret: those stay on and the page lists them under "Stays on (secret ALLOWLIST)").
   - `"none"` when the owner only wants them in the address book.
3. Read back the counts from `imported` (`numbers`, `added`, `already_known`, `duplicates`, `unreadable`, `dropped_fax_pager`).
4. If `proposal` is not null: "N to switch on, M to switch off. Approve here: <approve_url>." Never paste numbers.
   If it is null: nobody's switch changes.
5. Numbers new to the address book land OFF, and so does a number coming back within 30 days of leaving it. Numbers
   already on stay on, and `ALLOWLIST` numbers are always on. Nobody new is switched on until the owner taps
   **Approve these N**. Don't text them before that.

## Switch on one person
1. `POST https://<API_HOST>/allowlist-request` `{"to_name": "<name as in contacts>"}`. A name only, never a number.
   - `404 contact_not_found`: no contact has that name; ask the owner for the name as saved.
   - `409 contact_ambiguous`: the name matches more than one number. That can be two people, or one person with two
     numbers (say mobile and work). A one-person add can't choose, so tell the owner to switch the right number on
     from the Contacts page. Don't retry with a number.
   - `200 already_on`: they're already sendable.
2. On `202`: send the owner the `approve_url` and wait.
3. Before texting, `GET /allowlist-request/<id>`: only `approved` lets you go on (resolve and send as usual). `pending`: still waiting. `denied` or `expired`: nothing changed; stop and say so.

## Errors
`import_format_unknown` (415): not a vCard/CSV. `import_too_large` / `import_too_many_numbers` (413): ask the owner to split the file. `import_no_numbers` (422): the file had no usable phone numbers.
