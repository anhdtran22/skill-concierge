// concierge-enhancer v0.3 domain types. The mod keeps two `$.state` values (PluginState below): the
// band's view and the chord that presses "Rank now". The Speculator publishes the view; the
// AbovePrompt hook in hooks/register.tsx only reads it and draws.

// What concierge will offer for the current draft, as the speculative enforcer run decided it.
// Parsed once, at the process boundary, from the enforcer's `skillConciergeSpeculation` object;
// nothing past the parser sees the wire shape.
export type Preview =
  // The menu rows, in the order the model will read them. `wholeShelf` is true only when the run's
  // ticket is "ranked" (the hook will serve this very menu, Jev's whole-shelf ranking); in every other
  // state the hook ranks the sent text itself, so the line is marked "(preview)".
  | { readonly kind: 'menu'; readonly skills: readonly string[]; readonly wholeShelf: boolean }
  // An authorized skip (jev_skip, getaway, intent_skip): the model will be told no skill is needed.
  | { readonly kind: 'no-skill' }
  // The consult lane will route the turn to skill-concierge:consult.
  | { readonly kind: 'consult' }
  // A lane that shows the user nothing (refusal, self-reference, harness text, too short).
  | { readonly kind: 'silent' }

// The one-line status the mod pins under the prompt for a Preview; undefined clears it.
export type StatusLine = string | undefined

// The menu the band shows. `mark` is '▸' for the ranking of the draft in the box (digit keys are
// bound only then: the box is not empty) and '✓' for the menu the model got after a send (the box is
// empty, where a bare digit would be taken by a band button, so no digit is bound). `text` is the
// menu of a lane that offers no skills ('no skill needed', 'consult').
export type BandMenu =
  | { readonly mark: '▸' | '✓'; readonly kind: 'skills'; readonly skills: readonly string[] }
  | { readonly mark: '▸' | '✓'; readonly kind: 'text'; readonly text: string }

// Everything the band draws, published by the Speculator and read by the AbovePrompt hook.
export type BandView = {
  // The box holds a draft (not empty, not a slash command).
  readonly hasDraft: boolean
  // A speculative run for the current draft is in flight.
  readonly busy: boolean
  readonly menu: BandMenu | null
  // A short message for the person ("limit reached"); null: none.
  readonly note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'concierge-enhancer': {
      view: BandView
      // The chord, as the person's keybindings.json has it, that presses "Rank now" from the prompt; null: none.
      chord: string | null
    }
  }
}
