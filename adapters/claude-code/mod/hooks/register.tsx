import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Menu, Pending } from '../types'

const isBusy = atom({ plugin: 'concierge-enhancer', key: 'isBusy' } as const, false)
const note = atom({ plugin: 'concierge-enhancer', key: 'note' } as const, null)
const menu = atom({ plugin: 'concierge-enhancer', key: 'menu' } as const, null)
const pending = atom({ plugin: 'concierge-enhancer', key: 'pending' } as const, null)
const focusKey = atom({ plugin: 'concierge-enhancer', key: 'focusKey' } as const, 'ctrl+x tab')

const FALLBACK_MODEL = 'sonnet'
const PREVIEW_SESSION = 'concierge-enhancer-preview'

// The rules a blind A/B chose (plans/261012-0935-prompt-enhancer-ab/report.md): no skill names,
// no questions back to the author, and the author's own terms copied verbatim into <intent>.
const RULES = `Goal: rewrite the rough prompt below into a clear, complete prompt that an autonomous coding agent acts on in this project from start to finish.

Success means the rewrite:
1. Keeps the author's intent, scope and language, with requirements drawn only from what they asked for or clearly implied.
2. States the kind of work and its domain: what is built, fixed, reviewed, researched or written, and the tools, file types, services and artifacts involved.
3. Describes the finished result: the deliverable and how to tell it is done.
4. Fits this project, using only the paths and facts its folder, files, conventions and the conversation show.
5. Leaves skill choice to the agent's skill router: it names the work, and leaves skills, plugins, agents and slash commands unnamed.

Output, in this order:
- <intent></intent>: one or two plain sentences naming only the work and its domain. Copy the author's own names verbatim: tools, files, procedures, people, and any coined or misspelled term ("chisle" stays "chisle").
- <prompt></prompt>: the rewritten prompt, in the author's voice, as the message they will send, in short sections or bullets.

Stop after </prompt>.`

const tag = (reply: string, name: string) => reply.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? ''

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

// The installed skill-concierge's enforcer, the same script its UserPromptSubmit hook runs.
// SKILL_CONCIERGE_ROOT (a checkout) wins, so a development tree can be driven live.
async function enforcerPath($: EngineInterface): Promise<string | null> {
  const root = await $.env.get('SKILL_CONCIERGE_ROOT')
  if (root) return `${root}/hooks/scripts/enforcer.py`
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await home($)}/.claude`
  try {
    const installed = JSON.parse(String(await $.fs.read(`${config}/plugins/installed_plugins.json`)))
    for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
      const path = (entries as { installPath?: string }[])[0]?.installPath
      if (id.startsWith('skill-concierge@') && path) return `${path}/hooks/scripts/enforcer.py`
    }
  } catch {
    // No plugin registry: concierge is not installed, so there is no menu to show.
  }
  return null
}

// Ranks text exactly as concierge's hook does, with the ledger off: a preview is not an offer.
export async function rankMenu($: EngineInterface, text: string): Promise<Menu> {
  const script = await enforcerPath($)
  if (!script) return { skills: [], note: 'skill-concierge is not installed' }
  let context = ''
  try {
    const run = await $.process.run(['python3', script], {
      stdin: JSON.stringify({ prompt: text, session_id: PREVIEW_SESSION }),
      env: { ENFORCER_LEDGER: '0' },
      timeoutMs: 20_000,
    })
    const out = run.stdout.trim().split('\n').pop() ?? ''
    context = out ? (JSON.parse(out).hookSpecificOutput?.additionalContext ?? '') : ''
  } catch {
    // The rewrite already landed; a ranking that fails or times out only costs the preview.
    return { skills: [], note: 'concierge returned no menu' }
  }
  // The main menu is the first run of bullet rows; the annexes after it are not the offer.
  const skills: string[] = []
  for (const line of context.split('\n').map(l => l.trim())) {
    if (line.startsWith('• ')) {
      const name = line.slice(2).split(/\s+/)[0]
      if (name) skills.push(name)
    } else if (skills.length) {
      break
    }
  }
  if (skills.length) return { skills, note: null }
  if (context.includes('SKILL-CHECK:')) return { skills: [], note: 'concierge: no skill needed for this one' }
  return { skills: [], note: 'concierge has no preview for this draft' }
}

async function rewrite($: EngineInterface, draft: string): Promise<{ prompt: string; intent: string }> {
  const ask = `${RULES}\n\n<rough_prompt>\n${draft}\n</rough_prompt>`
  let reply: string
  const forked = await $.model.fork({ prompt: ask })
  if (forked.isAnswered) {
    reply = forked.text
  } else {
    if (forked.reason !== 'nothing-to-fork') throw new Error(`model call failed: ${forked.reason}`)
    // A fresh session has no conversation to fork: ask with the project folder as the only context.
    const done = await $.model.complete({
      model: FALLBACK_MODEL,
      system: `Project folder: ${await $.session.cwd()}`,
      prompt: ask,
      maxTokens: 4000,
      timeoutMs: 120_000,
    })
    if (!done.isAnswered) throw new Error(`model call failed: ${done.reason}`)
    reply = done.text
  }
  const prompt = tag(reply, 'prompt')
  if (!prompt) throw new Error('the rewrite came back without a <prompt> block')
  return { prompt, intent: tag(reply, 'intent') }
}

export async function enhance($: EngineInterface) {
  if (await read($, isBusy)) return
  const draft = (await $.prompt.read()).text
  if (!draft.trim()) {
    $.ui.toast('Type a prompt first')
    return
  }
  await update($, isBusy, () => true)
  await update($, note, () => null)
  await update($, menu, () => null)
  try {
    const { prompt, intent } = await rewrite($, draft)
    // The person may have kept typing; their newer draft wins over the rewrite.
    if ((await $.prompt.read()).text !== draft) {
      await update($, note, () => 'Draft changed while enhancing; rewrite discarded')
      return
    }
    const filled = await $.prompt.fill({ text: prompt })
    if (!filled.isFilled) throw new Error(`prompt box refused (${filled.refusal ?? 'unknown'})`)
    // Concierge ranks the author's own words plus the intent line, never the full rewrite.
    const route = intent ? `${draft}\n\n${intent}` : draft
    await update($, pending, () => ({ rewrite: prompt, route }) satisfies Pending)
    await update($, menu, () => ({ skills: [], note: 'ranking skills…' }))
    const ranked = await rankMenu($, route)
    // Sent while ranking: the prompt is gone, so its preview is too.
    if ((await read($, pending))?.rewrite === prompt) await update($, menu, () => ranked)
  } catch (err) {
    await update($, note, () => `Enhance failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, isBusy, () => false)
  }
}

