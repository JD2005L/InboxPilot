# Inbox Pilot privacy policy

*Last updated: 2026-10-19*

Inbox Pilot is a Chrome extension that lets you ask ChatGPT about your Gmail from Gmail's search bar, and have it
find, read, draft and organize your mail when you ask. It runs on your own ChatGPT account and reads Gmail through a
Google app that you create and own.

**In short:** Inbox Pilot has no server. The developer never receives, stores or sees your email, your questions, the
answers, or any sign-in token. The extension talks only to Google (your Gmail) and OpenAI (your ChatGPT account).

## What it accesses

| Data | Where it comes from | Why |
|---|---|---|
| Email messages, threads and attachments | The Gmail API, through your own Google app, only when you ask a question | To find and read what answers your question |
| Your Gmail address | The Gmail API, after you connect | To show which account is connected, to address drafts, and to open emails in the right account |
| Your ChatGPT account email and plan | OpenAI's sign-in, after you connect | To show which ChatGPT account is connected |
| Google and ChatGPT sign-in tokens | The sign-ins you start in the settings page | To use Gmail and ChatGPT on your behalf |
| The question you type in Gmail's search bar or the chat panel | You | To answer it |
| The open email's ID and subject, and the Gmail page title | The Gmail page | So "this email" means the one you have open, and to tell which account a tab is showing |

## What it can change in your Gmail

Only when you ask, and only with the "manage your email" access you can grant (or leave unticked) when you connect:

- **Drafts:** it saves draft emails and opens them for you to review. It has no way to send email.
- **Organizing:** archive, mark read or unread, star, add or remove labels, move to the inbox, or move to Trash
  (recoverable for 30 days). It always shows you the list of conversations first and changes nothing until you press
  Confirm; Undo reverses it. It cannot delete anything permanently.
- **Unsubscribe:** it only shows each sender's own unsubscribe link for you to open.

## Where data goes

| Data | Sent to | Why |
|---|---|---|
| Gmail searches, and the messages and attachments needed to answer | Google (Gmail API), then OpenAI | To find what answers your question, and for ChatGPT to write the answer |
| Your question and the conversation so far | OpenAI (your ChatGPT account) | To answer it. Requests are sent with storage off (`store: false`); OpenAI's handling is governed by your ChatGPT account's terms and data controls |
| Drafts and confirmed organizing changes | Google (Gmail API) | To save the draft or apply the change you confirmed |
| Sign-in requests | Google (accounts.google.com), OpenAI (auth.openai.com) | To connect and keep your accounts connected |

Nothing is sent anywhere else. There is no analytics, tracking or advertising. Attachments are downloaded and turned
into text inside your browser; only that text goes to your ChatGPT account, and only when an answer needs it.

## What is stored, and where

- **In this browser only** (extension storage closed to web pages and to the script that runs in Gmail): your ChatGPT
  and Google sign-in tokens, the connected Gmail address, and the list of models your ChatGPT plan offers.
- **In Chrome Sync** (if you use it): your Google OAuth client ID (a public identifier, not a secret) and your
  assistant preferences (model, answer effort, results per search, search-bar behaviour, panel size).
- **Conversations** exist only in the memory of the Gmail tab where you asked. Closing or reloading the tab erases them.
- No email content is stored by the extension.

## How email content is treated

Email text and attachments are written by other people, so Inbox Pilot treats them only as data: ChatGPT is
instructed never to follow instructions that appear inside an email, never to let them choose what it drafts or
organizes, and changes to your mailbox always wait for your confirmation.

## Your control

- Disconnect ChatGPT or Gmail any time in the extension's settings. Disconnecting Gmail also revokes the Google token.
- Remove the app's access at <https://myaccount.google.com/connections>, and review ChatGPT sessions in ChatGPT's
  security settings.
- Uninstalling the extension deletes everything it stored in this browser.

## Use of Google user data

Inbox Pilot's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including
the Limited Use requirements. Gmail data is used only to provide the features you use (answering your questions,
saving drafts you ask for, and organizing you confirm), is transferred only to OpenAI for the answers you request,
is not used for advertising, is not sold, and is not read by any person.

## Contact

Questions about this policy: [James@Levac.net](mailto:James@Levac.net). Product page: <https://levac.net/inbox-pilot/>.
