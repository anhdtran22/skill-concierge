// concierge-enhancer v0.2: the wiring. A thin shell; every decision lives in ./speculator.ts.
//
// The mod draws nothing and binds no key. It observes the draft, has skill-concierge rank it
// while the person types (the enforcer's own path, Jev through jevd included), shows the result
// on this plugin's own status line, and keeps the matching run alive across Enter so the
// UserPromptSubmit hook can serve that same ranking. Every hook passes its event on unchanged.
import type { Register } from 'claude-code'

import { Speculator, enabledPluginsOf, locateEnforcer } from './speculator'

// Runtime handles (a child process, a timer, an AbortController) cannot live in `$.state`, which
// holds plain data. A hot reload drops this value together with the timers it armed, which is the
// right end for both: the next session.start (or reload) builds a fresh one.
let speculator: Speculator | null = null

export const register: Register = (on, options) => {
  // The `enabled` option off: no hook is registered, so the mod does nothing and concierge ranks
  // each prompt at send time as it does without this mod. A change in the config menu reloads this.
  if (options.enabled === false) return
  // Off unless set: the intent gate did not beat the plain draft (see the `intent` option in plugin.json).
  const intent = options.intent === true

  // Work that outlives a dispatch is started from session.start (reference.md, "Work that
  // outlives a dispatch"): the Speculator keeps this hook's `$` for the session's life.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    speculator?.end()
    try {
      // `$` stays in this file: the validator follows it only into same-file functions, so the
      // Speculator gets closures that spell each `$.noun.event(...)` here.
      const enforcer = await locateEnforcer({
        rootEnv: () => $.env.get('SKILL_CONCIERGE_ROOT'),
        configEnv: () => $.env.get('CLAUDE_CONFIG_DIR'),
        homeEnv: () => $.env.get('HOME'),
        cwd: () => $.session.cwd(),
        // Every settings source in precedence order, so the later one wins per plugin id; a source that
        // cannot be read counts as holding nothing (an unreadable answer never switches the mod off).
        enabledPlugins: async () => {
          const merged: Record<string, unknown> = {}
          for (const source of ['user', 'project', 'local', 'flag', 'policy'] as const) {
            Object.assign(merged, enabledPluginsOf(await $.settings.read({ source }).catch(() => ({}))))
          }
          return merged
        },
        isFile: path =>
          $.fs.stat(path).then(
            stat => stat.kind === 'file',
            () => false,
          ),
        readText: path => $.fs.read(path),
      })
      // No concierge install, or skill-concierge disabled in settings: the mod stays inert and concierge is unchanged.
      speculator = enforcer
        ? new Speculator(
            {
              readPrompt: () => $.prompt.read(),
              sessionId: () => $.session.id(),
              cwd: () => $.session.cwd(),
              messages: () => $.session.messages(),
              complete: (request, init) => $.model.complete(request, init),
              spawn: request => $.process.spawn(request),
              after: (ms, fn) => $.clock.after(ms, fn),
              every: (ms, fn) => $.clock.every(ms, fn),
              status: text => $.ui.status(text),
            },
            enforcer,
            { intent },
          )
        : null
    } catch {
      speculator = null
    }
    return started
  })

  // The draft observer (probe P6: fires while typing, and the engine does not wait on it).
  // Observe only: other plugins' suggestions pass through untouched.
  on('prompt.autocomplete', ($, e, next) => {
    speculator?.note(e.text)
    return next(e)
  })

  // A running turn changes the context Jev reads (the last assistant text), so nothing is ranked
  // while one runs; the draft is ranked once it ends. A subagent's loop raises turn.complete too,
  // with `agentId` set and no turn.start of its own: only the main loop's end resumes ranking.
  on('turn.start', ($, e, next) => {
    speculator?.working(true)
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) speculator?.working(false)
    return next(e)
  })

  // Enter. `next(e)` runs the UserPromptSubmit command hooks (probe P5), concierge's enforcer
  // among them. The event passes on exactly as received: no text rewrite, no added context.
  // Only the person's own Enter is wrapped; notifications, peers and plugins pass straight through.
  // This site can refuse a prompt, so it carries a `.catch`: a failure here lets the prompt go on.
  on('prompt.submit', ($, e, next) =>
    e.origin.kind === 'composer' && speculator ? speculator.send(e.text, () => next(e)) : next(e),
  ).catch(($, e, next) => next(e))

  // `reason: 'clear'` raises session.end with no session.start after it, so the Speculator stays
  // usable: end() only drops its timers, runs and status, and the next run reads the new session id.
  on('session.end', ($, e, next) => {
    speculator?.end()
    return next(e)
  })
}
