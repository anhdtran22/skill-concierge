// Sketch: pure logic for the concierge-enhancer mod. No `$` calls here, so the unit tests
// import this file without an engine. register.tsx does the I/O and calls these functions.
import type { EnforcerOutput, Precomputed } from '../types'

// Idle time after the last keystroke before a draft is pre-ranked. A design parameter,
// not measured. Tune from the ledger (`via: "precomputed"` hit rate, `lead_ms`).
export const SETTLE_MS = 1500

// Invariant: true only for a draft worth a precompute: non-empty after trim, not a slash command.
// The word floor is NOT here. The enforcer's stage 1 prints no output for short drafts, so the
// mod never copies MAX_SHORT_WORDS.
export function settled(text: string): boolean {
  throw new Error('not implemented')
}

// Invariant: parses the LAST non-empty line of the enforcer's stdout. Returns null for anything
// that is not a JSON object. Never throws. Reads no menu rows out of additionalContext.
export function parseEnforcerOutput(stdout: string): EnforcerOutput | null {
  throw new Error('not implemented')
}

// One status line under the prompt, from structured offer fields only.
//   band 'offer'    -> `Concierge menu ready: ${names.join(' · ')}` (the offered names, in order)
//   band 'jev_skip' -> 'Concierge: no skill fits this draft'
//   anything else   -> null (no line)
export function statusLine(out: EnforcerOutput): string | null {
  throw new Error('not implemented')
}

// The request for the one-line intent. Standing rules, carried in the prompt itself:
// name only the work and its domain; copy the author's own names verbatim (tools, files,
// procedures, coined terms); name no skill, plugin, agent or slash command; ask no questions.
// `lastAssistant` is the last assistant text, cut to 1500 characters, or '' for a fresh session.
export function intentRequest(draft: string, lastAssistant: string): string {
  throw new Error('not implemented')
}

// The text between <intent> and </intent>, trimmed; '' when the tags are absent.
export function intentFrom(reply: string): string {
  throw new Error('not implemented')
}

// Invariant: the hint carries the DRAFT the menu was ranked for, not the sent text. The enforcer
// compares that text with the prompt it is about to rank (single owner of the freshness check).
// Returns null when nothing is ready. `expiresAt` is checked here only to skip a dead slot.
export function handoffFor(
  ready: Precomputed | null,
  home: string,
  sessionId: string,
  nowSec: number,
): { path: string; body: string } | null {
  throw new Error('not implemented')
}
