/**
 * Decides what Enter in Gmail's search bar should do with what was typed: run Gmail's own search, or ask the
 * assistant. Gmail queries (operators, a few keywords, a name) search; sentences and questions ask. The user can
 * always flip the decision with the chip in the search bar, so this only has to be right most of the time.
 */

/** Gmail's search box placeholder while the extension is active. */
export const PLACEHOLDER = 'Search mail or ask ChatGPT';

const OPERATOR_RE = /(^|\s|-)(from|to|cc|bcc|subject|label|in|is|has|after|before|older|newer|older_than|newer_than|filename|larger|smaller|size|category|list|deliveredto|rfc822msgid|around):\S/i;

const QUESTION_START_RE =
  /^(who|whom|whose|what|whats|what's|when|whens|when's|where|where's|why|how|how's|which|did|do|does|is|are|was|were|will|would|can|could|should|have|has|had|any|anything|find|show|list|summarize|summarise|tell|give|remind|explain|compare|check|look|search for|get me|i need|i want|was there|is there|are there)\b/i;

export function looksLikeQuestion(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (OPERATOR_RE.test(text)) return false;
  if (/^".*"$/.test(text)) return false;
  if (text.endsWith('?')) return true;
  const words = text.split(/\s+/).length;
  if (QUESTION_START_RE.test(text) && words >= 2) return true;
  // A long sentence is a request, not a keyword search.
  return words >= 6;
}
