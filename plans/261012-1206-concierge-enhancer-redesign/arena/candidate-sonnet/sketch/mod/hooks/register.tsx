// concierge-enhancer 0.2.0 (sketch; bodies not implemented).
//
// The mod draws nothing and binds no key. It watches the prompt box, and when a draft settles it asks
// skill-concierge's own enforcer to rank it ahead of the turn (`enforcer.py --prerank`), with an intent
// line from the session's own model as one extra input. The enforcer stores the ranking; the hook that
// runs when the prompt is sent claims it. The model reads one menu, ranked once, by the enforcer.
//
// Hooks registered: session.start (read the kill switch), prompt.autocomplete (observe, pass through) and
// prompt.submit (clear, pass through). All three call next(e) with the event unchanged.
// Not registered: ui.render, command.register, prompt.edit, prompt.fill, hotkeys, classic.*.
// Anything else a peer mod does with those surfaces is therefore untouched by construction.

import type { EngineInterface, Register } from 'claude-code'

import {
  cleanIntent, createScheduler, INTENT_SYSTEM, INTENT_TIMEOUT_MS, intentPrompt, parseReadout, PRERANK_TIMEOUT_MS,
} from './prerank'
import type { Ports, Scheduler } from './prerank'

/** CONCIERGE_ENHANCER=0 in the environment turns the mod into a no-op (revert path of this release). */
async function isEnabled($: EngineInterface): Promise<boolean> {
  throw new Error('not implemented')
}

/** CONCIERGE_INTENT=0 skips the intent call and ranks the bare draft (the control arm for an epoch). */
async function intentEnabled($: EngineInterface): Promise<boolean> {
  throw new Error('not implemented')
}

/**
 * The installed skill-concierge's enforcer.py. SKILL_CONCIERGE_ROOT (a checkout) wins; else the
 * `skill-concierge@*` entry of installed_plugins.json with the highest `version`, not the first
 * (the 0.67.0 mod took the first). null when concierge is not installed: the mod then does nothing.
 */
async function enforcerPath($: EngineInterface): Promise<string | null> {
  throw new Error('not implemented')
}

/** Tail (<= 600 chars) of the newest assistant message, for the intent call; null on a fresh session. */
async function lastAssistantTail($: EngineInterface): Promise<string | null> {
  throw new Error('not implemented')
}

function portsFor($: EngineInterface): Ports {
  return {
    after: (ms, fn) => $.clock.after(ms, fn),
    now: () => $.clock.now(),
    readDraft: async () => (await $.prompt.read()).text,
    status: line => $.ui.status(line),
    intent: async (draft, signal) => {
      // $.model.complete({ model: 'haiku', system: INTENT_SYSTEM, prompt: intentPrompt(draft, tail),
      //                    maxTokens: 120, effort: 'low', timeoutMs: INTENT_TIMEOUT_MS }, { signal })
      // -> cleanIntent(text) when isAnswered, else null.  Skipped (null) when !(await intentEnabled($)).
      throw new Error('not implemented')
    },
    prerank: async req => {
      // $.process.run(['python3', script, '--prerank'], { stdin: JSON.stringify({ prompt: req.prompt,
      //   intent: req.intent, session_id: req.sessionId, cwd: req.cwd }), timeoutMs: PRERANK_TIMEOUT_MS })
      // -> parseReadout(run.stdout).  A rejection, a non-zero exit or no script -> { status: 'failed', ... }.
      throw new Error('not implemented')
    },
  }
}

export const register: Register = on => {
  let enabled = true
  let scheduler: Scheduler | undefined
  const schedulerFor = ($: EngineInterface): Scheduler =>
    (scheduler ??= createScheduler(portsFor($), async () => ({
      sessionId: await $.session.id(),
      cwd: await $.session.cwd(),
    })))

  on('session.start', async ($, e, next) => {
    enabled = await isEnabled($)
    return next(e)
  })

  // Fires as the person types; the engine does not wait on it. Observe and pass through unchanged, so a
  // peer's typeahead rows survive and a peer above us that does not call next() merely switches us off.
  on('prompt.autocomplete', ($, e, next) => {
    if (enabled) schedulerFor($).onEdit(e.text)
    return next(e)
  })

  // The send clears the status line. Pure pass-through: no context added, no text rewritten, no wait of
  // our own (next(e) already waits for the command hooks, which is where the menu is built).
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind === 'composer') schedulerFor($).onSubmit()
    return next(e)
  })
}
