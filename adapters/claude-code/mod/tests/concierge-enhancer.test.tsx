// The mod is driven through the events the kit raises (session.start, prompt.autocomplete, turn.start,
// turn.complete, prompt.submit, session.end), so register.tsx's wiring is tested as loaded. The
// enforcer child is the kit's `process.spawn` hook: it records argv, env and stdin, and answers
// `fake.stdout`; with `fake.hold` it stays parked until `fake.finish()` or until it is killed
// (the stream's abort signal), which is how the engine ends a child.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, ModelUsage, On, ProcessSpawnChunk, ProcessSpawnResult, RenderPropsOf } from 'claude-code'

import {
  INTENT_MAX_CHARS,
  INTENT_RULES,
  INTENT_TIMEOUT_MS,
  MAX_AUTO_RUNS,
  MAX_RUNS_PER_PROMPT,
  MIN_WORDS,
  RANK_TIMEOUT_MS,
  SETTLE_MS,
  WATCH_MS,
  compareVersions,
  enabledPluginsOf,
  findOffer,
  installedEnforcers,
  bandRows,
  statusBudget,
  menuFor,
  parseSpeculation,
  rankChordFrom,
  sentMenu,
  rankable,
  sentStatus,
  statusFor,
  middleCut,
} from '../hooks/speculator'

const USAGE = {} as ModelUsage
const HOME = '/home/me'
const INSTALL = '/cache/skill-concierge/0.67.0'
const ENFORCER = `${INSTALL}/hooks/scripts/enforcer.py`
const DRAFT = 'add dark mode w/ ui-kit to settings'
const INTENT = 'Add a dark mode toggle to the settings page with ui-kit.'

const RANKED = JSON.stringify({
  hookSpecificOutput: { additionalContext: '...' },
  skillConciergeSpeculation: {
    v: 1,
    ticket: 'ranked',
    preview: { kind: 'menu', skills: ['ui-styling', 'frontend-design', 'ak-test'], whole_shelf: true },
  },
})
const MENU_STATUS = 'concierge ▸ ui-styling · frontend-design · ak-test'
const LEDGER = `${HOME}/.claude/skill-concierge/logs/skill-invocation-ledger.log`
const SENT_STATUS = 'concierge ✓ ui-styling · frontend-design'
const offerRow = (extra: Record<string, unknown> = {}) => JSON.stringify({ ev: 'offer', sid: 'sess-42', q: DRAFT, ...extra })

type Spawn = { argv: readonly string[]; env: Record<string, string>; input: string }
type Fake = {
  box: string
  spawned: Spawn[]
  killed: number
  hold: boolean
  stdout: string
  finish: () => void
  completes: { model: string; system: unknown; prompt: unknown; timeoutMs: number | undefined; maxTokens: number | undefined }[]
  intent: ModelCompleteResult
  status: (string | undefined)[]
  registry: object | null
  // What `$.settings.read({ source })` answers, per source; a source not listed holds nothing.
  settings: Partial<Record<'user' | 'project' | 'local' | 'flag' | 'policy', Record<string, unknown>>>
  env: Record<string, string>
  files: Set<string>
  messages: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[]
  // What the bottom prompt.submit hook saw: the event, and how many children were killed by then.
  submitted: { e: unknown; killed: number }[]
  // While set, the intent call waits for it.
  intentGate: Promise<void> | null
  // The ledger tail the `tail` child answers, the argv of each tail read, and how many were answered.
  ledger: string
  tails: (readonly string[])[]
  tailsAnswered: number
  // While set, the tail child waits for it.
  tailGate: Promise<void> | null
  // What the band's insert keys wrote into the box ($.prompt.fill), and whether the box takes it.
  fills: { text: string; mode: string | undefined }[]
  fillRefused: boolean
  // While set, the fill calls it (the test raises the box's autocomplete event) before it resolves, as an edit does.
  fillEcho: (() => Promise<unknown>) | null
  // The text of the person's keybindings.json; null: no such file.
  keybindings: string | null
}

// Stands in for the prompt box, the session, the small model, the plugin registry, the enforcer
// child and the status line beneath the plugin.
function engine(on: On) {
  const clock = mock.clock(on)
  const waiters: (() => void)[] = []
  const fake: Fake = {
    box: '',
    spawned: [],
    killed: 0,
    hold: false,
    stdout: RANKED,
    finish: () => waiters.splice(0).forEach(release => release()),
    completes: [],
    intent: { isAnswered: true, text: `<intent>${INTENT}</intent>`, usage: USAGE },
    status: [],
    registry: { version: 2, plugins: { 'skill-concierge@skill-concierge': [{ scope: 'user', installPath: INSTALL, version: '0.67.0' }] } },
    settings: {},
    env: { HOME },
    files: new Set([ENFORCER]),
    messages: [{ role: 'assistant', text: 'Earlier answer about the build.', toolUses: [] }],
    submitted: [],
    intentGate: null,
    ledger: '',
    tails: [],
    tailsAnswered: 0,
    tailGate: null,
    fills: [],
    fillRefused: false,
    fillEcho: null,
    keybindings: null,
  }
  on('prompt.read', () => ({ value: { text: fake.box, cursor: fake.box.length } }))
  on('session.id', () => ({ value: 'sess-42' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.messages', () => ({ value: fake.messages }))
  on('model.complete', async (_$, e) => {
    await fake.intentGate
    fake.completes.push({ model: e.model, system: e.system, prompt: e.prompt, timeoutMs: e.timeoutMs, maxTokens: e.maxTokens })
    return { value: fake.intent }
  })
  on('ui.status', (_$, e) => {
    fake.status.push(e.text)
    return { value: undefined }
  })
  on('settings.read', (_$, e) => ({ value: fake.settings[e.source ?? 'user'] ?? {} }))
  on('env.get', (_$, e) => ({ value: fake.env[e.name] }))
  // What the engine draws in the band beneath the plugins: its own tree (an `engine` node).
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  // The cursor sits at the end of the box, as it does after typing; an insert lands there.
  on('prompt.fill', async (_$, e) => {
    fake.fills.push({ text: e.text, mode: e.mode })
    if (fake.fillRefused) return { isFilled: false }
    fake.box = e.mode === 'insert' || e.mode === 'append' ? fake.box + e.text : e.text
    await fake.fillEcho?.()
    return { isFilled: true }
  })
  on('fs.read', (_$, e) =>
    e.path === `${HOME}/.claude/plugins/installed_plugins.json` && fake.registry
      ? { value: JSON.stringify(fake.registry) }
      : e.path === `${HOME}/.claude/keybindings.json` && fake.keybindings !== null
        ? { value: fake.keybindings }
        : { deny: 'ENOENT' },
  )
  on('fs.stat', (_$, e) =>
    fake.files.has(e.path)
      ? { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  // The command hooks beneath the mod: records what reached them, and returns the prompt as it came.
  on('prompt.submit', (_$, e) => {
    fake.submitted.push({ e, killed: fake.killed })
    return { text: e.text, context: e.context }
  })
  on('process.spawn', async function* (_$, e, next): AsyncGenerator<ProcessSpawnChunk, { value: ProcessSpawnResult }, void> {
    if (e.argv[0] === 'tail') {
      // The sent-menu read of concierge's ledger: not an enforcer run, so it is kept apart from `spawned`.
      fake.tails.push(e.argv)
      await fake.tailGate
      fake.tailsAnswered++
      if (fake.ledger) yield { stream: 'stdout' as const, text: fake.ledger }
      return { value: { code: 0, signal: null } }
    }
    fake.spawned.push({ argv: e.argv, env: e.env ?? {}, input: e.input ?? '' })
    let isDead = false
    let release = (): void => undefined
    const parked = new Promise<void>(resolve => {
      release = resolve
    })
    waiters.push(release)
    next.signal.addEventListener(
      'abort',
      () => {
        isDead = true
        fake.killed++
        release()
      },
      { once: true },
    )
    if (fake.hold) await parked
    if (isDead) return { value: { code: null, signal: 'SIGTERM' } }
    yield { stream: 'stdout' as const, text: fake.stdout }
    return { value: { code: 0, signal: null } }
  })
  return { fake, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

// Types `text` into the box as the engine does: the box holds it, then autocomplete is raised.
async function type($: Engine, fake: Fake, text: string) {
  fake.box = text
  const token = text.split(/\s+/).pop() || ' '
  // The kit's typings omit this event; the engine raises it all the same.
  const raise = ($.prompt as unknown as { autocomplete: (e: object) => Promise<unknown> }).autocomplete
  await raise({ text, cursor: text.length, token, start: text.length - token.length })
}

const composer = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('A settled draft is sent once to the enforcer as a speculation request and its menu shows on the status line', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS - 1)
  expect(fake.spawned.length).toBe(0)
  await clock.advance(1)
  expect(fake.spawned.length).toBe(1)
  const [call] = fake.spawned
  expect(call?.argv).toEqual(['python3', ENFORCER])
  expect(call?.env).toEqual({ SKILL_CONCIERGE_HARNESS: 'claude', ENFORCER_LEDGER: 'defer' })
  expect(JSON.parse(call?.input ?? '{}')).toEqual({
    prompt: DRAFT,
    session_id: 'sess-42',
    cwd: '/work/app',
    speculate: { intent: '', n: 1 },
  })
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  expect(SETTLE_MS).toBe(2000)
})

test('The intent option is off by default: no model call, an empty intent', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.completes.length).toBe(0)
  expect(JSON.parse(fake.spawned[0]?.input ?? '{}').speculate.intent).toBe('')
})

test('With the intent option on, haiku writes one sentence that rides the speculation request', { options: { intent: true } }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.completes.length).toBe(1)
  const [ask] = fake.completes
  expect(ask?.model).toBe('haiku')
  expect(ask?.timeoutMs).toBe(2500)
  expect(INTENT_TIMEOUT_MS).toBe(2500)
  expect(ask?.system).toBe(INTENT_RULES)
  expect(String(ask?.prompt)).toContain(`<rough_prompt>\n${DRAFT}\n</rough_prompt>`)
  expect(String(ask?.prompt)).toContain('Earlier answer about the build.')
  expect(JSON.parse(fake.spawned[0]?.input ?? '{}').speculate).toEqual({ intent: INTENT, n: 1 })
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
})

test('An over-long intent is cut and a failed or slow intent call ranks the draft alone', { options: { intent: true } }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  fake.intent = { isAnswered: true, text: `<intent>${'x'.repeat(INTENT_MAX_CHARS + 50)}</intent>`, usage: USAGE }
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(JSON.parse(fake.spawned[0]?.input ?? '{}').speculate.intent).toBe('x'.repeat(INTENT_MAX_CHARS))
  // A send ends the composed prompt, so the next draft is a new prompt with a run of its own.
  await $.prompt.submit(composer(DRAFT))
  fake.intent = { isAnswered: false, reason: 'aborted', usage: USAGE }
  await type($, fake, `${DRAFT} please`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)
  expect(JSON.parse(fake.spawned[1]?.input ?? '{}').speculate).toEqual({ intent: '', n: 1 })
})

