# Inbox Pilot

A Chrome (Manifest V3) extension that puts **ChatGPT at the controls of your Gmail**. Type a question into Gmail's
search bar and press Enter: ChatGPT searches your mailbox, reads what it needs (attachments included), answers with
numbered links to the exact emails, drafts replies, and organizes mail when you ask. It runs on **your own ChatGPT
plan** (no API key) and reads Gmail through a **Google app you own** (no server; nobody else gets access). It is not
Gmail's built-in "Ask Gmail".

Product page, support and privacy policy: <https://levac.net/inbox-pilot/>.

## What it changes in Gmail

| Where | What |
|---|---|
| **The search bar** | Same bar, same suggestions, chips and search options. Placeholder reads "Search mail or ask ChatGPT". **Enter decides**: Gmail queries (`from:bob invoice`) search as always; questions and sentences go to ChatGPT. A chip at the right end shows **Search ↵** or **Ask ChatGPT ↵**; click it to flip. **Shift+Enter** always asks. |
| **Under the search bar** | The answer panel drops down like Gmail's own suggestion list, in Gmail's light or dark theme: a one-line trail of what it did, the answer with numbered citations, the cited emails as rows, proposals to confirm, and a follow-up box. Expand for long conversations; **Esc** closes. |

If Gmail's layout changes so the search bar cannot be found, a floating **Ask your inbox** button appears instead.

## What it can do

| | |
|---|---|
| **Find** | Questions become Gmail searches, retried and broadened until something answers them. |
| **Read** | Whole threads, and attachments: PDF (pdf.js, in an offscreen document), Word, Excel, PowerPoint, text, CSV, HTML. |
| **This email** | With an email open, "summarize this" or "what do they want?" uses it (a chip above the question box shows it; × to ignore). |
| **Show** | "Pull it up" opens the email in Gmail; "show me everything from…" runs the search in Gmail's list. |
| **Draft** | Replies threaded into the conversation (In-Reply-To/References, Re: subject, right recipient) or new emails, saved as drafts and opened. **No send capability exists.** |
| **Organize** | Archive, mark read/unread, star/unstar, add/remove label (created if missing), move to inbox, Trash (30-day recoverable). Always a **proposal**: the panel lists the conversations (untick any), Confirm applies, **Undo** reverses. Unsubscribe lists each sender's own unsubscribe link instead. |

Organizing is fenced in the background: a Confirm can only touch conversations that proposal showed (`ProposalBook`),
each proposal applies once, and every target is looked up first so the model cannot invent one. Email content is
treated as untrusted data in the prompt and is never rendered as HTML (lint forbids `innerHTML`).

## How it works

```
Gmail tab (content script: search-bar chip + answer panel, shadow DOM)
   │  long-lived port (ask, stop, apply, undo)
   ▼
Service worker
   ├─ ChatGPT: device-pairing sign-in → chatgpt.com/backend-api/codex/responses (streamed, store: false)
   │     tools: search_emails, read_thread, read_attachment, open_email, show_in_gmail, create_draft, propose_actions
   ├─ Gmail API with a token from the user's own Google OAuth client (gmail.readonly, plus gmail.modify if granted)
   └─ Offscreen document (only while reading a PDF): pdf.js text extraction
```

- **ChatGPT sign-in** is the device-code flow the Codex CLI uses (`codex login --device-auth`), with request shapes
  from [openai/codex](https://github.com/openai/codex). The model list comes from the plan's catalog.
- **Gmail access** uses `chrome.identity.launchWebAuthFlow` with the user's own OAuth client (type *Web
  application*, redirect URI `https://<extension-id>.chromiumapp.org/`). Interactive sign-in asks for read and modify;
  the user can untick modify and keep answers only. Silent hourly renewal asks for exactly what was granted.
- Tokens live in `chrome.storage.local`/`session` locked to trusted contexts, so the Gmail content script never sees them.

> **Caveat:** ChatGPT-plan access for third-party apps uses OpenAI's Codex sign-in, built for OpenAI's own Codex
> clients. It works the way the open-source Codex CLI does, but OpenAI could change or restrict it. The ChatGPT side is
> isolated in `src/background/chatgpt/`.

## Install

**Chrome Web Store:** coming soon.

**From source (unpacked):** Chrome 140+, Node.js 22.12+, npm.

```bash
npm ci
npm run build          # writes the unpacked extension to dist/
```

1. `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, choose `dist/`.
2. The settings page opens and starts the guided setup.

The unpacked build's extension ID is pinned by `config/extension-public-key.txt`: **`lkkohbhfochcaebnjenjjofieghkkkil`**.
That matters because the Google redirect URI contains it. A store install gets its own ID; the settings page always
shows the right redirect URI.

For a personal build, put your Google client ID in `config/extension.config.json` (git-ignored; see the `.example`)
or `GMC_GOOGLE_CLIENT_ID`, and setup skips the paste step. Store builds always leave it out.

## Setup (about ten minutes, once)

The **Setup** tab walks through every click, checks each step against real state, and shows the exact fix for every
error Google or OpenAI can show:

1. **Connect ChatGPT.** Click *Connect ChatGPT*, enter the code on OpenAI's page, approve *Codex*. If device code
   sign-in is off: ChatGPT → Settings → Security → *Enable device code sign-in for Codex*.
2. **Create your Google app** (free, no card): project → Gmail API → Google Auth Platform *Get started* (External) →
   add your Gmail address as a **test user** (the app stays in Testing; *Publish app* would need a public site and
   privacy policy) → OAuth client of type **Web application** with the redirect URI shown → paste the Client ID.
3. **Connect Gmail.** Pick the account, *Continue* on "Google hasn't verified this app" (it is your own app), tick
   both Gmail boxes (the second enables drafts and organizing).
4. **Ask.** Type a question in Gmail's search bar and press Enter.

## Development

```bash
npm run check          # typecheck, lint, unit tests, build
npm run test:watch
npm run package        # store build + release/chrome-web-store-<version>/ (zip, SUBMIT.html/.md, icon, tiles, screenshots)
```

`npm run package` takes the five store screenshots with the real built extension on a mock Gmail of made-up emails
(`store/mock-gmail.html`), with ChatGPT and the Gmail API replaced by scripted scenes (`store/stub.js`). It needs
Playwright's Chromium (`npx playwright install chromium`).

| Path | Role |
|---|---|
| `src/background/chatgpt/` | Device pairing, token refresh (single-flight; refresh tokens rotate), Responses API streaming client |
| `src/background/gmail/` | Google sign-in, Gmail API, message/MIME parsing, attachment text (ZIP reader for Office files), draft MIME builder |
| `src/background/chat/` | System prompt, tool definitions, the tool loop, organize/undo and the proposal fence |
| `src/offscreen/` | pdf.js PDF text extraction, loaded only on demand |
| `src/content/` | Search-bar integration (Enter routing, chip), the answer panel, theme detection |
| `src/options/` | Settings page and setup guide |
| `src/shared/` | Messages, types, the `h()` DOM builder, the safe Markdown renderer |
| `scripts/` | Build, icon renderer, store packaging (listing fields, screenshots, tiles) |

`CODEX_CLIENT_VERSION` in `scripts/build.mjs` is the Codex release the model catalog is requested for; bump it when
OpenAI ships models that need a newer client.

## Privacy

See [PRIVACY.md](PRIVACY.md) (published at <https://levac.net/inbox-pilot/privacy.html>). Short version: no Inbox
Pilot server; mail goes from Google to your ChatGPT account only for the answer you asked for; changes to your mailbox
wait for your confirmation; conversations live only in the Gmail tab.
