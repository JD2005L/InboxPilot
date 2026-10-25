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
    rule: [
      { type: 'step', kind: 'search', label: 'from:maplecreek.example newer_than:14d' },
      {
        type: 'rule-proposal',
        id: 'store-rule',
        mode: 'create',
        rule: {
          id: 'store-rule',
          name: 'School needs something from me',
          enabled: true,
          trigger: { kind: 'schedule', everyMinutes: 60 },
          query: 'from:maplecreek.example',
          test: 'Does this email ask a parent to do, sign, pay or reply to something?',
          actions: [{ kind: 'label', label: 'School' }, { kind: 'star' }, { kind: 'webhook', destination: 'phone' }],
          dailyLimit: 100,
        },
        summary: 'Every hour, checks new school emails and pings your phone when one needs you.',
        destinations: [{ id: 'phone', name: 'My phone (ntfy)', url: 'https://ntfy.sh/alex-alerts', format: 'ntfy', includeBody: false }],
      },
      { text: "Here's the rule. Every hour it looks at new emails from **Maple Creek School**, and ChatGPT checks whether each one asks you to do something. Those get the **School** label, a star, and a ping on **My phone**. Press **Create rule** to turn it on; you can pause, change or delete it any time in settings." },
    ],
    filters: [
      { type: 'step', kind: 'filters', label: 'Reading your Gmail filters' },
      { type: 'step', kind: 'filters', label: 'Checked what 14 filters matched this year' },
      {
        type: 'filter-proposal',
        proposal: {
          id: 'store-filters',
          summary: '4 changes; the other 9 filters are fine as they are.',
          changes: [
            {
              id: 'c1',
              filter: filter({ from: 'trailhead.example OR freshbasket.example OR cedarbooks.example' }, { labels: ['Shopping'], skipInbox: true }),
              removes: [old({ from: 'trailhead.example' }, { labels: ['Shopping'], skipInbox: true }), old({ from: 'freshbasket.example' }, { labels: ['Shopping'], skipInbox: true }), old({ from: 'cedarbooks.example' }, { labels: ['Shopping'], skipInbox: true })],
              reason: 'Same label and actions; one filter is easier to keep up to date.',
              matches: { count: 100, more: true },
            },
            {
              id: 'c2',
              filter: filter({ from: 'maplecreek.example' }, { labels: ['School'], star: true }),
              removes: [old({ from: 'maplecreek.example' }, { labels: [], star: true })],
              newLabels: [],
              reason: 'It labelled “Kids-School”, a label that was deleted; now it files under School again.',
              matches: { count: 41, more: false },
              existing: { count: 41, more: false },
            },
            { id: 'c3', removes: [old({ from: 'oldjob.example' }, { labels: ['Work'] })], reason: 'Matched nothing in the last year.' },
            { id: 'c4', removes: [old({ from: 'amazon.example' }, { labels: ['Orders'] })], reason: 'Exact duplicate of another filter.' },
          ],
        },
      },
      {
        text: 'I went through your **14 filters**. Most are fine; four changes would tidy things up:\n\n- **Merged:** the three store filters do the same thing, so one filter now covers all three senders.\n- **Fixed:** the school filter pointed at a label you deleted; it files under **School** again, including the 41 emails already received.\n- **Deleted:** one filter for an old job that has not matched anything in a year, and one exact duplicate.\n\nUntick anything you want to keep as it is, then press **Apply**. Undo puts everything back.',
      },
    ],
  };

  function filter(c, a) {
    return {
      criteria: { from: '', to: '', subject: '', hasWords: '', doesntHave: '', hasAttachment: false, excludeChats: false, size: null, ...c },
      actions: { labels: [], skipInbox: false, markRead: false, star: false, important: null, neverSpam: false, trash: false, category: null, forward: '', ...a },
    };
  }
  function old(c, a) {
    return { id: `f-${c.from}`, spec: filter(c, a), missingLabels: [] };
  }

  const QUESTIONS = {
    ask: 'When does my flight to Calgary leave?',
    attachment: "How much is the plumber's invoice and when is it due?",
    organize: 'Archive the promotions older than two weeks',
    draft: 'Draft a reply saying Thursday at 2 works',
    rule: 'Every hour, check the school emails and ping my phone if they need something from me',
    filters: 'Review my Gmail filters and clean them up',
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
          } else if (event.proposal && !event.type) {
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
    welcomePending: false,
  };

  try {
    localStorage.setItem('gmc.options.wizard', JSON.stringify({ done: { project: true, api: true }, dismissed: false }));
    localStorage.removeItem('gmc.options.tab');
  } catch {
    // Storage blocked: the guide starts at its first part.
  }

  window.chrome = {
    storage: { sync: { get: async () => ({}), set: async () => undefined } },
    // Nothing optional granted: the settings page lists only what the extension always has.
    permissions: {
      getAll: async () => ({ permissions: [], origins: [] }),
      contains: async () => false,
      request: async () => false,
      remove: async () => true,
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    runtime: {
      id: 'store',
      getURL: (path) => `${location.origin}/${path}`,
      getManifest: () => ({ host_permissions: [], content_scripts: [] }),
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
