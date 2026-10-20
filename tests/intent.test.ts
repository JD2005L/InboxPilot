import { describe, expect, it } from 'vitest';
import { looksLikeQuestion } from '../src/content/intent';

describe('looksLikeQuestion', () => {
  it('sends questions and requests to the assistant', () => {
    for (const text of [
      'when does my flight leave?',
      'did the contractor send a quote',
      'what is the wifi password at the cabin',
      'summarize unread emails from this week',
      'find the invoice from the plumber',
      "what's my Costco membership number",
      'the confirmation number for the hotel in Banff next month',
      'roofer quote?',
    ]) {
      expect(looksLikeQuestion(text), text).toBe(true);
    }
  });

  it('leaves Gmail searches to Gmail', () => {
    for (const text of ['', 'invoice', 'bob smith', 'amazon order', 'from:bob subject:lunch', 'is:unread has:attachment', 'what from:bob?', '"exact phrase match here please today"', 'label:receipts after:2026/01/01 tax', 'newer_than:7d -category:promotions']) {
      expect(looksLikeQuestion(text), text).toBe(false);
    }
  });
});
