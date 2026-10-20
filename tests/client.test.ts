import { describe, expect, it } from 'vitest';
import { describeHttpError, readEvents } from '../src/background/chatgpt/client';

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of readEvents(body)) events.push(event);
  return events;
}

describe('readEvents', () => {
  it('parses events split across chunks and CRLF boundaries', async () => {
    const events = await collect(
      stream(['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","del', 'ta":"Hel"}\n\nevent: x\r\ndata: {"type":"response.output_text.delta","delta":"lo"}\r\n\r\n', 'data: {"type":"response.completed"}']),
    );
    expect(events.map((e) => e.type)).toEqual(['response.output_text.delta', 'response.output_text.delta', 'response.completed']);
    expect(events[0]!.delta).toBe('Hel');
  });

  it('skips comments, [DONE] and malformed data', async () => {
    expect(await collect(stream([': keep-alive\n\ndata: [DONE]\n\ndata: {nope\n\n']))).toEqual([]);
  });
});

describe('describeHttpError', () => {
  it('explains usage limits with the reset time', () => {
    const text = describeHttpError(429, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1_800_000_000 } }));
    expect(text).toMatch(/usage limit/);
    expect(text).toMatch(/resets/);
  });

  it('passes on a bad-request message', () => {
    expect(describeHttpError(400, JSON.stringify({ detail: 'Unsupported model' }))).toBe('ChatGPT rejected the request: Unsupported model');
  });
});