test('The intent rules name no skills, keep the author terms verbatim and ask the author nothing', () => {
  expect(INTENT_RULES).toContain('Name no skills, plugins, agents or slash commands.')
  expect(INTENT_RULES).toContain('"chisle" stays "chisle"')
  expect(INTENT_RULES).toContain('in one plain sentence')
  expect(INTENT_RULES).not.toMatch(/\b(ask|asks|asking|questions?)\b/i)
})

test('Typing again before the settle time ranks nothing; typing after a run starts kills it, and the next prompt is ranked after a send', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.hold = true
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS - 1)
  await type($, fake, `${DRAFT} and a toggle`)
  await clock.advance(SETTLE_MS - 1)
  expect(fake.spawned.length).toBe(0)
  await clock.advance(1)
  expect(fake.spawned.length).toBe(1)
  expect(fake.killed).toBe(0)
  await type($, fake, `${DRAFT} and a toggle in the header`)
  expect(fake.killed).toBe(1)
  expect(fake.status).toEqual([])
  // One automatic run per composed prompt: the edited draft is not ranked again until a send.
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(1)
  await $.prompt.submit(composer(`${DRAFT} and a toggle in the header`))
  await type($, fake, `${DRAFT} and a toggle in the footer`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)
  expect(JSON.parse(fake.spawned[1]?.input ?? '{}').prompt).toBe(`${DRAFT} and a toggle in the footer`)
  fake.finish()
  await clock.settle()
  expect(fake.status).toEqual([MENU_STATUS])
})

test('A result for text no longer in the box is never shown, and an edit clears the line', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.hold = true
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  fake.box = `${DRAFT} changed`
  fake.finish()
  await clock.settle()
  expect(fake.status).toEqual([])
  fake.hold = false
  fake.box = DRAFT
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  await type($, fake, `${DRAFT} more words`)
  expect(fake.status.at(-1)).toBeUndefined()
})

test('A line left behind by an edit that raised no autocomplete is cleared by the guard', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.status).toEqual([MENU_STATUS])
  fake.box = ''
  await clock.advance(WATCH_MS)
  expect(fake.status).toEqual([MENU_STATUS, undefined])
})

test('Empty drafts, slash commands and drafts under four words are never ranked', { options: { intent: true } }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  for (const text of ['', '/compact now please ok', 'fix it now']) {
    await type($, fake, text)
    await clock.advance(SETTLE_MS * 3)
  }
  expect(fake.spawned.length).toBe(0)
  expect(fake.completes.length).toBe(0)
  expect(fake.status).toEqual([])
})

test('The mod floor is four words, one more than the enforcer drops', () => {
  expect(MIN_WORDS).toBe(4)
  expect(rankable('one two three')).toBe(false)
  expect(rankable('one two three four')).toBe(true)
  expect(rankable('  one two\nthree   four ')).toBe(true)
  expect(rankable('/clear one two three')).toBe(false)
  expect(rankable('   ')).toBe(false)
})

test('Nothing is ranked while a turn runs; the waiting draft is ranked after the turn ends', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await $.turn.start({ text: 'earlier prompt', turnId: 't1' })
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS * 2)
  expect(fake.spawned.length).toBe(0)
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(1)
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
})

test('A subagent turn ending does not resume ranking while the main turn runs', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await $.turn.start({ text: 'earlier prompt', turnId: 't1' })
  await type($, fake, DRAFT)
  await $.turn.complete({ answer: 'sub', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'agent-9', reason: 'answer' })
  await clock.advance(SETTLE_MS * 2)
  expect(fake.spawned.length).toBe(0)
})

test('A turn starting kills the run and clears the line', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.hold = true
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  await $.turn.start({ text: DRAFT, turnId: 't2' })
  expect(fake.killed).toBe(1)
  fake.finish()
  await clock.settle()
  expect(fake.status).toEqual([])
})

test('Enter keeps the matching run alive through the command hooks and kills it afterwards', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.hold = true
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(1)
  await $.prompt.submit(composer(DRAFT))
  expect(fake.submitted.map(s => s.killed)).toEqual([0])
  expect(fake.killed).toBe(1)
  expect(fake.submitted[0]?.e).toEqual(composer(DRAFT))
})

