// Test plan as a sketch (claude-code/testing; *.test.tsx is a file the kit runs, d.ts:29-30).
// Bodies are TODO; names, fakes and pass conditions are the contract.
//
// The kit cannot raise `prompt.autocomplete` (grounding §4), and the hook that receives it is one
// line, `speculator?.note(e.text)`. So the observer tests construct the exported `Speculator` with
// the test's `$` and call `note()` directly, advancing `mock.clock` past SETTLE_MS. Everything else
// goes through events the kit raises: `session.start`, `turn.start`/`turn.complete` and
// `prompt.submit` with origin `composer`, so register.tsx's wiring is tested as loaded.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { INTENT_RULES, Speculator, parseSpeculation, statusFor } from '../hooks/speculator'

type Fake = {
  box: string
  spawned: { argv: readonly string[]; env: Record<string, string>; input: string }[]
  killed: number
  enforcerStdout: string
  intents: string[]
  status: (string | undefined)[]
}

// Stands in for the prompt box, the session, the small model, the enforcer child and the status
// line beneath the plugin. The enforcer child answers `enforcerStdout` once its input is read.
function engine(on: On): Fake {
  // TODO: on('prompt.read'), on('session.id') -> 'sess-42', on('session.root'), on('session.messages'),
  //       on('model.complete') -> '<intent>…</intent>', on('process.spawn', async function* …) recording
  //       argv/env/input and counting a `return()` as killed, on('ui.status') recording texts,
  //       on('fs.read'/'fs.stat') for installed_plugins.json, mock.clock(on)
  throw new Error('not implemented')
}

const RANKED = JSON.stringify({
  hookSpecificOutput: { additionalContext: '…' },
  skillConciergeSpeculation: { v: 1, ticket: 'ranked',
    preview: { kind: 'menu', skills: ['ui-styling', 'frontend-design', 'ak-test'], whole_shelf: true } },
})

test('A settled draft is ranked once by the real enforcer path and its menu shows on the status line', async ($, on) => {
  // Pass: exactly one spawn after SETTLE_MS; argv = ['python3', '<install>/hooks/scripts/enforcer.py'];
  // env ⊇ { SKILL_CONCIERGE_HARNESS: 'claude', ENFORCER_LEDGER: 'defer' };
  // JSON.parse(input) deep-equals { prompt: DRAFT, session_id: 'sess-42', speculate: { intent: INTENT, n: 1 } };
  // last status === 'concierge ▸ ui-styling · frontend-design · ak-test'.
})

test('Typing again before the settle time ranks nothing; typing after a run starts kills it and ranks the new draft', async ($, on) => {
  // Pass: 0 spawns at SETTLE_MS - 1; then after a run starts and the draft changes: killed === 1, spawns === 2,
  // and no status ever names the first draft's menu once the box changed.
})

test('Empty drafts, slash commands and drafts under four words are never ranked', async ($, on) => {
  // Pass: for '', '/compact now please ok', 'fix it now': spawns === 0, intents === 0, status cleared.
})

test('Nothing is ranked while a turn runs; the waiting draft is ranked after the turn ends', async ($, on) => {
  // Pass: turn.start then settle -> 0 spawns; turn.complete then settle -> 1 spawn.
})

test('Enter keeps the matching run alive through the command hooks and kills it afterwards', async ($, on) => {
  // Bottom prompt.submit hook records `killed` at entry. Pass: killed === 0 inside the bottom hook,
  // killed === 1 after `$.prompt.submit` resolves.
})

test('Enter on an edited draft kills the stale run before the command hooks run', async ($, on) => {
  // Pass: killed === 1 already inside the bottom prompt.submit hook.
})

test('The submitted prompt passes through untouched: same text, no added context, same origin', async ($, on) => {
  // Pass: the bottom hook's `e` deep-equals what the kit raised (text, context undefined, origin composer).
})

test('A failed or slow intent call ranks the draft alone', async ($, on) => {
  // model.complete answers { isAnswered: false, reason: 'aborted' }. Pass: input.speculate.intent === ''.
})

test('The intent rules name no skills, keep the author terms verbatim and ask the author nothing', () => {
  expect(INTENT_RULES).toContain('Name no skills, plugins, agents or slash commands.')
  expect(INTENT_RULES).toContain('"chisle" stays "chisle"')
  expect(INTENT_RULES).not.toMatch(/ask|question/i)
})

test('An enforcer that cannot speculate turns the mod inert for the session', async ($, on) => {
  // enforcerStdout lacks skillConciergeSpeculation. Pass: after the first run, further settles spawn nothing
  // and the status stays empty.
})

test('The boundary parser and the status line', () => {
  // Pass, literal values:
  // parseSpeculation(RANKED) -> { kind: 'menu', skills: [...3], wholeShelf: true }
  // parseSpeculation('{}') -> 'incompatible'; parseSpeculation('not json') -> null
  // statusFor({ kind: 'menu', skills: ['a', 'b'], wholeShelf: false }) === 'concierge ▸ a · b (preview)'
  // statusFor({ kind: 'no-skill' }) === 'concierge ▸ no skill needed'; statusFor({ kind: 'silent' }) === undefined
})

// ── Coexistence: an inline peer band plugin that composes with nobody ─────────────────────────────
// Modeled on the disabled prompt-enhancer v0.1.3: it draws its own AbovePrompt tree without calling
// next(e), binds hotkey `e`, and appends context on prompt.submit.
const PEER = {
  name: 'peer-band',
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box, Button } = $.ui.resolve(e)
      return <Box><Button key="peer-enhance" label="Enhance" hotkey="e" onPress={() => {}} /></Box>
    })
    on('prompt.submit', ($, e, next) => next({ ...e, context: [...(e.context ?? []), 'PEER-CONTEXT'] }))
  },
}

test('Beside a peer band mod both work: its band, hotkey and context survive, our status still shows', { plugins: [PEER] }, async ($, on) => {
  // Pass, on both surfaces ['terminal', 'desktop']:
  // - mount AbovePrompt: find({ key: 'peer-enhance' }) defined (we draw nothing there, so the peer's tree is
  //   the whole band whatever the chain order);
  // - the bottom prompt.submit hook sees context === ['PEER-CONTEXT'] (we neither add nor drop context);
  // - after a settle, status === 'concierge ▸ ui-styling · frontend-design · ak-test';
  // - the kit's report of skipped hooks is empty.
})

// A peer that rewrites `text` at prompt.submit is covered on the Python side: whatever the chain order,
// the enforcer receives the rewritten text, `offer_ticket.find` matches no ticket, and the turn ranks live
// (tests/test_offer_ticket.py, "an edited or rewritten prompt finds no ticket").
