// concierge-enhancer v2 — the mod's state contract. Nothing here is a wire type of the
// enforcer's: the handoff the hook reads travels as an opaque string (`Prepared.handoff`).

// One ranked row as the band shows it. Derived by enforcer.py --prepare from the same rows the
// hook will render, so the band and the model's menu agree by construction.
export type PreparedRow = { name: string; share: number; badge: string; blurb: string }

// What the prepare pass found for one draft. `kind` mirrors the hook's own legs for that text.
export type PreparedView =
  | { kind: 'whole_shelf'; stage: 'full' | 'wide'; rows: PreparedRow[]; fit: number | null; ms: number; n: number }
  | { kind: 'jev_skip'; fit: number; ms: number }
  | { kind: 'named'; rows: PreparedRow[] }
  | { kind: 'lane'; lane: 'slash' | 'short' | 'harness' | 'refusal' | 'consult' | 'selfref' }
  | { kind: 'none'; why: 'not_english' | 'jev_off' | 'jev_failed' }

// A finished prepare for the draft `text`, exactly as typed when it started.
// `handoff` is the JSON object enforcer.py printed under "handoff", carried as bytes: the mod
// writes it to the route-hints file at submit and reads one field of it (`prompt`) to match.
export type Prepared = { text: string; handoff: string; view: PreparedView; at: number }

// A prepare that has started and not landed. One at a time per session.
export type Inflight = { text: string; startedMs: number }

declare module 'claude-code' {
  interface PluginState {
    'concierge-enhancer': {
      prepared: Prepared | null
      inflight: Inflight | null
    }
  }
}
