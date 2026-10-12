// Sketch: the concierge-enhancer mod, wiring only. No band, no button, no hotkey, no rewrite.
// The mod pre-ranks the draft while the author types and hands the result to the enforcer
// at submit. The enforcer decides whether to serve it. Pure logic lives in ./handoff.ts.
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { EnforcerOutput, Precomputed } from '../types'
import { SETTLE_MS, handoffFor, intentFrom, intentRequest, parseEnforcerOutput, settled, statusLine } from './handoff'

// One slot. Only the latest settled draft can be submitted, so a map would hold entries that
// can never be served. Module state: a hot reload resets it to idle, which falls back to the
// enforcer's normal path. Nothing else writes it.
let seq = 0 // bumped on every keystroke that changes the draft
let lastText = '' // the draft the last keystroke left; a cursor-only event keeps it
let timer: Timer | null = null // the one settle timer, cancelled on every change
let ready: Precomputed | null = null
let expiry: Timer | null = null // drops `ready` (and the status line) at expiresAt
let running = false // single-flight: one precompute at a time per session
let queued: { draft: string; mine: number } | null = null // the newest draft that arrived mid-run

// Stage 1 (route = null) and stage 2 (route = draft + intent) of the enforcer's precompute mode.
// stdin: { prompt, session_id, precompute: true, route? }. Env: ENFORCER_LEDGER=defer, so no
// ledger row is written. JEVD_URL is passed through when set (it is not a secret; jevd holds the keys).
// Returns null when the process fails, times out, or prints nothing parseable.
async function enforce($: EngineInterface, draft: string, route: string | null): Promise<EnforcerOutput | null> {
  // TODO: resolve the script with enforcerPath($) (SKILL_CONCIERGE_ROOT, else installed_plugins.json);
  //       $.process.run(['python3', script], { stdin, env, timeoutMs: 20_000 }); parseEnforcerOutput(stdout)
  throw new Error('not implemented')
}

// The one-line intent: the last assistant text (from $.session.messages()) plus the draft, through
// $.model.complete on the session's own client (Max). Fail open: '' means rank the draft alone.
async function intentFor($: EngineInterface, draft: string): Promise<string> {
  // TODO: last assistant message text, cut to 1500 chars; $.model.complete({ model: 'haiku',
  //       system: intentSystem, prompt: intentRequest(draft, last), maxTokens: 300, timeoutMs: 15_000 });
  //       intentFrom(reply.text) when reply.isAnswered, else ''
  throw new Error('not implemented')
}

// Runs for one settled draft. Publishes `ready` only while `mine` is still the latest keystroke.
async function precompute($: EngineInterface, draft: string, mine: number): Promise<void> {
  // TODO: if (running) { queued = { draft, mine }; return } ; running = true
  // TODO: out = await enforce($, draft, null)                       // stage 1: lanes only
  // TODO: if mine !== seq -> return
  // TODO: if out?.needs_route: intent = await intentFor(...); route = intent ? `${draft}\n\n${intent}` : draft;
  //         out = await enforce($, draft, route)                    // stage 2: full ranking
  //       else if out?.hookSpecificOutput: route = ''                // lanes already decided
  //       else: return                                               // nothing to serve (short, slash)
  // TODO: if mine !== seq -> return ; ready = { prompt: draft, route, out, expiresAt: now + out.ttl_s }
  // TODO: $.ui.status(statusLine(out) ?? undefined); arm expiry = $.clock.after(ttl_s * 1000, drop)
  // TODO: finally running = false; if queued and queued.mine === seq -> precompute(queued) (no await)
  // Every failure is swallowed: no menu is the normal path, never a blocked prompt.
  throw new Error('not implemented')
}

// Runs on the composer's Enter. Writes the hint for the enforcer (the draft's menu and route),
// clears the slot and the status line, then lets the prompt through.
async function handOff($: EngineInterface): Promise<void> {
  // TODO: const now = await $.clock.now() / 1000 ; const hand = handoffFor(ready, await $.env.get('HOME'), await $.session.id(), now)
  // TODO: ready = null; $.ui.status(undefined); if (hand) await $.fs.write(hand.path, hand.body)
  // A failed write costs the menu only; the enforcer ranks the sent text as today.
  throw new Error('not implemented')
}

export const register: Register = on => {
  // Typing. The engine does not wait on this hook (probed), so the hook answers at once through next(e).
  on('prompt.autocomplete', async ($, e, next) => {
    // TODO: if (e.text === lastText) return next(e)           // cursor-only event
    // TODO: lastText = e.text; seq += 1; timer?.cancel(); ready = null; expiry?.cancel()
    // TODO: $.ui.status(undefined)
    // TODO: if (settled(e.text)) { const mine = seq; timer = $.clock.after(SETTLE_MS, () => void precompute($, e.text, mine)) }
    return next(e) // composes: other plugins' suggestions pass through unchanged
  })

  // Enter. Only the composer's own submission carries a menu; a queued or plugin-sent prompt does not.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') await handOff($)
    return next(e) // a failing hook is skipped by the engine; the prompt still goes out
  })
}
