# Inbox Pilot privacy policy

*Last updated: 2026-10-24*

Inbox Pilot is a Chrome extension that lets you ask ChatGPT about your Gmail from Gmail's search bar, and have it
find, read, draft and organize your mail, manage your Gmail filters, and add events to your Google Calendar, when you
ask. It runs on your own
ChatGPT account and reads Gmail (and, if you connect it, Google Calendar) through a Google app that you create and own.

**In short:** Inbox Pilot has no server. The developer never receives, stores or sees your email, your questions, the
answers, or any sign-in token. The extension talks only to Google (your Gmail and Calendar) and OpenAI (your ChatGPT
account).

## What it accesses

| Data | Where it comes from | Why |
|---|---|---|
| Email messages, threads and attachments | The Gmail API, through your own Google app, only when you ask a question | To find and read what answers your question |
| Calendar events on your primary calendar, for the days asked about (title, time, location) | The Google Calendar API, only if you connect Calendar, and only when a question needs your schedule | To answer what is on your calendar, whether you are free, or whether something clashes |
| Your Gmail filters and label names | The Gmail API, only if you allow Gmail filters, and only when a question is about filters or proposes one | To show, review and change your filters when you ask |
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
- **Filters** (only if you allow Gmail filters, a separate permission): it creates, replaces or deletes Gmail filters
  only after you tick and confirm each change, and Undo puts them back. A change can also apply a new filter to mail
  you already have; the card shows how many emails first. It never sets up forwarding. Google's permission for
  filters also covers basic settings such as your vacation reply; Inbox Pilot never reads or changes those.

## What it can change in your Google Calendar

Only if you connect Calendar (optional, a separate permission), and only events you approve: when you ask, it shows a
proposed event (title, time, place, and the email it came from) and adds it to your primary calendar only when you
click Add. Undo removes it again. It never invites anyone, and it does not change or delete events already on your
calendar.

## Rules you set up (automation)

Rules are optional. Each one is something you approved ahead of time: a Gmail search, an optional yes/no question,
and fixed actions. While Chrome is open, Inbox Pilot checks new mail (and runs scheduled rules) about once a minute:

- Emails a rule's filter finds are sent to your ChatGPT account only if the rule has a question, for ChatGPT to
  answer yes or no with a one-line summary. ChatGPT never chooses the actions, and email text cannot change a rule.
- Actions you chose run on matching emails: label, archive, star, mark read or important, move to Trash (recoverable
  for 30 days), a desktop notification, or a webhook. Every action is listed in the activity log, with Undo for the
  Gmail changes.
- **Webhooks** send the sender, subject, date, a Gmail link and ChatGPT's one-line summary (plus the email's text,
  only if you ticked that for the destination) to the webhook URL **you** entered, such as your own Home Assistant,
  n8n, ntfy topic, Discord or Slack. Chrome asks your permission for each destination's site in each browser.
  What that service does with it is governed by that service.
- **Sync** (optional): rules, destinations, the activity log and a heartbeat for each of your browsers are kept in a
  hidden app-data folder in your own Google Drive, which only your Inbox Pilot Google app can see. It cannot see your
  other Drive files. Without sync, the same data stays in this browser.

## Where data goes

| Data | Sent to | Why |
|---|---|---|
| Gmail searches, and the messages and attachments needed to answer | Google (Gmail API), then OpenAI | To find what answers your question, and for ChatGPT to write the answer |
| Your question and the conversation so far | OpenAI (your ChatGPT account) | To answer it. Requests are sent with storage off (`store: false`); OpenAI's handling is governed by your ChatGPT account's terms and data controls |
| Drafts and confirmed organizing changes | Google (Gmail API) | To save the draft or apply the change you confirmed |
| Your filters (conditions and actions) and label names, if you allow Gmail filters | Google (Gmail API), then OpenAI | For ChatGPT to review them or propose changes when you ask |
| Filter changes you confirmed | Google (Gmail API) | To create or delete exactly those filters |
| Calendar events you asked about | Google (Calendar API), then OpenAI | For ChatGPT to answer questions about your schedule |
| Events you clicked Add on | Google (Calendar API) | To add them to your calendar |
| Emails a rule with a question looks at | Google (Gmail API), then OpenAI | For ChatGPT to answer the rule's question |
| What a rule with a webhook sends (see above) | The webhook URL you entered | Because your rule says so |
| Rules, the activity log and browser heartbeats, if you turn on sync | Google (Drive API, app-data folder) | To share rules between your browsers and agree which one runs them |
| Sign-in requests | Google (accounts.google.com), OpenAI (auth.openai.com) | To connect and keep your accounts connected |

Nothing is sent anywhere else. There is no analytics, tracking or advertising. Attachments are downloaded and turned
into text inside your browser; only that text goes to your ChatGPT account, and only when an answer needs it.

## What is stored, and where

- **In this browser only** (extension storage closed to web pages and to the script that runs in Gmail): your ChatGPT
  and Google sign-in tokens, the connected Gmail address, and the list of models your ChatGPT plan offers.
- **In Chrome Sync** (if you use it): your Google OAuth client ID (a public identifier, not a secret) and your
  assistant preferences (model, answer effort, results per search, search-bar behaviour, panel size).
- **Conversations** exist only in the memory of the Gmail tab where you asked. Closing or reloading the tab erases them.
- **Rules and the activity log** (each entry: time, rule, subject, sender, ChatGPT's one-line summary, what was done)
  are kept in this browser, or in your Drive's hidden app-data folder if you turned on sync. The log keeps the most
  recent 300 entries per browser.
- No email bodies are stored by the extension.

## How email content is treated

Email text and attachments are written by other people, so Inbox Pilot treats them only as data: ChatGPT is
instructed never to follow instructions that appear inside an email, never to let them choose what it drafts or
organizes, and changes to your mailbox always wait for your confirmation.

## Your control

- Disconnect ChatGPT or Gmail any time in the extension's settings. Disconnecting Gmail also revokes the Google token,
  including Calendar access.
- Remove the app's access at <https://myaccount.google.com/connections>, and review ChatGPT sessions in ChatGPT's
  security settings.
- Uninstalling the extension deletes everything it stored in this browser.

## Use of Google user data

Inbox Pilot's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including
the Limited Use requirements. Gmail and Calendar data is used only to provide the features you use (answering your
questions, saving drafts you ask for, organizing and filter changes you confirm, and adding events you approve), is transferred only to
OpenAI for the answers you request,
is not used for advertising, is not sold, and is not read by any person.

## Contact

Questions about this policy: [James@Levac.net](mailto:James@Levac.net). Product page: <https://levac.net/inbox-pilot/>.
