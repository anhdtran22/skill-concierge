// concierge-enhancer v0.2: the Speculator, the mod's one deep module.
//
// Public surface: `locateEnforcer`, and on `Speculator` four calls: `note`, `working`, `send`, `end`.
// Behind it: settle detection, the intent line (session's own small model, on Max), one enforcer
// run per settled draft (python3 enforcer.py with a `speculate` request on stdin: concierge's own
// lanes, embedding, Qdrant and Jev-through-jevd path, under the real session id), cancellation of
// superseded runs, the per-draft cost cap, parsing the enforcer's answer, and the status line.
//
// What it never does: rank in TypeScript, call jevd itself, read or write concierge's files,
// rewrite the prompt box, rewrite the submitted text, add model context, draw, or bind a key.
// The ticket the hook redeems is written and read by Python alone (hooks/scripts/offer_ticket.py).
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Timer } from 'claude-code'

import type { Preview, StatusLine } from '../types'

// ── Tunables. Each is a decision with its evidence status; none is measured yet. ───────────────
// Quiet time after the last keystroke before a draft counts as settled. Unmeasured; tuned from
// the ledger's `spec.n` (runs per sent prompt, the cost) and `spec.st` (hit rate).
export const SETTLE_MS = 700
// Optimization only: the enforcer's MAX_SHORT_WORDS (3) is the authority and drops shorter
// prompts itself. A drift between the two costs a wasted spawn or a missed speculation, never a
// wrong menu.
export const MIN_WORDS = 4
// Cost cap: enforcer runs (each one intent call plus up to two Jev calls) per composed prompt.
export const MAX_RUNS_PER_DRAFT = 6
// The intent call's whole budget; past it the draft is ranked without an intent line.
export const INTENT_TIMEOUT_MS = 2_500
// The speculative run's kill switch: above the enforcer's 7.8 s Jev cap plus start-up and annexes.
export const RANK_TIMEOUT_MS = 12_000
export const INTENT_MODEL = 'haiku'
// The context the intent writer sees: the tail of the last assistant message, the same length
// Jev's `recent_context` uses (enforcer.py JEV_CTX_CHARS = 1500).
export const RECENT_CHARS = 1_500

// The owner's standing decisions, verbatim in effect: the intent names no skills, copies the
// author's own terms, and asks the author nothing. Derived from the v0.67.0 rules the blind A/B
// chose (plans/261012-0935-prompt-enhancer-ab/report.md, round 2), reduced to the intent part.
export const INTENT_RULES = `Name the work in the rough prompt below in one or two plain sentences: what is built, fixed, reviewed, researched or written, and the tools, file types, services and artifacts involved.
Copy the author's own names verbatim: tools, files, procedures, people, and any coined or misspelled term ("chisle" stays "chisle").
Name no skills, plugins, agents or slash commands.
Write in the author's language.
Output only <intent></intent>.`

// The speculative run's environment, over the host's own (ProcessSpawnRequest.env).
// SKILL_CONCIERGE_HARNESS pins harness detection to Claude Code (harness.py reads
// CLAUDE_PLUGIN_ROOT first, which a spawned child does not carry). ENFORCER_LEDGER=defer makes
// an enforcer too old to know `speculate` write no ledger row; a current one forces it anyway.
const SPECULATION_ENV: Record<string, string> = { SKILL_CONCIERGE_HARNESS: 'claude', ENFORCER_LEDGER: 'defer' }

// The enforcer the session's UserPromptSubmit hook runs, as an argv. `python3` because
// hooks/hooks.json runs plain `python3`: the speculation must run the same interpreter.
export type Enforcer = { readonly argv: readonly [string, string] }

// One speculative run: the draft it ranks, how to stop it, and what it decided.
type Job = {
  readonly draft: string
  readonly abort: AbortController
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null
  killTimer: Timer | null
  // null: cancelled, failed, or an enforcer that cannot speculate (see `incompatible`).
  readonly done: Promise<Preview | null>
}

/**
 * The installed skill-concierge's enforcer.py, or null when there is none.
 *
 * Order: SKILL_CONCIERGE_ROOT (a development checkout, so a dev tree can be driven live); then
 * `installed_plugins.json` under CLAUDE_CONFIG_DIR (default ~/.claude): among the
 * `skill-concierge@*` entries, a `local`/`project` entry whose `projectPath` is this session's
 * root wins over the `user` entry (fixes v0.67.0's first-entry pick, D7). The file must exist
 * (`$.fs.stat`). Whether that enforcer can speculate is learned from its first answer.
 */
