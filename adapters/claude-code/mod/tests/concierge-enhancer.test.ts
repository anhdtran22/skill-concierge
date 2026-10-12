import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, ModelForkResult, ModelUsage, On, RenderPropsOf } from 'claude-code'

import { routeHintFor } from '../hooks/register'

const PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
const USAGE = {} as ModelUsage
const SURFACES = ['terminal', 'desktop'] as const
const INSTALL = '/cache/skill-concierge/0.67.0'
const enforcerOutput = (lines: string[]) => JSON.stringify({ hookSpecificOutput: { additionalContext: lines.join('\n') } })
const MENU_OUTPUT = enforcerOutput([
  'SKILL-FIRST · reply line 1 = USING: <skill> | SEARCH: <query> | NO SKILL: <why>.',
  'Whole-shelf ranking for this task (every skill you can use judged):',
  '  • ui-styling ⭐ (61%) — Style interfaces…',
  '  • frontend-design (22%) — Design web pages…',
  '  • ak-test ❤️🔥 (17%) — Run tests…',
])

type Fake = {
  text: string
  asks: string[]
  fork: ModelForkResult
  complete: ModelCompleteResult
  ranked: { argv: readonly string[]; stdin: string; env: Record<string, string> }[]
  rankOutput: string
  rankFails: boolean
  installed: boolean
  keybindings: object | null
  writes: Record<string, string>
}

// Stands in for the prompt box, the model, concierge's enforcer and the disk beneath the plugin.
function engine(on: On): Fake {
  const fake: Fake = {
    text: '',
    asks: [],
    fork: { isAnswered: false, reason: 'nothing-to-fork' },
    complete: { isAnswered: false, reason: 'empty-reply', usage: USAGE },
    ranked: [],
    rankOutput: MENU_OUTPUT,
    rankFails: false,
    installed: true,
    keybindings: null,
    writes: {},
  }
  on('prompt.read', () => ({ value: { text: fake.text, cursor: fake.text.length } }))
  on('prompt.fill', (_$, e) => {
    fake.text = e.text
    return { isFilled: true }
  })
  on('model.fork', (_$, e) => {
    fake.asks.push(e.prompt)
    return { value: fake.fork }
  })
  on('model.complete', (_$, e) => {
    fake.asks.push(String(e.system))
    return { value: fake.complete }
  })
  on('process.run', (_$, e) => {
    fake.ranked.push({ argv: e.argv, stdin: e.init?.stdin ?? '', env: e.init?.env ?? {} })
    if (fake.rankFails) return { deny: 'spawn python3 ENOENT' }
    return { value: { exitCode: 0, stdout: fake.rankOutput, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', (_$, e) => {
    if (e.path === '/home/me/.claude/plugins/installed_plugins.json' && fake.installed) {
      return { value: JSON.stringify({ plugins: { 'skill-concierge@skill-concierge': [{ installPath: INSTALL }] } }) }
    }
    if (e.path === '/home/me/.claude/keybindings.json' && fake.keybindings) return { value: JSON.stringify(fake.keybindings) }
    return { deny: 'ENOENT' }
  })
  on('fs.write', (_$, e) => {
    fake.writes[e.path] = e.text
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 'sess-42' }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  return fake
}

function reset(fake: Fake, text: string) {
  Object.assign(fake, { text, asks: [], ranked: [], writes: {} })
}

const mount = ($: Engine, surface: (typeof SURFACES)[number], props = PROPS) =>
  $.ui.mount({ plugin: 'concierge-enhancer', surface, component: 'AbovePrompt', props })

const DRAFT = 'add dark mode w/ ui-kit'
const REWRITE = 'Add a dark mode toggle to the settings page.'
const REPLY = `<intent>Add a dark mode toggle to the settings page with ui-kit.</intent>\n<prompt>${REWRITE}</prompt>`
const ROUTE = `${DRAFT}\n\nAdd a dark mode toggle to the settings page with ui-kit.`

async function enhanced($: Engine, on: On) {
  const fake = engine(on)
  reset(fake, DRAFT)
  fake.fork = { isAnswered: true, text: REPLY, usage: USAGE }
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'enhance' })
  return { fake, ui }
}

test('Enhance puts the rewrite in the box and previews the skills concierge ranks for draft plus intent', async ($, on) => {
  const fake = engine(on)
  for (const surface of SURFACES) {
    reset(fake, DRAFT)
    fake.fork = { isAnswered: true, text: REPLY, usage: USAGE }
    const ui = await mount($, surface)
    await ui.press({ key: 'enhance' })
    expect(fake.text).toBe(REWRITE)
    expect(fake.asks[0]).toContain(`<rough_prompt>\n${DRAFT}\n</rough_prompt>`)
    const [call] = fake.ranked
    expect(call?.argv).toEqual(['python3', `${INSTALL}/hooks/scripts/enforcer.py`])
    expect(call?.env).toEqual({ ENFORCER_LEDGER: '0' })
    expect(JSON.parse(call?.stdin ?? '{}').prompt).toBe(ROUTE)
    expect(await ui.find({ type: 'Text', text: 'Skill preview: ui-styling · frontend-design · ak-test' })).toBeDefined()
    await ui.unmount()
  }
})

test('The preview shows only the main menu, not the annexes after it', async ($, on) => {
  const fake = engine(on)
  reset(fake, DRAFT)
  fake.rankOutput = enforcerOutput([
    'Whole-shelf ranking for this task (every skill you can use judged):',
    '  • ui-styling (80%) — Style interfaces…',
    '  • frontend-design (20%) — Design web pages…',
    'From other catalogs (get_skill to load):',
    '  • some-external-skill [external] — …',
  ])
  fake.fork = { isAnswered: true, text: REPLY, usage: USAGE }
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'enhance' })
  expect(await ui.find({ type: 'Text', text: 'Skill preview: ui-styling · frontend-design' })).toBeDefined()
  await ui.unmount()
})