test('Enter on an edited draft kills the stale run before the command hooks run', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.hold = true
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  // A paste or an @-mention expands in the submitted text without a new autocomplete event.
  await $.prompt.submit(composer(`${DRAFT} plus pasted text`))
  expect(fake.submitted.map(s => s.killed)).toEqual([1])
})

test('A run that has not spawned its child yet is cancelled at Enter', { options: { intent: true } }, async ($, on) => {
  const { fake, clock } = engine(on)
  let unblock = (): void => undefined
  fake.intentGate = new Promise<void>(resolve => {
    unblock = resolve
  })
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  // The run is waiting on its intent call: no child exists yet.
  expect(fake.spawned.length).toBe(0)
  await $.prompt.submit(composer(DRAFT))
  unblock()
  await clock.settle()
  expect(fake.spawned.length).toBe(0)
  expect(fake.status).toEqual([])
})

test('The submitted prompt passes through untouched: same text, no added context, same origin; other origins pass', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  await $.prompt.submit(composer(`${DRAFT}\n`))
  expect(fake.submitted[0]?.e).toEqual(composer(`${DRAFT}\n`))
  expect(fake.submitted[0]?.e).not.toHaveProperty('context')
  const peer = { text: 'a peer wrote this', wait: false, origin: { kind: 'peer' as const } }
  await $.prompt.submit(peer)
  expect(fake.submitted[1]?.e).toEqual(peer)
})

test('Enter resets the per-prompt run count; at most one run per composed prompt', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  expect(MAX_AUTO_RUNS).toBe(1)
  for (const tail of ['one', 'two', 'three', 'four']) {
    await type($, fake, `${DRAFT} ${tail}`)
    await clock.advance(SETTLE_MS)
  }
  expect(fake.spawned.length).toBe(1)
  expect(fake.spawned.map(s => JSON.parse(s.input).speculate.n)).toEqual([1])
  await $.prompt.submit(composer(`${DRAFT} four`))
  await type($, fake, `${DRAFT} five`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)
  expect(JSON.parse(fake.spawned[1]?.input ?? '{}').speculate.n).toBe(1)
})

test('A run past its kill time is killed', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.hold = true
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  await clock.advance(RANK_TIMEOUT_MS - 1)
  expect(fake.killed).toBe(0)
  await clock.advance(1)
  expect(fake.killed).toBe(1)
  expect(fake.status).toEqual([])
})

test('An enforcer that cannot speculate turns the mod inert for the session', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.stdout = JSON.stringify({ hookSpecificOutput: { additionalContext: 'old enforcer' } })
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(1)
  expect(fake.status).toEqual([])
  await type($, fake, `${DRAFT} more words here`)
  await clock.advance(SETTLE_MS * 2)
  expect(fake.spawned.length).toBe(1)
  expect(fake.status).toEqual([])
})

test('A session.end (a /clear) drops the line and the run, and ranking works again under the new session', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.status).toEqual([MENU_STATUS])
  await $.session.end({ reason: 'clear', sessionId: 'sess-42', resume: { id: 'sess-42' } })
  expect(fake.status).toEqual([MENU_STATUS, undefined])
  // The /clear does not end the composed prompt: its one run is spent, so nothing is ranked until a send.
  await type($, fake, `${DRAFT} after the clear`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(1)
  await $.prompt.submit(composer(`${DRAFT} after the clear`))
  await type($, fake, `${DRAFT} after the send`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)
  expect(JSON.parse(fake.spawned[1]?.input ?? '{}').prompt).toBe(`${DRAFT} after the send`)
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
})

test('The boundary parser and the status line', () => {
  expect(parseSpeculation(RANKED)).toEqual({ kind: 'menu', skills: ['ui-styling', 'frontend-design', 'ak-test'], wholeShelf: true })
  expect(parseSpeculation(`some log line\n${RANKED}\n`)).toEqual({ kind: 'menu', skills: ['ui-styling', 'frontend-design', 'ak-test'], wholeShelf: true })
  // Only a ranked ticket makes the hook's menu the one on the line; any other state is a preview.
  for (const ticket of ['unranked', 'ranking', 'none', undefined]) {
    const out = JSON.stringify({ skillConciergeSpeculation: { v: 1, ticket, preview: { kind: 'menu', skills: ['a', 'b'], whole_shelf: true } } })
    const preview = parseSpeculation(out)
    expect(preview).toEqual({ kind: 'menu', skills: ['a', 'b'], wholeShelf: false })
    expect(preview === null || preview === 'incompatible' ? undefined : statusFor(preview)).toBe('concierge ▸ a · b (preview)')
  }
  expect(parseSpeculation('{}')).toBe('incompatible')
  expect(parseSpeculation('{"skillConciergeSpeculation":{"v":2,"preview":{"kind":"silent"}}}')).toBe('incompatible')
  expect(parseSpeculation('not json')).toBeNull()
  expect(parseSpeculation('')).toBeNull()
  expect(parseSpeculation('{"skillConciergeSpeculation":{"v":1,"preview":{"kind":"menu"}}}')).toBeNull()
  expect(parseSpeculation('{"skillConciergeSpeculation":{"v":1,"preview":{"kind":"no-skill"}}}')).toEqual({ kind: 'no-skill' })
  expect(statusFor({ kind: 'menu', skills: ['a', 'b'], wholeShelf: false })).toBe('concierge ▸ a · b (preview)')
  expect(statusFor({ kind: 'menu', skills: ['a', 'b'], wholeShelf: true })).toBe('concierge ▸ a · b')
  expect(statusFor({ kind: 'menu', skills: [], wholeShelf: true })).toBeUndefined()
  // The live line from Thinh's session: every name keeps both ends, the middle gives way.
  const live = statusFor({
    kind: 'menu',
    skills: ['verify-as-claimed', 'agent-skills:using-agent-skills', 'skill-concierge:keep-on', 'skill-concierge:skill-search', 'skill-concierge:flywheel'],
    wholeShelf: true,
  })
  expect(live).toBe('concierge ▸ verify…aimed · agent-…kills · skill-…ep-on · skill-…earch · skill-…wheel')
  // Short names that fit are never cut.
  expect(statusFor({ kind: 'menu', skills: ['ui-styling', 'ak-test'], wholeShelf: true })).toBe('concierge ▸ ui-styling · ak-test')
  // The cut keeps the first and last characters of every name.
  expect(middleCut('skill-concierge:skill-search', 9)).toBe('skil…arch')
  expect(middleCut('abc', 9)).toBe('abc')
  // Too many long names for even the shortest cap: the last ones are counted.
  expect(
    statusFor({ kind: 'menu', skills: Array.from({ length: 9 }, (_, i) => `skill-number-${i}-long-name`), wholeShelf: false }),
  ).toMatch(/^concierge ▸ (skill…name · ){4,}skill…name \+\d \(preview\)$/)
  expect(statusFor({ kind: 'no-skill' })).toBe('concierge ▸ no skill needed')
  expect(statusFor({ kind: 'consult' })).toBe('concierge ▸ consult')
  expect(statusFor({ kind: 'silent' })).toBeUndefined()
})

test('The highest installed version wins, and a missing file falls through to the next', () => {
  expect(compareVersions('0.67.0', '0.9.1')).toBeGreaterThan(0)
  expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
  const registry = JSON.stringify({
    plugins: {
      'skill-concierge@skill-concierge': [
        { scope: 'user', installPath: '/c/0.9.1', version: '0.9.1' },
        { scope: 'project', installPath: '/c/0.67.0/', version: '0.67.0' },
        { scope: 'local', installPath: '/c/0.10.0' },
      ],
      'other@market': [{ scope: 'user', installPath: '/o/9.9.9', version: '9.9.9' }],
    },
  })
  expect(installedEnforcers(registry)).toEqual([
    '/c/0.67.0/hooks/scripts/enforcer.py',
    '/c/0.10.0/hooks/scripts/enforcer.py',
    '/c/0.9.1/hooks/scripts/enforcer.py',
  ])
  expect(installedEnforcers('not json')).toEqual([])
  expect(installedEnforcers('{"plugins":[]}')).toEqual([])
})