export async function locateEnforcer($: EngineInterface): Promise<Enforcer | null> {
  // TODO: env SKILL_CONCIERGE_ROOT -> `${root}/hooks/scripts/enforcer.py`
  // TODO: read installed_plugins.json; filter ids starting `skill-concierge@`; rank entries by
  //       (scope in {local, project} && projectPath === await $.session.root()) then scope 'user'
  // TODO: $.fs.stat(path) -> exists, else try next; none -> null
  throw new Error('not implemented')
}

export class Speculator {
  // One owner for every piece of mod-side state: all fields are private to this class.
  private job: Job | null = null
  private timer: Timer | null = null
  private runs = 0                          // enforcer runs since the last send (the cost cap)
  private isWorking = false
  private incompatible = false              // the located enforcer cannot speculate: stay inert
  private recent: string | null = null      // last assistant text tail; refreshed per finished turn
  private readonly intents = new Map<string, string>()   // draft -> intent, last 8 drafts
  private shownFor: string | null = null    // the exact draft the status line describes

  /**
   * @param $ the session.start hook's engine interface, kept for the session's life: settle
   *   timers, intent calls and enforcer runs outlive every other dispatch.
   */
  constructor(private readonly $: EngineInterface, private readonly enforcer: Enforcer) {}

  /**
   * The draft changed. Arms (or re-arms) the settle timer; never awaits anything.
   *
   * Invariants:
   * - the status line only ever describes the exact current draft: any change clears it;
   * - nothing is armed while a turn runs, for a draft that is empty, a slash command, or
   *   shorter than MIN_WORDS, or once the enforcer proved unable to speculate.
   */
  note(draft: string): void {
    // TODO: d = draft.trim(); if (d !== this.shownFor) this.show(undefined, null)
    // TODO: if (this.incompatible || this.isWorking || !rankable(d)) { cancel timer; return }
    // TODO: this.timer?.cancel(); this.timer = this.$.clock.after(SETTLE_MS, () => void this.settle())
    throw new Error('not implemented')
  }

  /**
   * A model turn started (true) or ended (false). Starting cancels the timer and any run and
   * clears the status: Jev's context (the last assistant text) is about to change. Ending
   * refreshes `recent` from `$.session.messages()` and re-arms the timer when a draft waits.
   */
  working(isWorking: boolean): void {
    throw new Error('not implemented')
  }

  /**
   * Wraps one composer send. `go` is the hook's `next(e)`; it runs exactly once, unchanged, and
   * its result is returned as is. This call never throws and adds no wait of its own.
   *
   * Order:
   * 1. A run whose draft is not exactly `text.trim()` is cancelled now (its child killed).
   * 2. A run whose draft IS the sent text stays alive while `go()` runs: the enforcer may be
   *    waiting on its ticket (hooks/scripts/offer_ticket.py, `redeem`).
   * 3. The settle timer is cancelled, the status cleared, the per-draft run count reset.
   * 4. After `go()` settles (the command hooks are done), every run is cancelled.
   */
  async send<R>(text: string, go: () => Promise<R>): Promise<R> {
    // TODO: const sent = text.trim()
    // TODO: if (this.job && this.job.draft !== sent) this.cancel()
    // TODO: this.timer?.cancel(); this.timer = null; this.show(undefined, null); this.runs = 0
    // TODO: try { return await go() } finally { this.cancel() }
    throw new Error('not implemented')
  }

