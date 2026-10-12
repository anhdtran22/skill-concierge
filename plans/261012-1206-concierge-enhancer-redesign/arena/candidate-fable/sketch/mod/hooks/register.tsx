// concierge-enhancer v2 — the typing-time handoff. SKETCH: bodies are `throw new Error('not
// implemented')` or TODO pseudocode. Types and signatures are the contract.
//
// What this mod does, in one sentence: while the person types, it runs concierge's own Jev
// route (enforcer.py --prepare) on the draft, and at Enter it hands the finished verdict to the
// UserPromptSubmit hook, which renders it instead of routing again. The band and the prompt
// hint show that same verdict. No button, no hotkey, no rewrite of the prompt box.
//
// API facts this file stands on (grounding §4, all probed unless marked):
//   P6  prompt.autocomplete fires while typing with the whole draft; the engine does not wait on it.
//   P5  prompt.submit runs before the command hooks; a file written before next(e) is on disk
//       when enforcer.py runs; next(e) resolves when the hooks finish.
//   d.ts ProcessRunInit.env: "Variables set over the host process's own environment" (documented):
//       the prepare pass sees JEVD_URL and the ENFORCER_* flags the hook sees.
//   d.ts PromptHint.tail is additive on the terminal; AbovePrompt: "return it, wrap it" (documented).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Inflight, Prepared, PreparedView } from '../types'

// ── state: owned here, read by the two render hooks ──────────────────────────────────────────
const prepared = atom({ plugin: 'concierge-enhancer', key: 'prepared' } as const, null)
const inflight = atom({ plugin: 'concierge-enhancer', key: 'inflight' } as const, null)

// ── tunables (every number cites grounding §2 or enforcer.py) ────────────────────────────────
const MIN_WORDS = 4 // enforcer.py MAX_SHORT_WORDS (3) + 1: a shorter draft never ranks, so never prepare it
const QUIET_MS = 1200 // the draft must be still this long before a prepare starts
const WAIT_CAP_MS = 3750 // Jev full-stage p90 (ledger, Claude Code epoch since 2026-10-10): the most a submit waits
const PREPARE_TIMEOUT_MS = 12_000 // JEV_BUDGET_S 7.8 s + intent + Python start-up, then the child is killed
const INTENT_MODEL = 'haiku'
const INTENT_TIMEOUT_MS = 2500

// The intent line's rules, the part of the A/B's rewrite prompt that the ranking used
// (plans/261012-0935-prompt-enhancer-ab/report.md: raw + intent beat raw 13-7). Standing decisions:
// names no skill, keeps the author's terms verbatim, asks the author nothing.
const INTENT_RULES = `Write one or two plain sentences naming only the work in the rough prompt below and its domain: what is built, fixed, reviewed, researched or written, and the tools, file types, services and artifacts involved. Copy the author's own names verbatim: tools, files, procedures, people, and any coined or misspelled term ("chisle" stays "chisle"). Name no skill, plugin, agent or slash command. Ask the author nothing. Output <intent></intent> only.`

// ── the --prepare output, parsed at the process boundary ─────────────────────────────────────
// enforcer.py --prepare prints one JSON object: { handoff: {...}, view: PreparedView }.
// `handoff` is kept as a string; the mod reads its `prompt` to confirm it is for `text` and
// nothing else of it (per boundary-discipline: the hook owns that schema).
type PrepareOutput = { handoff: string; view: PreparedView }

/** Parse one --prepare stdout for the draft `text`; null when it is not a well-formed answer for that text. */
export function parsePrepareOutput(stdout: string, text: string): PrepareOutput | null {
  // TODO: last line that starts with '{' → JSON.parse → require object with `handoff` (object whose
  //       `prompt` === text) and `view` (discriminated by `kind`, every variant checked) → stringify handoff.
  throw new Error('not implemented')
}

/** Whether a draft is worth preparing: not a slash command, at least MIN_WORDS whitespace-separated words. Pure. */
export function eligible(text: string): boolean {
  // TODO: const t = text.trim(); return !t.startsWith('/') && t.split(/\s+/).filter(Boolean).length >= MIN_WORDS
  throw new Error('not implemented')
}

