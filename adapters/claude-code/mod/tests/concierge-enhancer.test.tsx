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
  MAX_RUNS_PER_DRAFT,
  MIN_WORDS,
  RANK_TIMEOUT_MS,
  SETTLE_MS,
  WATCH_MS,
  compareVersions,
  enabledPluginsOf,
  installedEnforcers,
  parseSpeculation,
  rankable,
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
  on('fs.read', (_$, e) =>
    e.path === `${HOME}/.claude/plugins/installed_plugins.json` && fake.registry
      ? { value: JSON.stringify(fake.registry) }
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
  expect(SETTLE_MS).toBe(1000)
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
  fake.intent = { isAnswered: false, reason: 'aborted', usage: USAGE }
  await type($, fake, `${DRAFT} please`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)
  expect(JSON.parse(fake.spawned[1]?.input ?? '{}').speculate).toEqual({ intent: '', n: 2 })
})

test('The intent rules name no skills, keep the author terms verbatim and ask the author nothing', () => {
  expect(INTENT_RULES).toContain('Name no skills, plugins, agents or slash commands.')
  expect(INTENT_RULES).toContain('"chisle" stays "chisle"')
  expect(INTENT_RULES).toContain('in one plain sentence')
  expect(INTENT_RULES).not.toMatch(/\b(ask|asks|asking|questions?)\b/i)
})

test('Typing again before the settle time ranks nothing; typing after a run starts kills it and ranks the new draft', async ($, on) => {
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
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)
  expect(JSON.parse(fake.spawned[1]?.input ?? '{}').prompt).toBe(`${DRAFT} and a toggle in the header`)
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

test('Enter resets the per-prompt run count; at most three runs per composed prompt', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  expect(MAX_RUNS_PER_DRAFT).toBe(3)
  for (const tail of ['one', 'two', 'three', 'four']) {
    await type($, fake, `${DRAFT} ${tail}`)
    await clock.advance(SETTLE_MS)
  }
  expect(fake.spawned.length).toBe(3)
  expect(fake.spawned.map(s => JSON.parse(s.input).speculate.n)).toEqual([1, 2, 3])
  await $.prompt.submit(composer(`${DRAFT} four`))
  await type($, fake, `${DRAFT} five`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(4)
  expect(JSON.parse(fake.spawned[3]?.input ?? '{}').speculate.n).toBe(1)
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
  await type($, fake, `${DRAFT} after the clear`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)
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

test('One unchanged draft across several notification turns starts at most three runs', async ($, on) => {
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
  expect(fake.spawned.length).toBe(MAX_RUNS_PER_DRAFT)
  expect(fake.spawned.map(s => JSON.parse(s.input).speculate.n)).toEqual([1, 2, 3])
  // Sending ends the composed prompt: the next one gets its own three.
  await $.prompt.submit(composer(DRAFT))
  await type($, fake, `${DRAFT} next prompt`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(MAX_RUNS_PER_DRAFT + 1)
  expect(JSON.parse(fake.spawned[MAX_RUNS_PER_DRAFT]?.input ?? '{}').speculate.n).toBe(1)
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
  expect(fake.spawned.length).toBe(MAX_RUNS_PER_DRAFT)
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
  await type($, fake, `${DRAFT} and more`)
  await clock.advance(SETTLE_MS)
  expect(fake.spawned.length).toBe(2)   // one Speculator, not one per keystroke
})

test('A /clear does not reset the run count: one composed prompt gets three runs however often it is cleared', async ($, on) => {
  const { fake, clock } = engine(on)
  await start($)
  for (let i = 0; i < 6; i++) {
    await type($, fake, `${DRAFT} take ${i}`)
    await clock.advance(SETTLE_MS)
    await $.session.end({ reason: 'clear', sessionId: 'sess-42', resume: { id: 'sess-42' } })
  }
  expect(fake.spawned.length).toBe(3)
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
