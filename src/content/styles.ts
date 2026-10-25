/**
 * Styles for the shadow roots the extension adds to Gmail (the chip in the search bar, the chat panel, the floating
 * fallback button). Shadow DOM keeps Gmail's CSS out and ours in. The palette follows Gmail's own (Material 3 colour
 * roles), light or dark to match whichever theme Gmail is showing: the host element carries data-theme.
 */

const LIGHT = `
  --surface: #ffffff;
  --surface-dim: #f6f8fc;
  --container: #e9eef6;
  --container-high: #dde3ea;
  --on-surface: #1f1f1f;
  --on-variant: #444746;
  --outline: #747775;
  --outline-variant: #c4c7c5;
  --divider: #e1e3e1;
  --hover: rgba(68, 71, 70, 0.08);
  --pressed: rgba(68, 71, 70, 0.12);
  --primary: #0b57d0;
  --on-primary: #ffffff;
  --primary-container: #d3e3fd;
  --on-primary-container: #041e49;
  --error: #b3261e;
  --error-container: #fce8e6;
  --shadow: 0 1px 3px 0 rgba(60, 64, 67, 0.3), 0 4px 8px 3px rgba(60, 64, 67, 0.15);
`;

const DARK = `
  --surface: #1e1f20;
  --surface-dim: #131314;
  --container: #282a2c;
  --container-high: #333537;
  --on-surface: #e3e3e3;
  --on-variant: #c4c7c5;
  --outline: #8e918f;
  --outline-variant: #444746;
  --divider: #37393b;
  --hover: rgba(227, 227, 227, 0.08);
  --pressed: rgba(227, 227, 227, 0.12);
  --primary: #a8c7fa;
  --on-primary: #062e6f;
  --primary-container: #0842a0;
  --on-primary-container: #d3e3fd;
  --error: #f2b8b5;
  --error-container: #601410;
  --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.5), 0 4px 8px 3px rgba(0, 0, 0, 0.3);
`;

const BASE = `
  --font: "Google Sans Text", "Google Sans", Roboto, Arial, sans-serif;
  --display: "Google Sans", Roboto, Arial, sans-serif;
  --mono: "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
`;

const THEMES = `
:host { all: initial; ${BASE} ${LIGHT} }
:host([data-theme="dark"]) { ${DARK} }
`;

export const BUTTON_CSS = `
${THEMES}
:host { display: inline-flex; align-items: center; }
button {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; margin: 0;
  border: 1px solid var(--outline-variant); border-radius: 8px; background: transparent; color: var(--on-variant);
  font: 500 14px/1 var(--display); letter-spacing: 0.01em; cursor: pointer; white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
button:hover { background: var(--hover); }
button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
button.ask { background: var(--primary-container); border-color: transparent; color: var(--on-primary-container); }
button.ask:hover { background: color-mix(in srgb, var(--primary-container) 88%, var(--on-primary-container)); }
.icon { width: 18px; height: 18px; flex: none; }
kbd { font: 500 11px/1 var(--mono); padding: 2px 4px; border-radius: 4px; background: var(--hover); color: inherit; }
`;