/**
 * What a submit of `text` does with the mod's state. Pure, so the race is testable without a session.
 *   ready  — a finished prepare for exactly this text: write its handoff now
 *   wait   — a prepare for exactly this text is in flight: wait for it, at most `capMs`
 *   none   — nothing for this text: the hook routes by itself, as with the mod absent
 */
export function settlement(p: Prepared | null, f: Inflight | null, text: string, nowMs: number):
  | { kind: 'ready'; handoff: string }
  | { kind: 'wait'; capMs: number }
  | { kind: 'none' } {
  // TODO: const t = text.trim()
  //       if (p && p.text.trim() === t) return { kind: 'ready', handoff: p.handoff }
  //       if (f && f.text.trim() === t) return { kind: 'wait', capMs: Math.max(0, WAIT_CAP_MS - (nowMs - f.startedMs)) }
  //       return { kind: 'none' }
  throw new Error('not implemented')
}

// ── module-level transient state (not drawn from, so not $.state; a hot reload drops it) ─────
let draft = '' // the box as autocomplete last reported it
let cancelQuiet: (() => void) | null = null // the pending quiet timer
let landing: Promise<void> | null = null // resolves when the in-flight prepare lands or fails

/** The installed skill-concierge's enforcer.py. SKILL_CONCIERGE_ROOT wins; else the newest installed copy (fixes D7). */
async function enforcerPath($: EngineInterface): Promise<string | null> {
  // TODO: as v0.67.0, but over every `skill-concierge@*` entry pick the highest `version`, not the first.
  throw new Error('not implemented')
}

/** The route-hints file for this session: the one channel into the hook (enforcer.py _handoff). */
async function handoffPath($: EngineInterface): Promise<string> {
  // TODO: `${HOME}/.claude/skill-concierge/route-hints/${await $.session.id()}.json`
  throw new Error('not implemented')
}

/** One or two sentences naming the work, or '' when the model fails or answers off-shape. Never throws. */
async function intentLine($: EngineInterface, text: string): Promise<string> {
  // TODO: $.model.complete({ model: INTENT_MODEL, prompt: `${INTENT_RULES}\n\n<rough_prompt>\n${text}\n</rough_prompt>`,
  //       maxTokens: 160, effort: 'low', timeoutMs: INTENT_TIMEOUT_MS }) → isAnswered ? tag(text,'intent') : ''
  //       A reply that names a skill cannot be checked here; the rules forbid it and the ledger's `rq` shows what was ranked.
  throw new Error('not implemented')
}

/**
 * Run concierge's own prepare pass on `text` and keep the result while the draft still equals `text`.
 * Invariants: at most one prepare in flight per session; a result for a draft the person has since
 * changed is discarded, never shown and never handed off; when it lands and the current draft is a
 * different eligible text that has been quiet, the next prepare starts from here (no timer needed).
 */
async function prepare($: EngineInterface, text: string): Promise<void> {
  // TODO:
  //   if (await read($, inflight)) return                       // one at a time; the landing chain picks up the newer draft
  //   const script = await enforcerPath($); if (!script) return
  //   await update($, inflight, () => ({ text, startedMs: Date.now() }))
  //   landing = (async () => {
  //     try {
  //       const intent = await intentLine($, text)             // '' on any failure: Jev then ranks the draft alone
  //       const route = intent ? `${text}\n\n${intent}` : undefined
  //       const run = await $.process.run(['python3', script, '--prepare'], {
  //         stdin: JSON.stringify({ prompt: text, route, session_id: await $.session.id() }),
  //         env: { ENFORCER_LEDGER: '0' },                      // a prepare is not an offer: no row
  //         timeoutMs: PREPARE_TIMEOUT_MS,
  //       })
  //       const out = parsePrepareOutput(run.stdout, text)
  //       if (out && draft === text) await update($, prepared, () => ({ text, ...out, at: Date.now() }))
  //     } catch { /* fail open: no preview, the hook routes at send */ }
  //     finally { await update($, inflight, () => null) }
  //   })()
  //   await landing
  //   if (draft !== text && eligible(draft)) void prepare($, draft)
  throw new Error('not implemented')
}

