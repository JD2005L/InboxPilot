// The Chrome Web Store submission, field by field, in the Developer Dashboard's order. Single source of truth for
// release/chrome-web-store-<version>/SUBMIT.html (copy buttons) and SUBMIT.md, written by scripts/store-assets.mjs.
//
// Field kinds:
//   text    paste `value` into the field (limit = the dashboard's character limit)
//   choice  pick `value` in a dropdown or radio group
//   file    upload the file(s) at `files` (paths relative to the submission folder)
//   checks  tick exactly the options marked true
//   info    nothing to enter (shown for orientation)

// Public pages on levac.net: the product page and privacy policy the store listing links to.
export const SITE = 'https://levac.net/inbox-pilot/';

export const SCREENSHOTS = ['1-ask-from-search.png', '2-attachments.png', '3-organize.png', '4-draft-reply.png', '5-scheduled-rule.png'];

const DESCRIPTION = `Inbox Pilot puts ChatGPT at the controls of your Gmail. Type a question into Gmail's search bar and press Enter: ChatGPT searches your mailbox, reads what it needs (attachments included), answers with links to the exact emails, drafts replies, tidies your inbox, and puts what matters on your calendar when you ask. It runs on your own ChatGPT plan, not on an API key, and it is not Gmail's built-in "Ask Gmail".

WHAT YOU CAN ASK
• "When does my flight to Calgary leave, and what's the confirmation number?"
• "How much is the plumber's invoice and when is it due?" (reads the PDF)
• "Summarize this email and tell me what they need from me" (uses the email you have open)
• "Draft a reply saying Thursday works" (saves a draft and opens it; never sends)
• "Archive the promotions older than two weeks" (shows you the list first; you confirm, and can undo)
• "Show me everything from the school this month" (runs the search in Gmail for you)
• "Put my flights for the Toronto trip in my calendar" (shows each event first; nothing is added until you click Add)
• "Whenever the school emails, send a summary to my phone" (sets up a rule you review and confirm)

HOW IT FITS INTO GMAIL
• Gmail's search bar keeps working exactly as before. Ordinary searches like from:bob invoice still search; questions go to ChatGPT. A small chip in the bar always shows which it will be, and one click flips it.
• Answers drop down under the search bar like Gmail's own suggestions, in Gmail's light or dark theme, with numbered sources you can click. Expand for long conversations.
• Ask follow-ups; it remembers the conversation until you close the tab.

WHAT IT CAN DO
• Find: plain-English questions turned into precise Gmail searches, retried and broadened until it finds the answer.
• Read: whole conversations, and the documents attached to them, so answers can come from the invoice itself and not just the email around it.
• Draft: replies threaded into the conversation, or new emails. Drafts only: Inbox Pilot has no way to send.
• Organize: ask it to tidy up and it proposes the change, showing you exactly which conversations it would touch. Nothing happens until you confirm, and Undo puts everything back. Anything moved to Trash stays recoverable for 30 days.
• Calendar (optional): it turns bookings and appointments in your email into events, with the right times even when a flight crosses time zones, and checks your schedule for clashes. You approve each event before it is added; nobody is invited.
• Rules (optional): automations you approve once, such as starring anything you would regret missing and sending a note to your phone, or filing receipts under a label as they arrive. Each rule pairs a Gmail search with an optional yes or no question for ChatGPT, and does only what you chose. Mail that arrives while your computer is off is handled when it is back. Rules sync between your computers, and only one of them runs them at a time. Every action is logged, with Undo.

PRIVATE BY DESIGN
• No Inbox Pilot server. It talks only to Google (Gmail, and Calendar if you connect it) and OpenAI (your ChatGPT account). The developer never sees your mail, questions or tokens.
• Gmail access goes through a Google app you create and own (the guided setup walks you through it), not a shared app.
• Email content is treated as data: ChatGPT is instructed never to follow instructions written inside an email.
• Conversations exist only in the Gmail tab you asked in.
• Open source: the complete code is public on GitHub, so you can check all of this yourself.

REQUIREMENTS
• A paid ChatGPT plan that includes Codex. Usage counts toward that plan's Codex limits.
• About ten minutes of one-time setup: connect ChatGPT with a short code, and create your own free Google Cloud app for Gmail access. The settings page checks every step for you.

Inbox Pilot is an independent extension. It is not made or endorsed by Google or OpenAI. Gmail is a trademark of Google LLC; ChatGPT is a trademark of OpenAI.

More: ${SITE}`;