  /** The session ended or the module is rebuilt: cancel the timer and every run. Idempotent. */
  end(): void {
    throw new Error('not implemented')
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  /**
   * The settle timer fired. Re-reads the box (the timer's draft may be stale), then starts one
   * run when the draft is rankable, differs from the running job's, and the cap allows it.
   * Shows the result only if the box still holds exactly that draft when it lands.
   */
  private async settle(): Promise<void> {
    // TODO: const draft = (await this.$.prompt.read()).text.trim()
    // TODO: guards: incompatible, isWorking, !rankable, job?.draft === draft, runs >= MAX_RUNS_PER_DRAFT
    // TODO: this.cancel(); this.runs++; const job = (this.job = this.start(draft, this.runs))
    // TODO: const preview = await job.done
    // TODO: if (preview && this.job === job && (await this.$.prompt.read()).text.trim() === draft)
    //         this.show(statusFor(preview), draft)
    throw new Error('not implemented')
  }

  /**
   * Starts one speculative run for `draft`: the intent line, then
   * `python3 enforcer.py` with stdin
   *   { prompt: draft, session_id: await $.session.id(), speculate: { intent, n } }
   * (no transcript_path: the API exposes none, so the enforcer finds the transcript by session
   * id; the ticket's context fingerprint makes any miss there safe). Collects stdout, kills the
   * child on abort or after RANK_TIMEOUT_MS, and parses the last stdout line with
   * `parseSpeculation`. An answer without `skillConciergeSpeculation` sets `incompatible`.
   */
  private start(draft: string, n: number): Job {
    // TODO: const abort = new AbortController()
    // TODO: done = (async () => {
    //         const intent = await this.intentFor(draft, abort.signal)      // '' on any failure
    //         if (abort.signal.aborted) return null
    //         job.stream = this.$.process.spawn({ argv: this.enforcer.argv, env: SPECULATION_ENV,
    //           input: JSON.stringify({ prompt: draft, session_id: await this.$.session.id(),
    //                                   speculate: { intent, n } }) })
    //         job.killTimer = this.$.clock.after(RANK_TIMEOUT_MS, () => this.cancelJob(job))
    //         let out = ''; for await (const c of job.stream) if (c.stream === 'stdout') out += c.text
    //         const parsed = parseSpeculation(out)
    //         if (parsed === 'incompatible') { this.incompatible = true; return null }
    //         return parsed
    //       })().catch(() => null)
    throw new Error('not implemented')
  }

  /**
   * The intent line for `draft`, or '' (rank the draft alone). Cached per draft. One
   * `$.model.complete` call on the session's own client (Max): model INTENT_MODEL, system
   * INTENT_RULES, prompt = the recent assistant tail (RECENT_CHARS) as context plus the draft in
   * <rough_prompt>, maxTokens 200, timeoutMs INTENT_TIMEOUT_MS, `{ signal }`. Any arm but
   * `isAnswered` with a non-empty <intent> gives ''. Never throws.
   */
  private async intentFor(draft: string, signal: AbortSignal): Promise<string> {
    throw new Error('not implemented')
  }

  /** Cancels the current job (abort, `stream.return()` kills the child, kill timer off). */
  private cancel(): void {
    throw new Error('not implemented')
  }

  private cancelJob(job: Job): void {
    throw new Error('not implemented')
  }

  /** Pins `line` as this plugin's status (`$.ui.status`, one per plugin: no peer shares it). */
  private show(line: StatusLine, forDraft: string | null): void {
    // TODO: this.shownFor = line ? forDraft : null; this.$.ui.status(line)
    throw new Error('not implemented')
  }
}

/** Rankable by the mod's cheap pre-gate: not empty, not a slash command, at least MIN_WORDS. */
export function rankable(draft: string): boolean {
  throw new Error('not implemented')
}

/**
 * The boundary parser: the enforcer's stdout (one JSON object on its last line) to a Preview,
 * 'incompatible' when the object lacks `skillConciergeSpeculation` with `v === 1`, or null when
 * the output does not parse. Reads `skillConciergeSpeculation.preview` only:
 *   { kind: 'menu' | 'no-skill' | 'consult' | 'silent', skills?: string[], whole_shelf?: boolean }
 * The enforcer decides what the menu holds; this function only maps names.
 */
export function parseSpeculation(stdout: string): Preview | 'incompatible' | null {
  throw new Error('not implemented')
}

/**
 * The status line for a Preview. Literal forms (tests assert them):
 *   menu, whole shelf  -> 'concierge ▸ ui-styling · frontend-design · ak-test'
 *   menu, embedding    -> 'concierge ▸ ui-styling · frontend-design (preview)'
 *   no-skill           -> 'concierge ▸ no skill needed'
 *   consult            -> 'concierge ▸ consult'
 *   silent             -> undefined
 */
export function statusFor(preview: Preview): StatusLine {
  throw new Error('not implemented')
}