test('The rewrite rules ask for no skill names and no questions back to the author', async ($, on) => {
  const { fake, ui } = await enhanced($, on)
  expect(fake.asks[0]).toContain('leaves skills, plugins, agents and slash commands unnamed')
  expect(fake.asks[0]).toContain('"chisle" stays "chisle"')
  expect(fake.asks[0]).not.toMatch(/ask the author/i)
  await ui.unmount()
})

test('Before the first turn the rewrite falls back to a plain completion with the project folder', async ($, on) => {
  const fake = engine(on)
  reset(fake, 'fix login')
  fake.complete = { isAnswered: true, text: '<intent>Fix login.</intent><prompt>Fix the login bug.</prompt>', usage: USAGE }
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'enhance' })
  expect(fake.text).toBe('Fix the login bug.')
  expect(fake.asks).toContain('Project folder: /work/app')
  await ui.unmount()
})

test('A failed model call leaves the draft alone and says why', async ($, on) => {
  const fake = engine(on)
  reset(fake, 'refactor auth')
  fake.fork = { isAnswered: false, reason: 'empty-reply', usage: USAGE }
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'enhance' })
  expect(fake.text).toBe('refactor auth')
  expect(fake.ranked).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Enhance failed: model call failed: empty-reply/ })).toBeDefined()
  await ui.unmount()
})

test('A reply with no <prompt> block leaves the draft alone', async ($, on) => {
  const fake = engine(on)
  reset(fake, 'refactor auth')
  fake.fork = { isAnswered: true, text: 'Sure, here is a better prompt.', usage: USAGE }
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'enhance' })
  expect(fake.text).toBe('refactor auth')
  expect(await ui.find({ type: 'Text', text: /without a <prompt> block/ })).toBeDefined()
  await ui.unmount()
})

test('Without skill-concierge installed the band says so instead of a preview', async ($, on) => {
  const fake = engine(on)
  reset(fake, DRAFT)
  fake.installed = false
  fake.fork = { isAnswered: true, text: REPLY, usage: USAGE }
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'enhance' })
  expect(fake.ranked).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'skill-concierge is not installed' })).toBeDefined()
  await ui.unmount()
})

test('A ranking that fails keeps the rewrite and only loses the preview', async ($, on) => {
  const fake = engine(on)
  reset(fake, DRAFT)
  fake.rankFails = true
  fake.fork = { isAnswered: true, text: REPLY, usage: USAGE }
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'enhance' })
  expect(fake.text).toBe(REWRITE)
  expect(await ui.find({ type: 'Text', text: 'concierge returned no menu' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Enhance failed/ })).toBeUndefined()
  await ui.unmount()
})

test('A concierge skip ruling shows as no skill needed', async ($, on) => {
  const fake = engine(on)
  reset(fake, 'thanks, that is all')
  fake.rankOutput = enforcerOutput(['SKILL-CHECK: conversational turn.'])
  fake.fork = { isAnswered: true, text: '<intent>Close.</intent><prompt>Thanks, that is all.</prompt>', usage: USAGE }
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'enhance' })
  expect(await ui.find({ type: 'Text', text: 'concierge: no skill needed for this one' })).toBeDefined()
  await ui.unmount()
})

test('Sending the rewrite unedited gets a one-shot route hint for that exact prompt', () => {
  const waiting = { rewrite: REWRITE, route: ROUTE }
  expect(routeHintFor(waiting, `${REWRITE}\n`, 1_800_000_000_000)).toEqual({ prompt: `${REWRITE}\n`, route: ROUTE, t: 1_800_000_000 })
})

test('An edited rewrite, or a send with no Enhance, gets no hint and is ranked as sent', () => {
  expect(routeHintFor({ rewrite: REWRITE, route: ROUTE }, `${REWRITE} Then deploy it to Vercel.`, 0)).toBeNull()
  expect(routeHintFor(null, 'ship it', 0)).toBeNull()
})

test('The band has Enhance only, and its key hint shows the chord bound to abovePrompt:focus on the terminal', async ($, on) => {
  const fake = engine(on)
  fake.keybindings = { bindings: [{ context: 'Chat', bindings: { 'cmd+e': 'abovePrompt:focus' } }] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  const terminal = await mount($, 'terminal', { ...PROPS, isWorking: true })
  expect(await terminal.find({ type: 'Text', text: /cmd\+e · e enhance · esc back/ })).toBeDefined()
  expect(await terminal.find({ key: 'enhance' })).toBeDefined()
  expect(await terminal.find({ key: 'send' })).toBeUndefined()
  await terminal.unmount()
  const desktop = await mount($, 'desktop')
  expect(await desktop.find({ type: 'Text', text: /e enhance/ })).toBeUndefined()
  await desktop.unmount()
})
