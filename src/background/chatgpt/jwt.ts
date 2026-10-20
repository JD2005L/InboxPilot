/**
 * Reads the claims OpenAI puts in its tokens. Nothing is verified here: the tokens came straight from
 * auth.openai.com over TLS, and they are only read for display (email, plan) and routing (account ID, expiry).
 */

export function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface AccountInfo {
  email: string | null;
  /** "plus", "pro", "team", ... as ChatGPT names it. */
  plan: string | null;
  /** Sent as ChatGPT-Account-ID so requests bill to the right plan when the user has several. */
  accountId: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function accountInfo(idToken: string): AccountInfo {
  const claims = decodeJwt(idToken) ?? {};
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const profile = (claims['https://api.openai.com/profile'] ?? {}) as Record<string, unknown>;
  return {
    email: text(claims.email) ?? text(profile.email),
    plan: text(auth.chatgpt_plan_type),
    accountId: text(auth.chatgpt_account_id),
  };
}

/** When the token stops working (ms since epoch), or null when it does not say. */
export function expiresAt(token: string): number | null {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

export function planLabel(plan: string | null): string | null {
  if (!plan) return null;
  const known: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
  return known[plan.toLowerCase()] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}