export const PANEL_CSS = `
${THEMES}
* { box-sizing: border-box; }
.panel {
  position: fixed; z-index: 2147483000; display: flex; flex-direction: column;
  background: var(--surface); color: var(--on-surface); border-radius: 16px; box-shadow: var(--shadow);
  font: 14px/1.6 var(--font); overflow: hidden;
  animation: drop 160ms cubic-bezier(0.2, 0, 0, 1) both;
}
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
button { font: inherit; color: inherit; }
.icon { width: 20px; height: 20px; flex: none; }
button:focus-visible, textarea:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

header { display: flex; align-items: center; gap: 4px; height: 48px; padding: 0 8px 0 16px; flex: none; }
.title { display: flex; align-items: center; gap: 8px; font: 500 15px/1 var(--display); color: var(--on-surface); cursor: default; }
.title .icon { color: var(--primary); width: 18px; height: 18px; }
.title .badge { padding: 2px 8px; border-radius: 10px; background: var(--surface-dim); border: 1px solid var(--divider); color: var(--on-variant); font: 500 11px/1.3 var(--display); }
.spacer { flex: 1; }
.icon-button {
  display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: var(--on-variant); cursor: pointer; transition: background-color 120ms ease;
}
.icon-button:hover { background: var(--hover); }
.icon-button:active { background: var(--pressed); }

.notice { margin: 0 16px 8px; padding: 8px 12px; border-radius: 8px; font-size: 13px; background: var(--surface-dim); color: var(--on-variant); }
.notice strong { color: var(--on-surface); font-weight: 500; }

.scroll { flex: 1; overflow-y: auto; padding: 0 20px 12px; scrollbar-width: thin; scrollbar-color: var(--outline-variant) transparent; }

.empty { padding: 4px 0 8px; }
.empty h2 { margin: 0 0 12px; font: 400 16px/1.4 var(--display); color: var(--on-variant); }
.suggestions { display: flex; flex-wrap: wrap; gap: 8px; }
.suggestion {
  display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; cursor: pointer;
  border: 1px solid var(--outline-variant); border-radius: 8px; background: transparent; color: var(--on-variant);
  font: 500 14px/1 var(--display); transition: background-color 120ms ease;
}
.suggestion:hover { background: var(--hover); }
.suggestion .icon { width: 18px; height: 18px; color: var(--primary); }
.disclaimer { margin: 14px 0 0; font-size: 12px; color: var(--on-variant); }

.turn { padding-top: 16px; }
.turn + .turn { margin-top: 8px; border-top: 1px solid var(--divider); }
.question {
  margin-left: auto; width: fit-content; max-width: 80%; padding: 8px 16px; border-radius: 18px 18px 4px 18px;
  background: var(--container); color: var(--on-surface); white-space: pre-wrap; overflow-wrap: anywhere;
}
.status { display: flex; align-items: center; gap: 10px; margin-top: 12px; color: var(--on-variant); font-size: 13px; min-width: 0; }
.status .what { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spinner { flex: none; width: 16px; height: 16px; border: 2px solid var(--container-high); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
details.trail { margin-top: 10px; color: var(--on-variant); font-size: 12.5px; }
details.trail summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 4px; border-radius: 6px; padding: 2px 6px 2px 2px; }
details.trail summary::-webkit-details-marker { display: none; }
details.trail summary:hover { background: var(--hover); }
details.trail summary .icon { width: 16px; height: 16px; transition: transform 120ms ease; transform: rotate(-90deg); }
details.trail[open] summary .icon { transform: none; }
.steps { list-style: none; margin: 6px 0 0 6px; padding: 0 0 0 12px; border-left: 2px solid var(--divider); display: grid; gap: 2px; }
.steps li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
code.q { font: 12px var(--mono); color: var(--on-surface); }

.answer { margin-top: 10px; overflow-wrap: anywhere; color: var(--on-surface); }
.answer p { margin: 0 0 10px; }
.answer p:last-child { margin-bottom: 0; }
.answer .md-heading { font-weight: 500; font-family: var(--display); margin-top: 14px; }
.answer ul, .answer ol { margin: 0 0 10px; padding-left: 22px; }
.answer li { margin: 2px 0; }
.answer li::marker { color: var(--on-variant); }
.answer code { font: 13px var(--mono); background: var(--surface-dim); padding: 1px 5px; border-radius: 4px; }
.answer pre { margin: 0 0 10px; padding: 10px 12px; background: var(--surface-dim); border-radius: 8px; overflow-x: auto; }
.answer pre code { padding: 0; background: none; }
.answer a { color: var(--primary); }
.answer strong { font-weight: 600; }
.cite {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; margin: 0 1px 0 2px; vertical-align: 1px;
  border: 0; border-radius: 9px; background: var(--primary-container); color: var(--on-primary-container);
  font: 500 11px/1 var(--display); cursor: pointer; transition: filter 120ms ease;
}
.cite:hover { filter: brightness(0.95); }
.md-thread { border: 0; padding: 0; background: none; color: var(--primary); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.streaming .answer > :last-child::after {
  content: ""; display: inline-block; width: 8px; height: 8px; margin-left: 4px; border-radius: 50%;
  background: var(--primary); animation: pulse 1s ease-in-out infinite; vertical-align: 1px;
}
@keyframes pulse { 50% { opacity: 0.25; } }

.sources { list-style: none; margin: 12px 0 0; padding: 0; }
.source {
  display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; width: 100%;
  min-height: 40px; padding: 6px 8px; margin: 0 -8px; width: calc(100% + 16px); border: 0; border-radius: 8px;
  background: transparent; text-align: left; cursor: pointer; transition: background-color 120ms ease;
}
.source:hover { background: var(--hover); }
.source .num {
  display: grid; place-items: center; width: 20px; height: 20px; border-radius: 10px;
  background: var(--primary-container); color: var(--on-primary-container); font: 500 11px/1 var(--display);
}
.source .text { display: grid; min-width: 0; line-height: 1.35; }
.source .subject { color: var(--on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source .from { color: var(--on-variant); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source .date { color: var(--on-variant); font-size: 12px; white-space: nowrap; }

.error { margin-top: 12px; padding: 10px 14px; border-radius: 8px; background: var(--error-container); color: var(--error); font-size: 13px; }
.error .actions { margin-top: 8px; }

.setup { padding: 4px 0 8px; }
.setup h2 { margin: 0 0 6px; font: 400 18px/1.4 var(--display); }
.setup p { margin: 0 0 14px; color: var(--on-variant); }
.setup .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.checks { list-style: none; margin: 0 0 16px; padding: 0; display: grid; gap: 8px; }
.checks li { display: flex; align-items: center; gap: 10px; }
.checks .mark { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--outline); color: var(--on-primary); }
.checks li.done .mark { background: var(--primary); border-color: var(--primary); }
.checks li.done .mark .icon { width: 12px; height: 12px; }
.checks li.todo { color: var(--on-variant); }

.button {
  display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 20px; border-radius: 18px; cursor: pointer;
  border: 0; background: var(--primary); color: var(--on-primary); font: 500 14px/1 var(--display);
  transition: box-shadow 120ms ease, filter 120ms ease;
}
.button:hover { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 3px 1px rgba(0, 0, 0, 0.15); }
.button .icon { width: 18px; height: 18px; }

form.composer { flex: none; padding: 8px 12px 12px; }
.field {
  display: flex; align-items: flex-end; gap: 4px; min-height: 48px; padding: 4px 4px 4px 20px; border-radius: 24px;
  background: var(--container); transition: background-color 120ms ease, box-shadow 120ms ease;
}
.field:focus-within { background: var(--surface); box-shadow: var(--shadow); }
textarea {
  flex: 1; min-height: 40px; max-height: 160px; resize: none; padding: 10px 0; border: 0; outline: none;
  background: transparent; color: var(--on-surface); font: 16px/1.25 var(--font);
}
textarea::placeholder { color: var(--on-variant); }
textarea:focus-visible { outline: none; }
.send {
  display: grid; place-items: center; flex: none; width: 40px; height: 40px; border: 0; border-radius: 50%; cursor: pointer;
  background: transparent; color: var(--primary); transition: background-color 120ms ease, color 120ms ease;
}
.send:hover { background: var(--hover); }
.send:disabled { color: var(--outline-variant); cursor: default; background: transparent; }
.send.stop { color: var(--on-variant); }
.muted { color: var(--on-variant); }
.small { font-size: 12px; }

/* "This email" context, above the question box. */
.context:empty { display: none; }
.context { padding: 0 4px 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 28px; padding: 0 4px 0 10px;
  border-radius: 8px; background: var(--surface-dim); border: 1px solid var(--divider); color: var(--on-variant); font-size: 12.5px;
}
.chip .icon { width: 16px; height: 16px; flex: none; }
.chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-x { display: grid; place-items: center; flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--on-variant); cursor: pointer; }
.context-x:hover { background: var(--hover); }
.context-x .icon { width: 14px; height: 14px; }

/* A proposed change, waiting for the user's Confirm. */
.proposal { margin-top: 14px; border: 1px solid var(--outline-variant); border-radius: 12px; overflow: hidden; }
.proposal.is-applied, .proposal.is-undone, .proposal.is-cancelled { border-color: var(--divider); }
.proposal-head { display: grid; gap: 2px; padding: 12px 16px 8px; }
.proposal-head strong { font: 500 14px/1.4 var(--display); }
.proposal-head .muted { font-size: 13px; }
.proposal-items { list-style: none; margin: 0; padding: 0 8px; max-height: 260px; overflow-y: auto; }
.proposal-items li { display: flex; align-items: center; gap: 10px; padding: 0 8px; border-radius: 8px; }
.proposal-items li:hover { background: var(--hover); }
.proposal-items input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--primary); cursor: pointer; }
.item-text { display: grid; flex: 1; min-width: 0; padding: 6px 0; border: 0; background: none; text-align: left; cursor: pointer; line-height: 1.35; }
.item-text .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--on-surface); }
.item-text .from { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--on-variant); font-size: 12px; }
.proposal > .muted { margin: 8px 16px 12px; }
.proposal-actions { display: flex; align-items: center; gap: 12px; padding: 10px 16px 12px; border-top: 1px solid var(--divider); }
.proposal-actions .result { flex: 1; color: var(--on-surface); font-size: 13px; }
.text-button {
  display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 12px; border: 0; border-radius: 16px; flex: none;
  background: none; color: var(--primary); font: 500 14px/1 var(--display); cursor: pointer;
}
.text-button:hover { background: var(--hover); }
.text-button .icon { width: 16px; height: 16px; }
.button:disabled { opacity: 0.4; cursor: default; box-shadow: none; }

/* Proposed automation rule: a compact definition list. */
.rule-body { display: grid; gap: 4px; padding: 4px 16px 12px; font-size: 13.5px; line-height: 1.4; }
.rule-body .subject { color: var(--on-surface); font-weight: 600; }
.rule-row { display: grid; grid-template-columns: 56px 1fr; gap: 8px; overflow-wrap: anywhere; }
.rule-label { color: var(--on-variant); }
.rule-row .was { display: block; color: var(--on-variant); font-size: 12.5px; text-decoration: line-through; }

/* Proposed filter changes: one block per change, the filters it replaces struck through. */
.filter-changes { max-height: 380px; }
.filter-changes li { align-items: flex-start; padding: 8px; }
.filter-changes li + li { border-top: 1px solid var(--divider); border-radius: 0; }
.filter-changes input { margin-top: 3px; }
.filter-change { display: grid; gap: 3px; flex: 1; min-width: 0; font-size: 13.5px; line-height: 1.4; overflow-wrap: anywhere; }
.filter-change .subject { color: var(--on-surface); font-weight: 600; }
.filter-change .was { color: var(--on-variant); font-size: 12.5px; text-decoration: line-through; }
.filter-change .small { font-size: 12.5px; }
.filter-warn { color: var(--error); font-size: 12.5px; }
.needs { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px; padding: 10px 14px; border-radius: 8px; background: var(--surface-dim); border: 1px solid var(--divider); font-size: 13px; }
.needs span { flex: 1; min-width: 200px; }

/* Proposed calendar event: Calendar-style block with the details, linked to the email it came from. */
.event-body { display: flex; gap: 12px; padding: 4px 16px 10px; }
.event-icon { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: var(--primary-container); color: var(--on-primary-container); }
.event-icon .icon { width: 18px; height: 18px; }
.event-text { display: grid; gap: 2px; min-width: 0; line-height: 1.4; font-size: 13.5px; }
.event-text .subject { color: var(--on-surface); font-weight: 600; }
.event-text .from { color: var(--on-variant); }
.event-notes { color: var(--on-variant); font-size: 12.5px; white-space: pre-line; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.event-source { margin: 0 16px 8px 52px; max-width: calc(100% - 68px); height: 28px; padding: 0 10px; font-size: 13px; }
.event-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; justify-content: flex-start; }

/* Wide panel: keep lines at a readable length instead of stretching across the screen. */
.panel.expanded .scroll > *, .panel.expanded form.composer .field { max-width: 760px; margin-left: auto; margin-right: auto; }
.icon-more { stroke-width: 2.75; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

/** The "with Inbox Pilot" badge beside Gmail's logo (brand.ts), in Gmail's header type. */
export const BRAND_CSS = `
${THEMES}
:host { display: block; }
button {
  display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 6px; margin: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--on-variant); font-family: var(--display); white-space: nowrap; cursor: pointer;
  transition: background-color 120ms ease;
}
button:hover { background: var(--hover); }
button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.words { display: flex; align-items: baseline; gap: 4px; }
.with { font: 400 13px/1.1 var(--display); }
.name { font: 500 14px/1.1 var(--display); color: var(--on-surface); }
.mark { width: 22px; height: 22px; flex: none; border-radius: 6px; }
svg.mark { color: var(--primary); }
button.stack .words { flex-direction: column; align-items: flex-start; gap: 0; }
button.stack .with { font-size: 11px; }
button.compact .words { display: none; }
`;
