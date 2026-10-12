// concierge-enhancer v0.2: the wiring. A thin shell; every decision lives in ./speculator.ts.
//
// The mod draws nothing and binds no key. It observes the draft, has skill-concierge rank it
// while the person types (the enforcer's own path, Jev through jevd included), shows the result
// on this plugin's own status line, and keeps the matching run alive across Enter so the
// UserPromptSubmit hook can serve that same ranking. Every hook passes its event on unchanged.
import type { Register } from 'claude-code'

import { Speculator, locateEnforcer } from './speculator'

// Runtime handles (a child process, a timer, an AbortController) cannot live in `$.state`, which
// holds plain data. A hot reload drops this value together with the timers it armed, which is the
// right end for both: the next session.start (or reload) builds a fresh one.
let speculator: Speculator | null = null

export const register: Register = on => {
  // Work that outlives a dispatch is started from session.start (reference.md, "Work that
  // outlives a dispatch"): the Speculator keeps this hook's `$` for the session's life.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    speculator?.end()
    const enforcer = await locateEnforcer($)
    // No concierge install, or one too old to speculate: the mod stays inert, concierge unchanged.
    speculator = enforcer ? new Speculator($, enforcer) : null
    return started
  })

  // The draft observer (probe P6: fires while typing, and the engine does not wait on it).
  // Observe only: other plugins' suggestions pass through untouched.
  on('prompt.autocomplete', ($, e, next) => {
    speculator?.note(e.text)
    return next(e)
  })

  // A running turn changes the context Jev reads (the last assistant text), so nothing is ranked
  // while one runs; the draft is ranked once it ends.
  on('turn.start', ($, e, next) => {
    speculator?.working(true)
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    speculator?.working(false)
    return next(e)
  })

  // Enter. `next(e)` runs the UserPromptSubmit command hooks (probe P5), concierge's enforcer
  // among them. The event passes on exactly as received: no text rewrite, no added context.
  // Only the person's own Enter is wrapped; notifications, peers and plugins pass straight through.
  on('prompt.submit', ($, e, next) =>
    e.origin.kind === 'composer' && speculator ? speculator.send(e.text, () => next(e)) : next(e))

  on('session.end', ($, e, next) => {
    speculator?.end()
    speculator = null
    return next(e)
  })
}
