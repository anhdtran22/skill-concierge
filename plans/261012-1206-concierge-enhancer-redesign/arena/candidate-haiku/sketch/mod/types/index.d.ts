// Sketch: types shared by the mod. The mod stores the enforcer's output as opaque data;
// only the enforcer writes or validates its shape (single owner).

// What `enforcer.py` prints in precompute mode (stdin `precompute: true`, ENFORCER_LEDGER=defer).
// Stage 1 (no `route`) prints `{ needs_route: true }`, or a finished output when the lanes
// already decided (refusal, consult, self-reference). Stage 2 (with `route`) prints a full output.
export type EnforcerOutput = {
  needs_route?: true
  hookSpecificOutput?: { hookEventName: 'UserPromptSubmit'; additionalContext: string }
  // Structured offer row. The status line reads `band` and `offered` only, never the menu text.
  skillConciergeOffer?: {
    band: string
    offered: [string, number][]
    fallback: string | null
    [key: string]: unknown
  }
  prompt?: string // the draft the menu was ranked for
  fp?: string // transcript tail fingerprint at the start of the precompute
  built_at?: number // seconds since epoch (time.time())
  ttl_s?: number // how long the enforcer will honour a hand-off built from this output
}

// The mod's one ready slot: the last settled draft and what was ranked for it.
export type Precomputed = {
  prompt: string // the draft
  route: string // draft + intent line; '' when stage 1 finished the output
  out: EnforcerOutput
  expiresAt: number // seconds since epoch; the slot is dropped at this time
}

// The hint file the submit hook writes: route-hints/<session_id>.json.
// The enforcer reads and deletes it once per prompt and serves `menu` only when it is current.
export type RouteHint = {
  prompt: string
  route?: string
  t: number
  menu?: EnforcerOutput
}