test('SKILL_CONCIERGE_ROOT wins over the registry; the highest registry version runs otherwise', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.registry = {
    plugins: {
      'skill-concierge@skill-concierge': [
        { scope: 'user', installPath: '/c/0.66.0', version: '0.66.0' },
        { scope: 'user', installPath: INSTALL, version: '0.67.0' },
      ],
    },
  }
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned[0]?.argv).toEqual(['python3', ENFORCER])
  fake.env.SKILL_CONCIERGE_ROOT = '/dev/skill-concierge/'
  fake.files.add('/dev/skill-concierge/hooks/scripts/enforcer.py')
  await start($)
  await type($, fake, `${DRAFT} second`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned[1]?.argv).toEqual(['python3', '/dev/skill-concierge/hooks/scripts/enforcer.py'])
})

test('Without an installed skill-concierge the mod does nothing', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.registry = null
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS * 2)
  expect(fake.spawned.length).toBe(0)
  expect(fake.status).toEqual([])
})

test('With the enabled option off the mod registers nothing', { options: { enabled: false } }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS * 2)
  expect(fake.spawned.length).toBe(0)
  expect(fake.status).toEqual([])
})

// ── Coexistence: an inline peer band plugin that composes with nobody ─────────────────────────────
// Modeled on the disabled prompt-enhancer v0.1.3: it draws its own AbovePrompt tree without calling
// next(e), binds hotkey `e`, and appends context on prompt.submit.
const PEER = {
  name: 'peer-band',
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box>
          <Button key="peer-enhance" label="Enhance" hotkey="e" onPress={() => {}} />
        </Box>
      )
    })
    on('prompt.submit', ($, e, next) => next({ ...e, context: [...(e.context ?? []), 'PEER-CONTEXT'] }))
  },
}

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

test('Beside a peer band mod both work: its band, hotkey and context survive, our status still shows', { plugins: [PEER] }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'peer-band', surface, component: 'AbovePrompt', props: BAND })
    const button = await band.find({ key: 'peer-enhance' })
    expect(button?.props.hotkey).toBe('e')
    expect(button?.text).toBe('Enhance')
    await band.unmount()
  }
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  await $.prompt.submit(composer(DRAFT))
  expect((fake.submitted[0]?.e as { context?: unknown }).context).toEqual(['PEER-CONTEXT'])
  expect(fake.killed).toBe(0)
})

// ── The per-prompt cost cap holds across notification turns ───────────────────────────────────────

test('One unchanged draft across several notification turns starts at most one run', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  for (let i = 0; i < 6; i++) {
    // A task notification or a monitor event: a main-loop turn starts and ends while the draft waits.
    await $.turn.start({ text: `<task-notification>${i}</task-notification>`, turnId: `n${i}` })
    await $.turn.complete({ answer: 'noted', durationMs: 5, isAborted: false, turnId: `n${i}`, reason: 'answer' })
    await clock.advance(SETTLE_MS)
  }
  expect(fake.spawned.length).toBe(MAX_AUTO_RUNS)
  expect(MAX_AUTO_RUNS).toBe(1)
  expect(fake.spawned.map(s => JSON.parse(s.input).speculate.n)).toEqual([1])
  // Sending ends the composed prompt: the next one gets its own run.
  await $.prompt.submit(composer(DRAFT))
  await type($, fake, `${DRAFT} next prompt`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(MAX_AUTO_RUNS + 1)
  expect(JSON.parse(fake.spawned[MAX_AUTO_RUNS]?.input ?? '{}').speculate.n).toBe(1)
})

test('An emptied box does not buy more runs for the next draft either; only a send does', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  for (const tail of ['one', 'two', 'three']) {
    await type($, fake, `${DRAFT} ${tail}`)
    await clock.advance(SETTLE_MS)
  }
  await type($, fake, '')
  await type($, fake, `${DRAFT} four`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(MAX_AUTO_RUNS)
})

// ── The mod follows the skill-concierge the session runs, and stops when it is disabled ───────────

const ENABLED_KEY = 'skill-concierge@skill-concierge'

test('A skill-concierge disabled in any settings source leaves the mod inert', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.settings = { user: { enabledPlugins: { [ENABLED_KEY]: true } }, project: { enabledPlugins: { [ENABLED_KEY]: false } } }
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS * 2)
  expect(fake.spawned.length).toBe(0)
  expect(fake.status).toEqual([])
})

test('The later settings source wins: disabled in user but enabled in local runs the mod', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.settings = { user: { enabledPlugins: { [ENABLED_KEY]: false } }, local: { enabledPlugins: { [ENABLED_KEY]: true } } }
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(1)
})

test('A disabled install is skipped for an enabled one; an id absent from the settings counts as enabled', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.registry = {
    plugins: {
      'skill-concierge@old-market': [{ scope: 'user', installPath: '/c/9.0.0', version: '9.0.0' }],
      [ENABLED_KEY]: [{ scope: 'user', installPath: INSTALL, version: '0.67.0' }],
    },
  }
  fake.files.add('/c/9.0.0/hooks/scripts/enforcer.py')
  fake.settings = { user: { enabledPlugins: { 'skill-concierge@old-market': false } } }
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned[0]?.argv).toEqual(['python3', ENFORCER])   // the higher 9.0.0 is disabled, the enabled one runs
})

test('Every skill-concierge id disabled beats SKILL_CONCIERGE_ROOT; with the id enabled, the checkout runs', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.env.SKILL_CONCIERGE_ROOT = '/dev/skill-concierge'
  fake.files.add('/dev/skill-concierge/hooks/scripts/enforcer.py')
  fake.settings = { user: { enabledPlugins: { [ENABLED_KEY]: false } } }
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS * 2)
  expect(fake.spawned.length).toBe(0)   // the owner's "off" wins over an environment variable
  fake.settings = { user: { enabledPlugins: { [ENABLED_KEY]: true } } }
  await start($)
  await type($, fake, `${DRAFT} again`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned[0]?.argv).toEqual(['python3', '/dev/skill-concierge/hooks/scripts/enforcer.py'])
})

test('After a reload with no session.start, the first draft starts the mod; later drafts reuse it', async ($, on) => {
  const { fake, clock } = engine(on)
  await type($, fake, DRAFT)            // no start($): a module reloaded mid-session never sees session.start
  await clock.advance(SETTLE_MS)
  expect(fake.spawned[0]?.argv).toEqual(['python3', ENFORCER])
  // One Speculator, not one per keystroke: a fresh one per draft would have a fresh run count and rank again.
  await type($, fake, `${DRAFT} and more`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(1)
  await $.prompt.submit(composer(`${DRAFT} and more`))
  await type($, fake, `${DRAFT} and more still`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)
  expect(JSON.parse(fake.spawned[1]?.input ?? '{}').speculate.n).toBe(1)
})

test('A /clear does not reset the run count: one composed prompt gets one run however often it is cleared', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  for (let i = 0; i < 6; i++) {
    await type($, fake, `${DRAFT} take ${i}`)
    await clock.advance(SETTLE_MS)
    await $.session.end({ reason: 'clear', sessionId: 'sess-42', resume: { id: 'sess-42' } })
  }
  expect(fake.spawned.length).toBe(1)
})

