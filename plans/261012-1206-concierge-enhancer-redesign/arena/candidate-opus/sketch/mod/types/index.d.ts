// concierge-enhancer v0.2 domain types. The mod adds no noun to `$` and keeps no `$.state`:
// it draws nothing (no ui.render hook), so it has no drawing state to subscribe to.

// What concierge will offer for the current draft, as the speculative enforcer run decided it.
// Parsed once, at the process boundary, from the enforcer's `skillConciergeSpeculation` object;
// nothing past the parser sees the wire shape.
export type Preview =
  // The menu rows, in the order the model will read them. `wholeShelf` is the enforcer's own
  // header choice (Jev judged every skill) versus the embedding "Preview" header.
  | { readonly kind: 'menu'; readonly skills: readonly string[]; readonly wholeShelf: boolean }
  // An authorized skip (jev_skip, getaway, intent_skip): the model will be told no skill is needed.
  | { readonly kind: 'no-skill' }
  // The consult lane will route the turn to skill-concierge:consult.
  | { readonly kind: 'consult' }
  // A lane that shows the user nothing (refusal, self-reference, harness text, too short).
  | { readonly kind: 'silent' }

// The one-line status the mod pins under the prompt for a Preview; undefined clears it.
export type StatusLine = string | undefined
