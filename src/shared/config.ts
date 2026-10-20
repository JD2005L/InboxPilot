/** Build-time configuration injected by scripts/build.mjs (and vitest.config.ts for tests). Nothing secret. */
export interface RuntimeConfig {
  /** OpenAI's sign-in service (device pairing and token refresh). */
  authBase: string;
  /** ChatGPT's Codex backend, which bills requests against the signed-in ChatGPT plan. */
  chatgptBase: string;
  googleAuthBase: string;
  gmailBase: string;
  /**
   * Google Calendar API. Reached without a host permission: Google's APIs answer CORS for any origin, so adding
   * Calendar did not add a permission warning that would disable existing installs on update.
   */
  calendarBase: string;
  /** Google Drive API, app data folder only (rule sync). Also reached through CORS, without a host permission. */
  driveBase: string;
  driveUploadBase: string;
  /** Codex CLI version reported when asking for the model catalog. */
  clientVersion: string;
  /** package.json version. */
  version: string;
  /** A personal build's Google OAuth client ID, used until the user saves their own. Empty in store builds. */
  googleClientId: string;
}

declare const __GMC_CONFIG__: RuntimeConfig;

export const CONFIG: RuntimeConfig = __GMC_CONFIG__;