test('A project-scope install runs only inside its own project tree', () => {
  const registry = JSON.stringify({
    plugins: {
      [ENABLED_KEY]: [
        { scope: 'user', installPath: '/c/0.60.0', version: '0.60.0' },
        { scope: 'project', projectPath: '/work/other', installPath: '/c/0.67.0', version: '0.67.0' },
        { scope: 'local', projectPath: '/work/app', installPath: '/c/0.66.0', version: '0.66.0' },
      ],
    },
  })
  expect(installedEnforcers(registry, { cwd: '/work/app/src' })).toEqual([
    '/c/0.66.0/hooks/scripts/enforcer.py',
    '/c/0.60.0/hooks/scripts/enforcer.py',
  ])
  expect(installedEnforcers(registry, { cwd: '/work/application' })).toEqual(['/c/0.60.0/hooks/scripts/enforcer.py'])
  expect(installedEnforcers(registry, { off: new Set([ENABLED_KEY]), cwd: '/work/app' })).toEqual([])
  expect(enabledPluginsOf({ enabledPlugins: { a: false } })).toEqual({ a: false })
  expect(enabledPluginsOf({ enabledPlugins: ['x'] })).toEqual({})
  expect(enabledPluginsOf(undefined)).toEqual({})
})

// ── The menu the model got: read from the ledger after each send ──────────────────────────────────

// Rows that must never be picked: another session, another text, a non-offer event, a torn line.
const NOISE = [
  offerRow({ sid: 'sess-other', offered: [['wrong-sid', 0.9]] }),
  offerRow({ q: 'some other prompt entirely', offered: [['wrong-text', 0.9]] }),
  JSON.stringify({ ev: 'search', sid: 'sess-42', q: DRAFT, offered: [['wrong-ev', 0.9]] }),
  '{"ev":"offer","sid":"sess-42"',
]
// An older row for this prompt, then the one the hook wrote last (mixed [name, score] and bare-name shapes).
const OLD_ROW = offerRow({ band: 'offer', offered: [['stale-skill', 0.5]] })
const NEW_ROW = offerRow({ band: 'offer', offered: [['ui-styling', 0.91], 'frontend-design'] })

test('After a send the status line shows the menu the model got, read from the ledger tail', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.ledger = [OLD_ROW, NEW_ROW, ...NOISE].join('\n') + '\n'
  await start($)
  await $.prompt.submit(composer(DRAFT))
  await clock.settle()
  expect(fake.tails).toEqual([['tail', '-n', '400', LEDGER]])
  expect(fake.spawned.length).toBe(0)
  expect(fake.status).toEqual([SENT_STATUS])
})

test('A send with no matching offer row shows no line', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.ledger = NOISE.join('\n') + '\n'
  await start($)
  await $.prompt.submit(composer(DRAFT))
  await clock.settle()
  expect(fake.tails.length).toBe(1)
  expect(fake.status).toEqual([])
})

test('A skip band with no rows shows "no skill needed" on the line', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.ledger = [...NOISE, offerRow({ band: 'jev_skip', offered: [] })].join('\n') + '\n'
  await start($)
  await $.prompt.submit(composer(DRAFT))
  await clock.settle()
  expect(fake.status).toEqual(['concierge ✓ no skill needed'])
})

test('Typing after the send clears the sent line', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.ledger = NEW_ROW
  await start($)
  await $.prompt.submit(composer(DRAFT))
  await clock.settle()
  expect(fake.status).toEqual([SENT_STATUS])
  await type($, fake, 'n')
  expect(fake.status).toEqual([SENT_STATUS, undefined])
})

test('A turn starting keeps the sent line while the box is empty', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.ledger = NEW_ROW
  await start($)
  await $.prompt.submit(composer(DRAFT))
  await clock.settle()
  await $.turn.start({ text: DRAFT, turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(WATCH_MS * 3)
  expect(fake.status).toEqual([SENT_STATUS])
})

test('The ledger tail read never blocks the send', async ($, on) => {
  const { fake, clock } = engine(on)
  let release = (): void => undefined
  fake.tailGate = new Promise<void>(resolve => {
    release = resolve
  })
  fake.ledger = NEW_ROW
  await start($)
  await $.prompt.submit(composer(DRAFT))
  // The hooks beneath ran and the send resolved while the tail child is still parked.
  expect(fake.submitted.length).toBe(1)
  expect(fake.tailsAnswered).toBe(0)
  expect(fake.status).toEqual([])
  release()
  await clock.settle()
  expect(fake.tailsAnswered).toBe(1)
  expect(fake.status).toEqual([SENT_STATUS])
})

test('findOffer picks the last offer row for the session and the text cut to 120 chars; sentStatus words each case', () => {
  const long = 'x'.repeat(130)
  const rows = [
    JSON.stringify({ ev: 'offer', sid: 's1', q: 'hello there', band: 'offer', offered: [['first', 1]] }),
    JSON.stringify({ ev: 'offer', sid: 's1', q: 'hello there', band: 'offer', offered: [['second', 1]] }),
    JSON.stringify({ ev: 'offer', sid: 's2', q: 'hello there', band: 'offer', offered: [['other-sid', 1]] }),
    JSON.stringify({ ev: 'offer', sid: 's1', q: 'x'.repeat(120), band: 'getaway', offered: [] }),
    'not json',
  ].join('\n')
  expect(findOffer(rows, 's1', 'hello there')).toEqual({ ev: 'offer', sid: 's1', q: 'hello there', band: 'offer', offered: [['second', 1]] })
  expect(findOffer(rows, 's1', long)).toEqual({ ev: 'offer', sid: 's1', q: 'x'.repeat(120), band: 'getaway', offered: [] })
  expect(findOffer(rows, 's3', 'hello there')).toBeNull()
  expect(findOffer(rows, 's1', 'hello')).toBeNull()
  expect(findOffer('', 's1', 'hello there')).toBeNull()

  expect(sentStatus(null)).toBeUndefined()
  expect(sentStatus({ band: 'offer', offered: [['ui-styling', 0.9], 'frontend-design', ['', 0.1]] })).toBe('concierge ✓ ui-styling · frontend-design')
  // Rows win over a skip band; the same middle cut as the preview line.
  expect(sentStatus({ band: 'jev_skip', offered: ['a', 'b'] })).toBe('concierge ✓ a · b')
  expect(
    sentStatus({ offered: ['verify-as-claimed', 'agent-skills:using-agent-skills', 'skill-concierge:keep-on', 'skill-concierge:skill-search', 'skill-concierge:flywheel'] }),
  ).toBe('concierge ✓ verify…aimed · agent-…kills · skill-…ep-on · skill-…earch · skill-…wheel')
  for (const band of ['jev_skip', 'getaway', 'intent_skip']) {
    expect(sentStatus({ band, offered: [] })).toBe('concierge ✓ no skill needed')
  }
  expect(sentStatus({ band: 'jev_skip' })).toBe('concierge ✓ no skill needed')
  expect(sentStatus({ band: 'consult_route', offered: [] })).toBe('concierge ✓ consult')
  expect(sentStatus({ band: 'harness_skip', offered: [] })).toBeUndefined()
  expect(sentStatus({ band: 'offer', offered: 'ui-styling' })).toBeUndefined()
  expect(sentStatus({})).toBeUndefined()
})

// ── The pause before ranking is the pauseSeconds option ───────────────────────────────────────────

test('pauseSeconds 3.5 ranks after exactly 3500 ms and not before', { options: { pauseSeconds: 3.5 } }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(3499)
  expect(fake.spawned.length).toBe(0)
  await clock.advance(1)
  expect(fake.spawned.length).toBe(1)
})

for (const pauseSeconds of [0.1, 99]) {
  test(`pauseSeconds ${pauseSeconds} is out of range and falls back to 2000 ms`, { options: { pauseSeconds } }, async ($, on) => {
    const { fake, clock } = engine(on)
    await start($)
    await type($, fake, DRAFT)
    await clock.advance(1999)
    expect(fake.spawned.length).toBe(0)
    await clock.advance(1)
    expect(fake.spawned.length).toBe(1)
  })
}