// The dashboard field takes 500 characters; the full walkthrough is TESTING.md in the repository.
const TEST_INSTRUCTIONS = `Uses the reviewer's own ChatGPT (Plus or higher) and Gmail accounts; no test account, no server.
1. Click the toolbar icon: settings walks through connecting ChatGPT (device code) and creating a free Google OAuth client, then Connect Gmail.
2. Open Gmail: the panel asks "What can you do?" for a tour.
3. Type a question in Gmail's search bar, press Enter. Changes always wait for Confirm.
Full steps (Calendar, Rules): https://github.com/JD2005L/InboxPilot/blob/main/TESTING.md`;

export function storeListing(version) {
  return [
    {
      tab: 'Package',
      intro: 'Items → New item (first time) or Package → Upload new package (updates).',
      fields: [{ label: 'Upload package', kind: 'file', files: ['1-upload-this.zip'], note: `Version ${version}. The production build without the manifest "key" field (which the store rejects) and without any built-in Google client ID. Every update needs a higher version.` }],
    },
    {
      tab: 'Store listing',
      fields: [
        { label: 'Title', kind: 'info', value: 'Inbox Pilot', note: 'Taken from the package (manifest name).' },
        { label: 'Summary', kind: 'info', value: 'Ask ChatGPT about your Gmail from the search bar: find anything, read attachments, draft replies and tidy your inbox.', note: 'Taken from the package (manifest description).' },
        { label: 'Description', required: true, kind: 'text', limit: 16000, value: DESCRIPTION },
        { label: 'Category', required: true, kind: 'choice', value: 'Productivity → Communication' },
        { label: 'Language', required: true, kind: 'choice', value: 'English' },
        { label: 'Store icon', required: true, kind: 'file', files: ['images/store-icon-128.png'], note: '128×128 PNG.' },
        { label: 'Global promo video', kind: 'info', value: '(leave empty)' },
        {
          label: 'Screenshots',
          required: true,
          kind: 'file',
          files: SCREENSHOTS.map((f) => `images/screenshots/${f}`),
          note: 'Upload all five, in this order. Each is 1280×800, 24-bit PNG, made with the real extension on a mock mailbox of made-up emails.',
        },
        { label: 'Small promo tile', kind: 'file', files: ['images/promo-tile-440x280.png'], note: '440×280.' },
        { label: 'Marquee promo tile', kind: 'file', files: ['images/marquee-1400x560.png'], note: '1400×560. Optional; used if the store features the extension.' },
        { label: 'Official URL', kind: 'info', value: '(leave as None)' },
        { label: 'Homepage URL', kind: 'text', value: SITE },
        { label: 'Support URL', kind: 'text', value: `${SITE}#support` },
        { label: 'Mature content', kind: 'choice', value: 'No (leave unticked)' },
      ],
    },
    {
      tab: 'Privacy',
      fields: [
        {
          label: 'Single purpose description',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            "Lets the user ask ChatGPT, through their own ChatGPT account, to find, read, draft and organize their Gmail, from Gmail's search bar: it answers questions about their mail with links to the emails, reads attachments, saves draft replies, organizes conversations and adds calendar events only after the user confirms, and runs mail rules the user set up in advance.",
        },
        {
          label: 'storage justification',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            "chrome.storage.local (restricted to the extension's own pages, closed to content scripts) keeps the user's ChatGPT and Google sign-in tokens, the connected Gmail address, and the list of ChatGPT models the user's plan offers. chrome.storage.sync keeps the user's own Google OAuth client ID (a public identifier) and their assistant preferences (model, answer effort, results per search, search-bar behaviour, panel size), so these follow them to their other Chrome browsers. chrome.storage.session holds an unfinished ChatGPT sign-in so it survives the service worker restarting. No email content is stored.",
        },
        {
          label: 'identity justification',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            "chrome.identity.launchWebAuthFlow signs the user in to Google with the OAuth client they created in their own Google Cloud project, to get a Gmail API access token (read, and modify for drafts and organizing; plus Google Calendar events if the user chooses to connect Calendar), and silently renews that token while they stay signed in. getRedirectURL provides the redirect URI the setup guide asks the user to register on that client. chrome.identity.getAuthToken is not used, because the client ID is the user's own and cannot be in the manifest.",
        },
        {
          label: 'offscreen justification',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            'Reads the text of PDF email attachments with pdf.js (bundled in the package) when an answer needs them, e.g. "how much is the invoice?". pdf.js needs a document context and is large, so it runs in an offscreen document that is created only when a PDF is actually read, instead of in the service worker. The PDF is downloaded from the Gmail API and never leaves the browser except as extracted text sent to the user\'s ChatGPT account for the answer.',
        },
        {
          label: 'alarms justification',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            'Runs the automation rules the user set up in the settings page (for example "star and notify me about important new mail" or "archive promotions older than two weeks") about once a minute while Chrome is open. Each run checks Gmail for new mail since the last run and applies only the actions the user configured for that rule. With no rules, a run only refreshes the browser\'s status.',
        },
        {
          label: 'notifications justification',
          kind: 'text',
          limit: 1000,
          value:
            'Optional permission, not granted at install. Asked for only when the user saves a rule with the "Desktop notification" action (for example "notify me about important new mail"), to show that notification. Clicking it opens the email in Gmail.',
        },
        {
          label: 'Host permission justification',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            "https://mail.google.com/*: the content script adds the Ask chip and answer panel to Gmail's search bar, decides whether Enter searches or asks, and reads which conversation is open (from the page) so \"this email\" works. https://gmail.googleapis.com/*: the Gmail API, to search and read mail and attachments, save drafts, and apply confirmed label changes. https://oauth2.googleapis.com/*: only to revoke the Google token when the user disconnects. https://auth.openai.com/*: ChatGPT device-code sign-in and token renewal. https://chatgpt.com/*: sends the question, conversation and the email content the answer needs to the user's own ChatGPT account and streams the answer back. Optional host permissions (https://*/*, http://*/*) are never granted at install: when the user adds a webhook destination for a rule (for example their own Home Assistant or a phone notification service), Chrome asks for that one site, and only rules the user set up post to it.",
        },
        { label: 'Are you using remote code?', required: true, kind: 'choice', value: 'No, I am not using Remote code', note: 'All code ships in the package (pdf.js included). No eval, remote scripts or WebAssembly.' },
        {
          label: 'What user data do you plan to collect from users now or in the future?',
          kind: 'checks',
          options: [
            ['Personally identifiable information', true, 'The connected Gmail address and ChatGPT account email, shown in settings and used to address drafts and the right account.'],
            ['Health information', false],
            ['Financial and payment information', false, 'Not collected. It may appear in emails the user asks about (an invoice), which falls under personal communications.'],
            ['Authentication information', true, 'Google and ChatGPT tokens, kept in the browser and sent only to Google and OpenAI respectively.'],
            ['Personal communications', true, 'Email content: read from Gmail only to answer the user or run the rules the user set up, and sent to the user\'s own ChatGPT account for that. A rule with a webhook sends the sender, subject, a link and a one-line summary to the address the user entered. Not stored or sent anywhere else.'],
            ['Location', false],
            ['Web history', false],
            ['User activity', false],
            ['Website content', true, 'On mail.google.com it reads the search box text the user submits as a question, the open conversation\'s ID and subject, and the page title (to tell which account the tab is).'],
          ],
        },
        {
          label: 'I certify that the following disclosures are true',
          kind: 'checks',
          options: [
            ['I do not sell or transfer user data to third parties, outside of the approved use cases', true],
            ['I do not use or transfer user data for purposes that are unrelated to my item’s single purpose', true],
            ['I do not use or transfer user data to determine creditworthiness or for lending purposes', true],
          ],
        },
        { label: 'Privacy policy URL', required: true, kind: 'text', value: `${SITE}privacy.html`, note: 'Published on levac.net; the same policy is in PRIVACY.md in this folder.' },
      ],
    },
    {
      tab: 'Distribution',
      fields: [
        { label: 'Payments', kind: 'choice', value: 'Free of charge' },
        { label: 'Visibility', kind: 'choice', value: 'Public', note: 'Listed in store search. Unlisted (link-only) is the alternative for a quieter launch.' },
        { label: 'Distribution', kind: 'choice', value: 'All regions' },
      ],
    },
    {
      tab: 'Test instructions',
      fields: [
        { label: 'Test instructions', kind: 'text', limit: 500, value: TEST_INSTRUCTIONS },
        { label: 'Username / Password', kind: 'info', value: '(leave empty: reviewers use their own ChatGPT and Gmail accounts)' },
      ],
    },
    {
      tab: 'Submit',
      fields: [{ label: 'Submit for review', kind: 'info', value: 'Status → Submit for review. Review usually takes a few days, longer for extensions that read email; choose whether to publish automatically after approval.' }],
    },
  ];
}
