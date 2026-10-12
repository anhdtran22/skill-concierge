// SKETCH of the v2 test file (claude-code/testing). Names and pass conditions are the contract;
// bodies are TODO. The kit cannot raise prompt.autocomplete (grounding §4 Test kit), so the
// typing path is driven through the exported pure functions plus a direct call of the module's
// observe/prepare via a test-only seam, and the submit path through $.prompt.submit with origin.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, Plugin, RenderPropsOf } from 'claude-code'

import { bandText, eligible, parsePrepareOutput, settlement, tailText } from '../hooks/register'

// A fake --prepare answer, the shape enforcer.py prints (see sketch/enforcer-handoff-sketch.py _prepare).
const DRAFT = 'add dark mode w/ ui-kit to the settings page'
const PREPARE_STDOUT = JSON.stringify({
  handoff: { v: 2, prompt: DRAFT, route: `${DRAFT}\n\nAdd a dark mode toggle with ui-kit.`, jev: { route: '…', result: [], event: {}, t: 0 } },
  view: { kind: 'whole_shelf', stage: 'full', n: 616, fit: 0.71, ms: 2600, rows: [
    { name: 'ui-styling', share: 61, badge: ' ⭐', blurb: 'Style interfaces…' },
    { name: 'frontend-design', share: 22, badge: '', blurb: 'Design web pages…' },
    { name: 'ak-test', share: 17, badge: ' ❤️🔥', blurb: 'Run tests…' },
  ] },
})

// Stands in for the model, the enforcer process, the disk and the clock beneath the plugin.
function engine(on: On) {
  // TODO: on('model.complete') → '<intent>Add a dark mode toggle with ui-kit.</intent>'
  //       on('process.run') → record {argv, stdin, env}; answer PREPARE_STDOUT (or deny when told)
  //       on('env.get') HOME; on('fs.read') installed_plugins.json; on('fs.write') record path+text
  //       on('session.id') 'sess-42'; on('clock.now') a mocked clock the test advances
  throw new Error('not implemented')
}

// A peer band mod that does NOT compose (the disabled prompt-enhancer's shape): draws its own tree, never next(e).
const peerThatHidesTheBand: Plugin = { name: 'peer-band', register: on => { /* TODO: AbovePrompt → own <Text>Peer</Text>; PromptHint → tail 'peer' via next */ } }
// A peer that composes: wraps next(e) and appends a tail of its own.
const peerThatComposes: Plugin = { name: 'peer-compose', register: on => { /* TODO */ } }

// ── pure contracts ──────────────────────────────────────────────────────────────────────────────

test('eligible: slash commands and drafts of three words or fewer never prepare', () => {
  // PASS: eligible('/compact') === false; eligible('fix it now') === false; eligible('fix the login bug') === true
})

test('settlement: ready for the exact prepared text, wait for the in-flight one, none otherwise', () => {
  // PASS: ready carries the handoff string; wait carries capMs = 3750 - age, floored at 0; a trailing newline on the
  //       sent text still matches (both sides trimmed, as enforcer.py _handoff strips)
})

test('parsePrepareOutput: rejects an answer for another draft, a missing view, an unknown kind', () => {
  // PASS: null for handoff.prompt !== text; null for view.kind 'bogus'; the good case returns handoff as a string
})

// ── the typing path ─────────────────────────────────────────────────────────────────────────────

test('a quiet eligible draft starts exactly one --prepare with the draft, the intent route and the session id, ledger off', async ($, on) => {
  // Drive: feed DRAFT through the observe seam; advance the mocked clock 1200 ms.
  // PASS: one process.run; argv ends ['--prepare']; stdin.prompt === DRAFT; stdin.route startsWith DRAFT and contains the
  //       intent; stdin.session_id === 'sess-42'; env.ENFORCER_LEDGER === '0'; $.prompt.fill was never called
})

test('a keystroke before the prepare lands makes its result stale: nothing shown, nothing handed off', async ($, on) => {
  // PASS: after the result lands with a changed draft, prepared stays null and no fs.write happens on submit of the new text
})

test('one prepare in flight at a time; the newer quiet draft is prepared when the first lands', async ($, on) => {
  // PASS: two drafts, second typed during the first's run → exactly two process.run calls, in order, the second for the newer draft
})

test('a failed prepare (python missing, bad JSON, timeout) leaves no state and raises no toast', async ($, on) => {
  // PASS: prepared null, inflight null, fake.toasts empty, submit writes nothing, next(e) still called
})

// ── the submit path ─────────────────────────────────────────────────────────────────────────────

test('sending the prepared text writes the handoff bytes verbatim to route-hints/<sid>.json before next(e)', async ($, on) => {
  // Drive: prepare DRAFT, then $.prompt.submit({ text: DRAFT, origin: { kind: 'composer' } }) with a bottom hook that records order.
  // PASS: writes['/home/me/.claude/skill-concierge/route-hints/sess-42.json'] === JSON.stringify(handoff object as printed);
  //       the write happened before the bottom hook ran; prepared is null afterwards (one-shot)
})

test('an in-flight prepare for the sent text is awaited at most 3750 ms minus its age', async ($, on) => {
  // PASS: with the process answer delayed past the cap on the mocked clock, next(e) runs with no file written;
  //       with it delayed under the cap, the file is written
})

test('an edited draft, a non-composer origin, a slash command: no file, next(e) untouched', async ($, on) => {
  // PASS: zero fs.write for each; e passed to next unchanged (text, context, origin identical)
})

// ── the surfaces, under both peers, on both surfaces ───────────────────────────────────────────

const SURFACES = ['terminal', 'desktop'] as const

test('the band draws one dim row of the prepared rows and no Button or hotkey', async ($, on) => {
  // PASS (each surface): find Text matching /Concierge · whole-shelf: ui-styling ⭐ 61% · frontend-design 22% · ak-test ❤️🔥 17%/;
  //       find({ type: 'Button' }) undefined; nothing drawn when prepared is null (tree equals next(e)'s)
})

test('under a peer that composes, both the peer tree and our row show; our tail follows the peer tail', { plugins: [peerThatComposes] }, async ($, on) => {
  // PASS: band holds the peer's Text and ours; PromptHint tail === 'peer  concierge: 3 ranked (full)'
})

test('under a peer that does not compose, our row is absent and the tail still reports; the handoff still happens', { plugins: [peerThatHidesTheBand] }, async ($, on) => {
  // PASS: band holds only 'Peer'; tail carries 'concierge: 3 ranked (full)'; submit of DRAFT still writes the file
})

test('tail and band texts per view kind', () => {
  // PASS: tailText(null, inflight) === 'concierge: ranking…'; whole_shelf → 'concierge: 3 ranked (full)'; jev_skip → 'concierge: no skill fits';
  //       bandText for 'lane' and 'none' is null
})