test('pauseSeconds unset ranks after 2000 ms', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(1999)
  expect(fake.spawned.length).toBe(0)
  await clock.advance(1)
  expect(fake.spawned.length).toBe(1)
})

// ── The band above the prompt ─────────────────────────────────────────────────────────────────────
// Mounted through the kit as the engine draws AbovePrompt: every plugin's ui.render hook, then the
// engine's own tree (an `engine` node) beneath them.

type Band = Awaited<ReturnType<typeof mountBand>>
const mountBand = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', props: RenderPropsOf['AbovePrompt'] = BAND) =>
  $.ui.mount({ plugin: 'concierge-enhancer', surface, component: 'AbovePrompt', props })
const keysOf = async (ui: Band) => (await ui.findAll({ type: 'Button' })).map(b => b.key)
const isDrawn = async (ui: Band) => (await ui.find({ key: 'rank' })) !== undefined
const hasEngine = async (ui: Band) => JSON.stringify(await ui.drawn()).includes('"type":"engine"')
const D2 = `${DRAFT} too`
const D3 = `${DRAFT} three`
const spokenN = (fake: Fake) => fake.spawned.map(s => JSON.parse(s.input).speculate.n)

test('The band is drawn while the box holds a draft or a menu shows, and passes the engine drawing otherwise', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($)
  // Nothing in the box, no menu: the chain's next(e) comes back untouched.
  expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
  // A draft: the rank row.
  await type($, fake, DRAFT)
  expect(await keysOf(ui)).toEqual(['rank'])
  // The ranked menu: one more row with an insert key per skill.
  await clock.advance(SETTLE_MS)
  expect(await keysOf(ui)).toEqual(['rank', 'insert-1', 'insert-2', 'insert-3'])
  expect(await hasEngine(ui)).toBe(true)
  // Editing clears the menu; an emptied box takes the whole band away.
  await type($, fake, `${DRAFT} x`)
  expect(await keysOf(ui)).toEqual(['rank'])
  await type($, fake, '')
  expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
  // A slash command is not a draft.
  await type($, fake, '/help me with this please')
  expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
  await ui.unmount()
})

test('The band shows one rank row and at most one menu row, and respects maxRows', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  const rows = async (ui: Band) => {
    const tree = (await ui.drawn()) as { children?: { type: string }[] }
    return (tree.children ?? []).filter(c => c.type === 'Box').length
  }
  const full = await mountBand($)
  expect(await rows(full)).toBe(2)
  const one = await mountBand($, 'terminal', { ...BAND, maxRows: 1 })
  expect(await keysOf(one)).toEqual(['rank'])
  expect(await rows(one)).toBe(1)
  const none = await mountBand($, 'terminal', { ...BAND, maxRows: 0 })
  expect(await none.drawn()).toEqual({ type: 'engine', ref: 0 })
  await full.unmount()
  await one.unmount()
  await none.unmount()
})

test('The rank button names the engine action, the r hotkey, and shows the chord on the terminal only', async ($, on) => {
  const { fake } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    const rank = await ui.find({ key: 'rank' })
    expect(rank?.props.action).toBe('app:cycleDiffBase')
    expect(rank?.props.hotkey).toBe('r')
    expect(rank?.text).toBe('Rank now')
    expect((await ui.find({ type: 'Text', text: /ctrl\+x b rank now/ })) !== undefined).toBe(surface === 'terminal')
    await ui.unmount()
  }
})

test('The hint shows the chord from the person\'s keybindings.json, and none when they unbound the built-in one', async ($, on) => {
  const { fake } = engine(on)
  fake.keybindings = JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'Cmd+Shift+R': 'app:cycleDiffBase' } }] })
  await start($)
  await type($, fake, DRAFT)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /cmd\+shift\+r rank now/ })).toBeDefined()
  await ui.unmount()
})

test('rankChordFrom: own chord first, built-in unless remapped, never throws', () => {
  expect(rankChordFrom(null)).toBe('ctrl+x b')
  expect(rankChordFrom('not json')).toBe('ctrl+x b')
  expect(rankChordFrom('{"bindings":[{"context":"Chat","bindings":{"cmd+e":"abovePrompt:focus"}}]}')).toBe('ctrl+x b')
  expect(rankChordFrom('{"bindings":[{"context":"Global","bindings":{"alt+r":"app:cycleDiffBase"}}]}')).toBe('alt+r')
  expect(rankChordFrom('{"bindings":[{"context":"DiffPanel","bindings":{"ctrl+y":"app:cycleDiffBase"}}]}')).toBe('ctrl+y')
  expect(rankChordFrom('{"bindings":[{"context":"DiffPanel","bindings":{"ctrl+x b":null}}]}')).toBe(null)
  expect(rankChordFrom('{"bindings":[{"context":"DiffPanel","bindings":{"ctrl+x b":"app:cycleDiffBase"}}]}')).toBe('ctrl+x b')
  expect(rankChordFrom('{"bindings":5}')).toBe('ctrl+x b')
})

test('Rank now ranks the current draft at once, no pause, and shows the menu on the band and the line', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  const ui = await mountBand($)
  await ui.press({ key: 'rank' })
  await clock.settle()
  expect(fake.spawned.length).toBe(1)
  expect(JSON.parse(fake.spawned[0]?.input ?? '{}')).toEqual({
    prompt: DRAFT,
    session_id: 'sess-42',
    cwd: '/work/app',
    speculate: { intent: '', n: 1 },
  })
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  expect(await keysOf(ui)).toEqual(['rank', 'insert-1', 'insert-2', 'insert-3'])
  // The pause it replaced never fires a second run for the same draft.
  await clock.advance(SETTLE_MS * 3)
  expect(fake.spawned.length).toBe(1)
  await ui.unmount()
})

test('Rank now shows a draft already ranked again and spends no run', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  const ui = await mountBand($)
  await ui.press({ key: 'rank' })
  await clock.settle()
  expect(fake.spawned.length).toBe(1)
  expect(await keysOf(ui)).toContain('insert-1')
  await ui.unmount()
})

test('Rank now says why it ranked nothing: a short draft, a running turn', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($)
  await type($, fake, 'fix it')
  await ui.press({ key: 'rank' })
  await clock.settle()
  expect(fake.spawned.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Type a draft of 4 words or more/ })).toBeDefined()
  await type($, fake, DRAFT)
  expect(await ui.find({ type: 'Text', text: /Type a draft/ })).toBeUndefined()
  await $.turn.start({ text: 'go', turnId: 't1' })
  await ui.press({ key: 'rank' })
  await clock.settle()
  expect(fake.spawned.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /A turn is running/ })).toBeDefined()
  await ui.unmount()
})

test('At most two runs per composed prompt, the automatic one at most one; only a send resets the count', async ($, on) => {
  const { fake, clock } = engine(on)
  expect(MAX_RUNS_PER_PROMPT).toBe(2)
  expect(MAX_AUTO_RUNS).toBe(1)
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)                 // automatic run: 1 of 2
  await type($, fake, D2)
  await ui.press({ key: 'rank' })                // manual run: 2 of 2
  await clock.settle()
  expect(spokenN(fake)).toEqual([1, 2])
  await type($, fake, D3)
  await ui.press({ key: 'rank' })                // past the cap: nothing is ranked, the band says so
  await clock.settle()
  expect(fake.spawned.length).toBe(2)
  expect(await ui.find({ type: 'Text', text: /Ranking limit reached for this prompt \(2\)/ })).toBeDefined()
  // Neither emptying the box, nor a /clear, nor a model turn buys another run.
  await type($, fake, '')
  await $.session.end({ reason: 'clear', sessionId: 'sess-42', resume: { id: 'sess-42' } })
  await type($, fake, D3)
  await clock.advance(SETTLE_MS)
  await ui.press({ key: 'rank' })
  await clock.settle()
  expect(fake.spawned.length).toBe(2)
  // A composer send does.
  await $.prompt.submit(composer(D3))
  await clock.settle()
  await type($, fake, DRAFT)
  await ui.press({ key: 'rank' })
  await clock.settle()
  expect(spokenN(fake)).toEqual([1, 2, 1])
  await ui.unmount()
})

