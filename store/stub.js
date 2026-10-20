// A stand-in for chrome.* for the Chrome Web Store screenshots (scripts/store-screenshots.mjs). The page's ?scene=
// picks a scripted conversation; ChatGPT and the Gmail API never run. Every email here is made up.
(function () {
  'use strict';
  const scene = new URLSearchParams(location.search).get('scene') || 'ask';
  const day = 86400000;
  const now = Date.now();

  const email = (threadId, subject, from, ago, snippet) => ({ threadId, messageId: threadId, subject, from, date: now - ago * day, snippet });

  const SCENES = {
    ask: [
      { type: 'step', kind: 'search', label: 'from:westjet.com newer_than:60d' },
      { type: 'email', email: email('18f2a1b2c3d4e5f6', 'Your itinerary: Vancouver to Calgary', 'WestJet <itinerary@westjet.example>', 0.1, 'Confirmation KX7Q2M') },
      { type: 'email', email: email('18f2a9e8d7c6b5a4', 'Check-in is now open', 'WestJet <checkin@westjet.example>', 0.05, 'Check in for WS 2412') },
      { type: 'step', kind: 'read', label: 'Your itinerary: Vancouver to Calgary' },
      {
        text: "Your flight to Calgary is **WestJet WS 2412**, leaving Vancouver (YVR) **Fri, Oct 24 at 6:40 PM** and landing at 9:05 PM [itinerary](thread:18f2a1b2c3d4e5f6).\n\n- Confirmation: `KX7Q2M`\n- Seat 14C, one checked bag included [itinerary](thread:18f2a1b2c3d4e5f6)\n- Check-in is open now [check-in](thread:18f2a9e8d7c6b5a4)",
      },
    ],
    attachment: [
      { type: 'step', kind: 'search', label: 'from:northsideplumbing has:attachment newer_than:30d' },
      { type: 'email', email: email('18f1c0ffee112233', 'Invoice 2231 for October service', 'Northside Plumbing <billing@northside.example>', 1, 'Please find attached your invoice') },
      { type: 'step', kind: 'read', label: 'Invoice 2231 for October service' },
      { type: 'step', kind: 'attachment', label: 'invoice-2231.pdf' },
      {
        text: "The plumber's invoice is **$486.15**, due **Mon, Nov 17** (net 30) [invoice](thread:18f1c0ffee112233).\n\n- Water heater repair: $395.00 labour and parts\n- Service call: $68.00, plus GST $23.15\n- Pay by e-transfer to billing@northside.example, or card by phone",
      },
    ],
    organize: [
      { type: 'step', kind: 'search', label: 'category:promotions in:inbox older_than:14d' },
      {
        proposal: {
          action: 'archive',
          summary: 'Promotions in your inbox older than two weeks',
          items: [
            ['Trailhead Outfitters', '48-hour flash sale: 30% off all jackets', 16],
            ['Fresh Basket', 'Weekly deals inside', 19],
            ['Trailhead Outfitters', 'New arrivals for fall', 23],
            ['Fresh Basket', 'Your points balance', 26],
            ['Cedar Books', 'Members save 20% this weekend', 27],
            ['StreamBox', 'New this month: 40 titles added', 29],
            ['Cedar Books', 'Staff picks for October', 31],
          ].map(([from, subject, ago], i) => ({ threadId: `18e0aa00bb00cc0${i}`, subject, from: `${from} <news@${String(from).toLowerCase().replace(/\s+/g, '')}.example>`, date: now - ago * day })),
        },
      },
      { text: 'I found **7 promotional emails** in your inbox older than two weeks. Review the list below and press **Archive 7** to clear them out. Nothing changes until you confirm, and you can undo it afterwards.' },
    ],
    draft: [
      { type: 'step', kind: 'read', label: 'Lunch & learn: pick a time' },
      { type: 'step', kind: 'draft', label: 'Re: Lunch & learn: pick a time' },
      {
        text: 'I saved a reply to Priya as a draft and opened it in Gmail for you to review and send:\n\n> Hi Priya,\n>\n> Thursday afternoon works well for me. 2 PM would be ideal if that suits the team. Happy to present the reporting dashboard; I\'ll keep it to 45 minutes with time for questions.\n>\n> Thanks,\n> Alex\n\nNothing has been sent.',
      },
    ],
  };

  const QUESTIONS = {
    ask: 'When does my flight to Calgary leave?',
    attachment: "How much is the plumber's invoice and when is it due?",
    organize: 'Archive the promotions older than two weeks',
    draft: 'Draft a reply saying Thursday at 2 works',
  };
  window.__storeQuestion = QUESTIONS[scene];

  function port() {
    const listeners = [];
    const send = (message, at) => setTimeout(() => listeners.forEach((fn) => fn(message)), at);
    return {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener() {} },
      postMessage(message) {
        if (message.type !== 'ask') return;
        let t = 50;
        let text = '';
        for (const event of SCENES[scene] || []) {
          t += 40;
          if (event.text) {
            text = event.text.replace(/^> ?/gm, '');
            send({ type: 'delta', text }, t);
          } else if (event.proposal) {
            send({ type: 'proposal', proposal: { id: 'store-proposal', ...event.proposal } }, t);
          } else {
            send(event, t);
          }
        }
        send({ type: 'done', items: [], text }, t + 80);
      },
    };
  }

  const models = [
    { slug: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', description: 'The most capable model for complex questions.', efforts: ['low', 'medium', 'high'] },
    { slug: 'gpt-6-astra', name: 'GPT-6 Astra', description: 'Fast and capable for everyday questions.', efforts: ['low', 'medium', 'high'] },
  ];
  const diagnostics = {
    version: '1.0.0',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
    googleClientId: '',
    chatgpt: { kind: 'signed-in', email: 'alex.rivera@example.com', plan: 'plus' },
    gmail: { kind: 'no-client' },
    prefs: { model: '', effort: 'low', maxResults: 15, smartEnter: true },
    models,
    modelsError: null,
  };

  try {
    localStorage.setItem('gmc.options.wizard', JSON.stringify({ done: { project: true, api: true }, dismissed: false }));
    localStorage.removeItem('gmc.options.tab');
  } catch {
    // Storage blocked: the guide starts at its first part.
  }

  window.chrome = {
    storage: { sync: { get: async () => ({}), set: async () => undefined } },
    runtime: {
      id: 'store',
      getURL: (path) => `${location.origin}/${path}`,
      onMessage: { addListener() {} },
      connect: port,
      sendMessage: async (request) => {
        if (request.type === 'status/get') return { ok: true, data: { chatgpt: 'signed-in', gmail: 'signed-in', gmailEmail: 'alex.rivera@example.com', smartEnter: true, modelName: 'GPT-6.1 Sol' } };
        if (request.type === 'diagnostics/get') return { ok: true, data: diagnostics };
        return { ok: true, data: null };
      },
    },
  };
})();
