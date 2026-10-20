import type { Diagnostics } from '../shared/messages';

/** Setup is three connections, checked against real state, then "try it". */
export type SetupStep = 'chatgpt' | 'google' | 'gmail' | 'done';

export function setupStep(d: Pick<Diagnostics, 'chatgpt' | 'googleClientId' | 'gmail'>): SetupStep {
  if (d.chatgpt.kind !== 'signed-in') return 'chatgpt';
  if (!d.googleClientId) return 'google';
  if (d.gmail.kind !== 'signed-in') return 'gmail';
  return 'done';
}

/** The Google Cloud walkthrough, one sub-step at a time. IDs are stored, so never rename one. */
export const GOOGLE_SUBSTEPS = ['project', 'api', 'branding', 'publish', 'client'] as const;
export type GoogleSubstep = (typeof GOOGLE_SUBSTEPS)[number];

export const WIZARD_KEY = 'gmc.options.wizard';

export interface Wizard {
  /** Google Cloud sub-steps the user ticked off. */
  done: Partial<Record<GoogleSubstep, boolean>>;
  /** The user hid the "you're all set" card. */
  dismissed: boolean;
}

export function defaultWizard(): Wizard {
  return { done: {}, dismissed: false };
}

export function parseWizard(raw: string | null): Wizard {
  const wizard = defaultWizard();
  if (!raw) return wizard;
  try {
    const parsed = JSON.parse(raw) as Partial<Wizard>;
    if (parsed.done && typeof parsed.done === 'object') {
      for (const id of GOOGLE_SUBSTEPS) if (parsed.done[id] === true) wizard.done[id] = true;
    }
    wizard.dismissed = parsed.dismissed === true;
  } catch {
    // A corrupt value starts the guide over; nothing depends on it.
  }
  return wizard;
}

/** The first sub-step not ticked off yet (the one shown open), or null when all are. */
export function currentSubstep(wizard: Wizard): GoogleSubstep | null {
  return GOOGLE_SUBSTEPS.find((id) => !wizard.done[id]) ?? null;
}

/** Google Cloud console pages, opened straight from the guide. */
export const GOOGLE_URLS = {
  createProject: 'https://console.cloud.google.com/projectcreate',
  gmailApi: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  calendarApi: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
  authOverview: 'https://console.cloud.google.com/auth/overview',
  audience: 'https://console.cloud.google.com/auth/audience',
  createClient: 'https://console.cloud.google.com/auth/clients/create',
  clients: 'https://console.cloud.google.com/auth/clients',
  permissions: 'https://myaccount.google.com/connections',
} as const;

export const CHATGPT_SECURITY_URL = 'https://chatgpt.com/#settings/Security';
export const GMAIL_URL = 'https://mail.google.com/mail/';

/** A name for the user's Google Cloud project, app and OAuth client. Any name works; one is suggested. */
export const APP_NAME = 'Inbox Pilot';