test('Pressing Rank now first leaves the automatic run the second slot, and no more than that', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await ui.press({ key: 'rank' })                // manual: 1 of 2
  await clock.settle()
  await type($, fake, D2)
  await clock.advance(SETTLE_MS)                 // automatic: 2 of 2
  expect(spokenN(fake)).toEqual([1, 2])
  await type($, fake, D3)
  await clock.advance(SETTLE_MS * 2)             // nothing left
  expect(fake.spawned.length).toBe(2)
  await ui.unmount()
})

test('With the autoRank option off a settled draft is not ranked; only Rank now ranks', { options: { autoRank: false } }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS * 3)
  expect(fake.spawned.length).toBe(0)
  expect(fake.status).toEqual([])
  expect(await isDrawn(ui)).toBe(true)
  await ui.press({ key: 'rank' })
  await clock.settle()
  expect(fake.spawned.length).toBe(1)
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  // A turn ending does not wake the automatic path either.
  await type($, fake, D2)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(SETTLE_MS * 3)
  expect(fake.spawned.length).toBe(1)
  await ui.unmount()
})

test('An insert key puts the skill\'s exact name into the box at the cursor, spaced from the word before it, and keeps the menu', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  const ui = await mountBand($)
  await ui.press({ key: 'insert-2' })
  await clock.settle()
  expect(fake.fills).toEqual([{ text: ' frontend-design ', mode: 'insert' }])   // the draft ends in a word
  expect(fake.box).toBe(`${DRAFT} frontend-design `)
  // The menu is still there for the next skill, the line still describes it, and no new run starts.
  expect(await keysOf(ui)).toEqual(['rank', 'insert-1', 'insert-2', 'insert-3'])
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  await ui.press({ key: 'insert-1' })
  await clock.settle()
  expect(fake.fills.at(-1)).toEqual({ text: 'ui-styling ', mode: 'insert' })   // after a space: none added
  await clock.advance(SETTLE_MS * 3)
  expect(fake.spawned.length).toBe(1)
  expect(await keysOf(ui)).toContain('insert-3')
  // The engine echoing the fill as an edit changes nothing either.
  await type($, fake, fake.box)
  await clock.advance(SETTLE_MS * 3)
  expect(fake.spawned.length).toBe(1)
  expect(await keysOf(ui)).toContain('insert-3')
  // Typing something else clears the menu as always.
  await type($, fake, `${fake.box}and more`)
  expect(await keysOf(ui)).toEqual(['rank'])
  await ui.unmount()
})

test('An insert that raises the box\'s own edit event keeps the menu and starts no ranking', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  fake.fillEcho = () => type($, fake, fake.box)
  await type($, fake, DRAFT)
  const ui = await mountBand($)
  await ui.press({ key: 'rank' })                // manual run first: the automatic one is still unspent
  await clock.settle()
  expect(fake.spawned.length).toBe(1)
  await ui.press({ key: 'insert-3' })
  await clock.settle()
  expect(fake.box).toBe(`${DRAFT} ak-test `)
  expect(await keysOf(ui)).toEqual(['rank', 'insert-1', 'insert-2', 'insert-3'])
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  await clock.advance(SETTLE_MS * 3)
  expect(fake.spawned.length).toBe(1)
  expect(await keysOf(ui)).toContain('insert-1')
  await ui.unmount()
})

test('An insert the box refuses says so on the band and changes nothing else', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  fake.fillRefused = true
  const ui = await mountBand($)
  await ui.press({ key: 'insert-1' })
  await clock.settle()
  expect(fake.box).toBe(DRAFT)
  expect(await ui.find({ type: 'Text', text: /did not take the text/ })).toBeDefined()
  expect(await keysOf(ui)).toContain('insert-1')
  await ui.unmount()
})

test('Digit keys exist only over a draft: the menu after a send, shown over an empty box, binds none', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.ledger = [NEW_ROW].join('\n') + '\n'
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  // ▸ over a draft: the box is not empty, so a digit typed there is text; the keys 1..3 press when the band is focused.
  const hotkeys = async () => (await ui.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('insert-')).map(b => b.props.hotkey)
  expect(await hotkeys()).toEqual(['1', '2', '3'])
  // Send: the ✓ menu shows over an empty box, where a bare digit would be taken by a band button.
  await $.prompt.submit(composer(DRAFT))
  fake.box = ''
  await clock.settle()
  expect(fake.status.at(-1)).toBe(SENT_STATUS)
  expect(await keysOf(ui)).toEqual(['rank', 'insert-1', 'insert-2'])
  expect(await hotkeys()).toEqual([undefined, undefined])
  // The ✓ keys still insert, by pointer or focus.
  await ui.press({ key: 'insert-1' })
  await clock.settle()
  expect(fake.fills.at(-1)).toEqual({ text: 'ui-styling ', mode: 'insert' })
  await ui.unmount()
})

test('A digit typed at the start of the next prompt is the prompt\'s: the ✓ band goes with the first character', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.ledger = NEW_ROW + '\n'
  await start($)
  const ui = await mountBand($)
  await $.prompt.submit(composer(DRAFT))
  fake.box = ''
  await clock.settle()
  const digitKeys = async () => (await ui.findAll({ type: 'Button' })).filter(b => /^\d$/.test(String(b.props.hotkey ?? '')))
  expect(await digitKeys()).toEqual([])
  expect(await keysOf(ui)).toEqual(['rank', 'insert-1', 'insert-2'])
  await type($, fake, '1')
  // The ✓ menu is gone with the first character; what is left is the rank row, which has no digit key.
  expect(await keysOf(ui)).toEqual(['rank'])
  expect(await digitKeys()).toEqual([])
  await ui.unmount()
})

test('An empty ▸ menu or a lane with no skills draws text and no insert keys', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.stdout = JSON.stringify({ skillConciergeSpeculation: { v: 1, ticket: 'ranked', preview: { kind: 'no-skill' } } })
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(await keysOf(ui)).toEqual(['rank'])
  expect(await ui.find({ type: 'Text', text: /no skill needed/ })).toBeDefined()
  await ui.unmount()
})

test('A survey holds the band: the mod yields, and the status line still shows the menu', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($, 'terminal', { ...BAND, hasSurvey: true })
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  await ui.unmount()
})

test('The status line is the same with the band mounted or not', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  const without = [...fake.status]
  const ui = await mountBand($)
  await $.prompt.submit(composer(DRAFT))
  expect(without).toEqual([MENU_STATUS])
  expect(fake.status).toEqual([MENU_STATUS, undefined])
  await ui.unmount()
})

// ── Composition with other plugins' bands ─────────────────────────────────────────────────────────
// A plugin in the `prepend` tier is outside the mod (it calls the mod through next), one in `append`
// is inside it (the mod calls it through next).

const composingPeer = (tier: 'prepend' | 'append') => ({
  name: 'peer-compose',
  tier,
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const below = await next(e)
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Button key="peer-row" label="Peer" hotkey="p" onPress={() => {}} />
          {below}
        </Box>
      )
    })
  },
})
const stubbornPeer = (tier: 'prepend' | 'append') => ({ ...PEER, tier })