/** Called on every autocomplete tick. Cheap: compares, resets the quiet timer, invalidates a stale preview. */
async function observe($: EngineInterface, text: string): Promise<void> {
  // TODO:
  //   if (text === draft) return
  //   draft = text
  //   cancelQuiet?.(); cancelQuiet = null
  //   const shown = await read($, prepared)
  //   if (shown && shown.text !== text) await update($, prepared, () => null)   // the band never shows another draft's menu
  //   if (eligible(text)) cancelQuiet = $.clock.after(QUIET_MS, () => void prepare($, text))
  throw new Error('not implemented')
}

/**
 * At Enter: hand the hook the verdict for exactly this text, or nothing. Bounded: a prepare in flight
 * for this text is awaited for at most WAIT_CAP_MS minus its age, never longer than the hook's own Jev
 * would have taken at p90, so the person never waits longer than today. Any send spends the state.
 */
async function handOff($: EngineInterface, text: string, signal: AbortSignal): Promise<void> {
  // TODO:
  //   let s = settlement(await read($, prepared), await read($, inflight), text, Date.now())
  //   if (s.kind === 'wait' && landing) {
  //     await Promise.race([landing, $.clock.sleep(s.capMs, { signal })])
  //     s = settlement(await read($, prepared), null, text, Date.now())
  //   }
  //   if (s.kind === 'ready') await $.fs.write(await handoffPath($), s.handoff)   // enforcer.py checks mtime, not a `t`
  //   draft = ''; cancelQuiet?.(); await update($, prepared, () => null)         // one-shot: nothing outlives the send
  throw new Error('not implemented')
}

/** The dim tail for the prompt hint, or '' when there is nothing to say. Pure. */
export function tailText(p: Prepared | null, f: Inflight | null): string {
  // TODO: f → 'concierge: ranking…'; p?.view.kind === 'whole_shelf' → `concierge: ${rows.length} ranked (${stage})`;
  //       'jev_skip' → 'concierge: no skill fits'; 'named' → 'concierge: named skill'; else ''
  throw new Error('not implemented')
}

/** The band's one row: the ranked names with shares, in the hook's order. Pure. */
export function bandText(p: Prepared): string | null {
  // TODO: whole_shelf | named → `Concierge · ${header}: ` + rows.map(r => `${r.name}${r.badge} ${r.share}%`).join(' · '); else null
  throw new Error('not implemented')
}

export const register: Register = on => {
  // Typing: observe the draft; never answer for the typeahead.
  on('prompt.autocomplete', async ($, e, next) => {
    void observe($, e.text)
    return next(e)
  })

  // Enter in the composer only: peers, notifications and plugins never spend a prepare (and never
  // reach autocomplete, so nothing was prepared for them). The hook routes those as today.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') await handOff($, e.text, next.signal)
    return next(e)
  })

  // Prompt hint: append to the engine's line (terminal draws `tail`; a peer's tail stays ahead of ours).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const mine = tailText(await read($, prepared), await read($, inflight))
    if (!mine) return next(e)
    return next({ ...e, props: { ...e.props, tail: [e.props.tail, mine].filter(Boolean).join('  ') } })
  })

  // Band: one dim row under whatever the peers above drew; nothing when nothing is prepared.
  // No Button, no hotkey: nothing to focus, nothing to collide on. Composes with a peer that calls
  // next(e); under a peer that does not, this row is not drawn and the tail still reports.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const p = await read($, prepared)
    const row = p ? bandText(p) : null
    const beneath = await next(e)
    if (!row) return beneath
    const { Box, Text } = $.ui.resolve(e)
    // TODO: confirm with the test kit that the drawing `next(e)` resolves to is accepted as a child
    //       ("return it, wrap it, draw your own" — d.ts ui.render); if not, return `beneath` when it is
    //       non-empty and draw the row only when the band is otherwise empty.
    return (
      <Box flexDirection="column">
        {beneath}
        <Text dimColor wrap="truncate-end">{row}</Text>
      </Box>
    )
  })
}