// The route hint for a sent prompt: only when it is the pending rewrite, unedited. Pure, so it is
// testable without a session; leaveRouteHint does the reading and the writing.
export function routeHintFor(waiting: Pending | null, text: string, nowMs: number): { prompt: string; route: string; t: number } | null {
  if (!waiting || text.trim() !== waiting.rewrite.trim()) return null
  return { prompt: text, route: waiting.route, t: nowMs / 1000 }
}

// When the enhanced prompt is sent unedited, leave concierge a one-shot route hint, so the
// model's menu is ranked on the same text the band previewed (hooks/scripts/enforcer.py _route_hint).
// Any send consumes the pending rewrite; an edited prompt is ranked as sent.
async function leaveRouteHint($: EngineInterface, text: string) {
  const waiting = await read($, pending)
  if (!waiting) return
  await update($, pending, () => null)
  await update($, menu, () => null)
  const hint = routeHintFor(waiting, text, await $.clock.now())
  if (!hint) return
  await $.fs.write(`${await home($)}/.claude/skill-concierge/route-hints/${await $.session.id()}.json`, JSON.stringify(hint))
}

// The chord bound to Claude Code's abovePrompt:focus in the Chat context; null when unbound.
async function readFocusKey($: EngineInterface): Promise<string | null> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await home($)}/.claude`
  const chat: Record<string, string | null> = {}
  try {
    const file = JSON.parse(String(await $.fs.read(`${config}/keybindings.json`)))
    for (const block of file.bindings ?? []) {
      if (block.context === 'Chat') Object.assign(chat, block.bindings ?? {})
    }
  } catch {
    // No readable keybindings.json: Claude Code's defaults apply.
  }
  const own = Object.keys(chat).find(chord => chat[chord] === 'abovePrompt:focus')
  if (own) return own.toLowerCase()
  return 'ctrl+x tab' in chat ? null : 'ctrl+x tab'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const chord = await readFocusKey($)
    await update($, focusKey, () => chord)
    return next(e)
  })

  // Enter in the prompt box is the only send: peers, notifications and plugins never consume the rewrite.
  // A hook that fails is skipped and the prompt still goes out: the hint is never a gate.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') await leaveRouteHint($, e.text)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = await read($, isBusy)
    const message = await read($, note)
    const shown = await read($, menu)
    const chord = await read($, focusKey)
    const keys = [chord, 'e enhance', 'esc back'].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>Concierge </Text>
          {busy ? (
            <Text dimColor>Enhancing…</Text>
          ) : (
            <Box>
              {/* Not awaited: a rewrite plus a ranking can outlast the 10s ui.press budget; isBusy guards re-entry. */}
              <Button key="enhance" label="Enhance" hotkey="e" variant="primary" onPress={() => void enhance($)} />
              {e.surface === 'terminal' ? <Text dimColor>  {keys}</Text> : null}
            </Box>
          )}
          {message ? <Text dimColor> {message}</Text> : null}
        </Box>
        {shown ? (
          <Text dimColor>
            {shown.skills.length ? `Skill preview: ${shown.skills.join(' · ')}` : shown.note}
          </Text>
        ) : null}
      </Box>
    )
  })
}
