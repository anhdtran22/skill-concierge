// The pure core of concierge-enhancer (sketch; bodies not implemented).
//
// Nothing here imports `$` or touches the engine: register.tsx supplies Ports, so every rule below runs
// under test with a fake clock and fake ports. The module owns: when a draft counts as settled, which
// settled drafts are worth ranking, the one-in-flight rule, the cap, the intent request and its boundary
// check, the readout parse, and the status line. It does not own ranking (enforcer.py), the route text
// (prerank.py route_text), or the Jev protocol (jevd, spoken only by enforcer.py).

/** Quiet time after the last edit before a draft counts as settled. */
export const IDLE_MS = 1000
/**
 * A draft needs at least this many whitespace-separated words. It is the enforcer's MAX_SHORT_WORDS + 1;
 * tests/test_prerank.py fails the build when the two disagree (the only value the mod copies).
 */
export const MIN_WORDS = 4
/** The intent call may take this long; past it the draft is ranked without an intent. */
export const INTENT_TIMEOUT_MS = 1200
/** Most settled drafts ranked per rolling minute, per session. */
export const MAX_RUNS_PER_MINUTE = 8
/** Longest intent kept; a longer reply is cut at a word boundary. */
export const INTENT_MAX_CHARS = 240
/** Wall limit for `enforcer.py --prerank`: the router's own budget (7.8 s) plus start-up and slack. */
export const PRERANK_TIMEOUT_MS = 12_000

/** What the mod asks the enforcer to rank. Serialised as the --prerank stdin JSON. */
export type PrerankRequest = {
  prompt: string
  /** One plain sentence from the intent step, or null when it failed, was slow, or is switched off. */
  intent: string | null
  sessionId: string
  cwd: string
}

/**
 * The enforcer's answer, parsed at the process boundary. `offered` is names only, best first: the five
 * rows concierge will render, or none for a Jev "no skill fits" ruling. `reason` is opaque: the mod
 * never branches on it, so the enforcer's reason list is not a second list to keep in step.
 */
export type Readout =
  | { status: 'ready'; band: 'offer' | 'jev_skip'; offered: readonly string[] }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

/** Everything the scheduler needs from the outside world. register.tsx builds one from `$`. */
export interface Ports {
  /** Arms one timer; `cancel` before it fires stops it. (`$.clock.after`) */
  after(ms: number, fn: () => void): { cancel(): void }
  /** Epoch ms. (`$.clock.now`) */
  now(): Promise<number>
  /** The prompt box as it stands. (`$.prompt.read`) */
  readDraft(): Promise<string>
  /** One sentence naming the work, or null. Honors `signal`. (`$.model.complete`, haiku, Max) */
  intent(draft: string, signal: AbortSignal): Promise<string | null>
  /** Runs `enforcer.py --prerank` and parses its one JSON line. Never rejects: a failure is `failed`. */
  prerank(req: PrerankRequest): Promise<Readout>
  /** The plugin's one status line. (`$.ui.status`) */
  status(line: string | undefined): void
}

export type Scheduler = {
  /** The draft changed (a `prompt.autocomplete` event). Synchronous, constant time, no I/O. */
  onEdit(text: string): void
  /** The draft was sent. Drops the status line and any run that is still waiting on its intent. */
  onSubmit(): void
}

/**
 * Debounce the prompt box and rank each settled draft once.
 *
 * Invariants:
 *  - `onEdit` never awaits and never throws; it re-arms one timer.
 *  - Any edit after a run began makes that run's result unwanted: its status is not shown and its intent
 *    call is aborted. (The enforcer process, once started, finishes; its artifact is simply never claimed.)
 *  - At most one run in flight. A draft that settles meanwhile waits in one slot, latest wins.
 *  - A draft is run at most once per distinct trimmed text, and at most MAX_RUNS_PER_MINUTE per minute.
 *  - The status line shows only a `ready` readout for the text currently in the box, and is cleared by the
 *    next edit and by `onSubmit`.
 *  - Every port failure ends the run quietly; the prompt path is never touched.
 */
export function createScheduler(ports: Ports, session: () => Promise<{ sessionId: string; cwd: string }>): Scheduler {
  throw new Error('not implemented')
}

/** True when a settled draft is worth ranking: >= MIN_WORDS words and not a slash command. Pure. */
export function worthRanking(text: string): boolean {
  throw new Error('not implemented')
}

/** The status text for a readout, or undefined for nothing to show. Pure.
 *  offer -> `Concierge · ui-styling · frontend-design · ak-test`; jev_skip -> `Concierge · no skill needed`. */
export function statusLine(readout: Readout): string | undefined {
  throw new Error('not implemented')
}

/**
 * The system prompt of the intent call. The owner's standing decisions, as instructions: name only the
 * work and its domain, copy the author's own terms verbatim, name no skill, ask nothing.
 */
export const INTENT_SYSTEM =
  'Write one plain sentence, at most 40 words, that names only the work the author wants done and its ' +
  'domain: what is built, fixed, reviewed, researched or written, and the tools, files, services or ' +
  'artifacts involved. Copy the author\'s own names verbatim: tools, files, procedures, people and any ' +
  'coined or misspelled term. Use the earlier assistant message only to resolve what "it", "that" or ' +
  '"continue" refers to. Name no skills, plugins, agents or slash commands, and ask nothing. ' +
  'Reply with the sentence only.'

/** The user message of the intent call: the draft, plus the tail of the assistant's last message. */
export function intentPrompt(draft: string, lastAssistantTail: string | null): string {
  throw new Error('not implemented')
}

/** Boundary check on the model's reply: one line, tags and quotes stripped, <= INTENT_MAX_CHARS, else null. */
export function cleanIntent(reply: string): string | null {
  throw new Error('not implemented')
}

/** Parse the last non-empty stdout line of `enforcer.py --prerank`; anything malformed is `failed`. */
export function parseReadout(stdout: string): Readout {
  throw new Error('not implemented')
}