test('Peer outside, composing: both rows and the engine drawing show', { plugins: [composingPeer('prepend')] }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(await keysOf(ui)).toEqual(['peer-row', 'rank', 'insert-1', 'insert-2', 'insert-3'])
  expect(await hasEngine(ui)).toBe(true)
  // And with nothing in the box the mod passes the peer's drawing through untouched.
  await type($, fake, '')
  expect(await keysOf(ui)).toEqual(['peer-row'])
  expect(await hasEngine(ui)).toBe(true)
  await ui.unmount()
})

test('Peer inside, composing: both rows and the engine drawing show', { plugins: [composingPeer('append')] }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(await keysOf(ui)).toEqual(['rank', 'insert-1', 'insert-2', 'insert-3', 'peer-row'])
  expect(await hasEngine(ui)).toBe(true)
  await type($, fake, '')
  expect(await keysOf(ui)).toEqual(['peer-row'])
  await ui.unmount()
})

test('Peer inside that does not compose: the mod, outside it, still shows its rows above the peer\'s', { plugins: [stubbornPeer('append')] }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(await keysOf(ui)).toEqual(['rank', 'insert-1', 'insert-2', 'insert-3', 'peer-enhance'])
  await ui.unmount()
})

test('Peer outside that does not compose draws alone, and the status line carries the menu', { plugins: [stubbornPeer('prepend')] }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(await keysOf(ui)).toEqual(['peer-enhance'])
  expect(fake.status.at(-1)).toBe(MENU_STATUS)
  await ui.unmount()
})

test('Both bands survive a survey: a composing peer outside and the mod inside yield to it', { plugins: [composingPeer('prepend')] }, async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  const ui = await mountBand($, 'terminal', { ...BAND, hasSurvey: true })
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  expect(await keysOf(ui)).toEqual(['peer-row'])
  await ui.unmount()
})

// ── Fitting names to the band ─────────────────────────────────────────────────────────────────────

const LONG = ['superpowers:systematic-debugging-and-root-cause-analysis', 'frontend-design', 'plugin-dev:agent-development-guide']

const labelsOf = (r: ReturnType<typeof bandRows>) => r.rows.flat().map(slot => slot.label)

test('bandRows keeps whole names where they fit, cuts the middle where they do not, and counts what it leaves out', () => {
  expect(bandRows(['a-skill', 'b-skill'], 80, 3, 1)).toEqual({ rows: [[{ label: 'a-skill', index: 0 }, { label: 'b-skill', index: 1 }]], more: 0 })
  expect(labelsOf(bandRows(LONG, Infinity, 3, 1))).toEqual(LONG)
  const cut = bandRows(LONG, 50, 3, 1)
  expect(cut.rows.length).toBe(1)
  expect(labelsOf(cut).every(l => l.length <= 14)).toBe(true)
  expect(labelsOf(cut)[0]?.startsWith('superp')).toBe(true)
  expect(labelsOf(cut)[0]?.endsWith('lysis')).toBe(true)
  const tiny = bandRows(LONG, 24, 3, 1)
  expect(tiny.more).toBeGreaterThan(0)
  expect(labelsOf(tiny).length + tiny.more).toBe(3)
  // Never more than five insert keys.
  expect(labelsOf(bandRows(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 200, 3, 1))).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(bandRows(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 200, 3, 1).more).toBe(2)
})

test('A second row lets the five names of Thinh\'s live menu show whole on a 100-column band', () => {
  const live = ['ccgui-plugin-creator', 'tui-fundamentals', 'superpowers-developing-for-claude-code:working-with-claude-code', 'pstack:principle-guard-the-context-window', 'ak-context-engineering']
  const one = bandRows(live, 100, 3, 1)
  expect(labelsOf(one).some(l => l.includes('…'))).toBe(true)   // one row: names are cut
  const two = bandRows(live, 100, 3, 2)
  expect(two.rows.length).toBe(2)
  expect(two.more).toBe(0)
  // The indices still point at the full names, in menu order.
  expect(two.rows.flat().map(slot => slot.index)).toEqual([0, 1, 2, 3, 4])
  expect(labelsOf(two).filter(l => l.includes('…')).length).toBeLessThan(labelsOf(one).filter(l => l.includes('…')).length)
})

test('The status line budget follows the terminal width and falls back to 76 before any drawing', () => {
  expect(statusBudget(0)).toBe(76)
  expect(statusBudget(200)).toBe(200 - 36)
  expect(statusBudget(60)).toBe(40)   // never below 40
  const names = ['ccgui-plugin-creator', 'tui-fundamentals', 'superpowers-developing-for-claude-code:working-with-claude-code', 'pstack:principle-guard-the-context-window', 'ak-context-engineering']
  // 200 columns: only the one name too long for the shared cap loses its middle; the other four stay whole.
  expect(statusFor({ kind: 'menu', skills: names, wholeShelf: true }, statusBudget(200))).toBe(
    'concierge ▸ ccgui-plugin-creator · tui-fundamentals · superpowers-developing-for…e:working-with-claude-code · pstack:principle-guard-the-context-window · ak-context-engineering',
  )
  // The fixed 76 cuts every name, as Thinh saw.
  expect(statusFor({ kind: 'menu', skills: names, wholeShelf: true })).toMatch(/^concierge ▸ ccgui-…eator · /)
})

test('On the terminal a long name is cut on the button and inserted whole; a desktop button shows it whole', async ($, on) => {
  const { fake, clock } = engine(on)
  fake.stdout = JSON.stringify({
    skillConciergeSpeculation: { v: 1, ticket: 'ranked', preview: { kind: 'menu', skills: LONG, whole_shelf: true } },
  })
  await start($)
  await type($, fake, DRAFT)
  await clock.advance(SETTLE_MS)
  const narrow = await mountBand($, 'terminal', { ...BAND, bodyColumns: 50 })
  expect((await narrow.find({ key: 'insert-1' }))?.text).toContain('…')
  await narrow.press({ key: 'insert-1' })
  await clock.settle()
  expect(fake.fills.at(-1)).toEqual({ text: ` ${LONG[0]} `, mode: 'insert' })
  const wide = await mountBand($, 'desktop')
  expect((await wide.find({ key: 'insert-1' }))?.text).toBe(LONG[0])
  await narrow.unmount()
  await wide.unmount()
})

test('menuFor and sentMenu mirror statusFor and sentStatus: a menu exactly where a line shows', () => {
  expect(menuFor({ kind: 'menu', skills: ['a', 'b'], wholeShelf: true })).toEqual({ mark: '▸', kind: 'skills', skills: ['a', 'b'] })
  expect(menuFor({ kind: 'menu', skills: [], wholeShelf: true })).toBeNull()
  expect(menuFor({ kind: 'no-skill' })).toEqual({ mark: '▸', kind: 'text', text: 'no skill needed' })
  expect(menuFor({ kind: 'consult' })).toEqual({ mark: '▸', kind: 'text', text: 'consult' })
  expect(menuFor({ kind: 'silent' })).toBeNull()
  expect(sentMenu(null)).toBeNull()
  expect(sentMenu({ band: 'offer', offered: [['ui-styling', 0.9], 'frontend-design'] })).toEqual({
    mark: '✓',
    kind: 'skills',
    skills: ['ui-styling', 'frontend-design'],
  })
  expect(sentMenu({ band: 'jev_skip' })).toEqual({ mark: '✓', kind: 'text', text: 'no skill needed' })
  expect(sentMenu({ band: 'consult_route' })).toEqual({ mark: '✓', kind: 'text', text: 'consult' })
  expect(sentMenu({ band: 'fallback' })).toBeNull()
})
