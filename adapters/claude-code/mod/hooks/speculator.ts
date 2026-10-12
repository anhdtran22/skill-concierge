// concierge-enhancer v0.2: the Speculator, the mod's one deep module.
//
// Public surface: `locateEnforcer`, and on `Speculator` four calls: `note`, `working`, `send`, `end`.
// Behind it: settle detection, the intent line (the session's own small model, on Max), one enforcer
// run per settled draft (python3 enforcer.py with a `speculate` request on stdin: concierge's own
// lanes, embedding, Qdrant and Jev-through-jevd path, under the real session id), cancellation of
// superseded runs, the per-prompt cost cap, parsing the enforcer's answer, and the status line.
//
// What it never does: rank in TypeScript, call jevd itself, read or write concierge's files other
// than the plugin registry, rewrite the prompt box, rewrite the submitted text, add model context,
// draw, or bind a key. The ticket the hook redeems is written and read by Python alone
// (hooks/scripts/offer_ticket.py).
import type {
  HookStream,
  ModelCompleteOptions,
  ModelCompleteRequest,
  ModelCompleteResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  Timer,
} from 'claude-code'

import type { Preview, StatusLine } from '../types'

// ── Tunables. Each is a decision with its evidence status; none is measured yet. ───────────────
// Quiet time after the last keystroke before a draft counts as settled.
export const SETTLE_MS = 2_000
// Optimization only: the enforcer's MAX_SHORT_WORDS (3) is the authority and drops shorter
// prompts itself. A drift between the two costs a wasted spawn or a missed speculation, never a
// wrong menu. tests/test_offer_ticket.py pins the Python side of this pair.
export const MIN_WORDS = 4
// Cost cap: enforcer runs (each one intent call plus up to two Jev calls) per composed prompt. A
// composed prompt ends when the person sends it (composer Enter) or the session ends; a model turn
// starting or ending does not end it, because the draft in the box is still the same prompt.
export const MAX_RUNS_PER_DRAFT = 1
// The intent call's whole budget; past it the draft is ranked without an intent line.
export const INTENT_TIMEOUT_MS = 2_500
// The speculative run's kill switch: above the enforcer's 7.8 s Jev cap plus start-up and annexes.
export const RANK_TIMEOUT_MS = 12_000
export const INTENT_MODEL = 'haiku'
// The context the intent writer sees: the tail of the last assistant message, the same length
// Jev's `recent_context` uses (enforcer.py JEV_CTX_CHARS = 1500).
export const RECENT_CHARS = 1_500
// The intent is one sentence; a longer reply is cut here, under the ticket's own cap
// (offer_ticket.py MAX_INTENT_CHARS = 600), so a verbose reply never voids the ticket.
export const INTENT_MAX_CHARS = 400
// While a status line is up, the box is re-read this often, so a line never outlives its draft
// even when an edit raised no `prompt.autocomplete` (that event needs a token under the cursor).
export const WATCH_MS = 1_000

// The owner's standing decisions: the intent names no skills, copies the author's own terms, and
// holds one sentence and nothing else (no questions, no list, no preamble). Derived from the rules
// the blind A/B chose (plans/261012-0935-prompt-enhancer-ab/report.md, round 2), reduced to the
// intent part.
export const INTENT_RULES = `Name the work in the rough prompt below in one plain sentence: what is built, fixed, reviewed, researched or written, and the tools, file types, services and artifacts involved.
Copy the author's own names verbatim: tools, files, procedures, people, and any coined or misspelled term ("chisle" stays "chisle").
Name no skills, plugins, agents or slash commands.
Write in the author's language.
Output only <intent></intent> with that one sentence inside.`

// The speculative run's environment, over the host's own (ProcessSpawnRequest.env).
// SKILL_CONCIERGE_HARNESS pins harness detection to Claude Code (harness.py reads
// CLAUDE_PLUGIN_ROOT first, which a spawned child does not carry). ENFORCER_LEDGER=defer makes
// an enforcer too old to know `speculate` write no ledger row; a current one forces it anyway.
export const SPECULATION_ENV: Readonly<Record<string, string>> = {
  SKILL_CONCIERGE_HARNESS: 'claude',
  ENFORCER_LEDGER: 'defer',
}

// The enforcer the session's UserPromptSubmit hook runs, as an argv. `python3` because
// hooks/hooks.json runs plain `python3`: the speculation must run the same interpreter.
export type Enforcer = { readonly argv: readonly [string, string] }

// `ledger`: concierge's ledger file; after each send the line shows the offer row the hook wrote there.
export type SpeculatorOptions = { readonly intent: boolean; readonly ledger?: string; readonly settleMs?: number }

// One speculative run: the draft it ranks, how to stop it, and what it decided.
type Job = {
  readonly draft: string
  readonly abort: AbortController
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null
  killTimer: Timer | null
  // Set when the run lands: null for a cancelled, failed or incompatible run.
  preview: Preview | null
  done: Promise<Preview | null>
}

// ── ports ────────────────────────────────────────────────────────────────────────────────────
// `claude plugin validate` follows `$` only into a function declared in the same file, never across
// an import, and wants every `$.noun.event(...)` spelled at its call site. So register.tsx builds
// these ports from the `$` of the session.start dispatch and this file never sees `$`.
export type Ports = {
  readPrompt: () => Promise<{ readonly text: string }>
  sessionId: () => Promise<string>
  cwd: () => Promise<string>
  messages: () => Promise<readonly { readonly role: string; readonly text: string }[]>
  complete: (request: ModelCompleteRequest, options: ModelCompleteOptions) => Promise<ModelCompleteResult>
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  after: (ms: number, fn: () => void) => Timer
  every: (ms: number, fn: () => void) => Timer
  status: (text: string | undefined) => void
}

// What locateEnforcer reads: the three variables, the session's cwd, the `enabledPlugins` map of
// the settings (every source merged, the later source winning per key), a file's kind and a file's text.
export type LocatePorts = {
  rootEnv: () => Promise<string | undefined>
  configEnv: () => Promise<string | undefined>
  homeEnv: () => Promise<string | undefined>
  cwd: () => Promise<string>
  enabledPlugins: () => Promise<Readonly<Record<string, unknown>>>
  isFile: (path: string) => Promise<boolean>
  readText: (path: string) => Promise<string>
}

// ── locating the enforcer ────────────────────────────────────────────────────────────────────

/** Orders dotted versions: negative when a < b. Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.\-+]/).map(p => (/^\d+$/.test(p) ? Number(p) : 0))
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const CONCIERGE_PREFIX = 'skill-concierge@'

/** The `enabledPlugins` map inside one `$.settings.read` answer; {} when absent or not a map. */
export function enabledPluginsOf(settings: unknown): Record<string, unknown> {
  const map = (settings as { enabledPlugins?: unknown } | null)?.enabledPlugins
  return typeof map === 'object' && map !== null && !Array.isArray(map) ? { ...(map as Record<string, unknown>) } : {}
}

/** True when `dir` is `root` or lies inside it (a project-scope install applies to its own tree only). */
function isInside(dir: string, root: string): boolean {
  const base = root.replace(/\/+$/, '')
  return dir === base || dir.startsWith(`${base}/`)
}

/** The `skill-concierge@*` plugin ids a registry text lists. Unparseable text gives []. */
export function registeredIds(registryText: string): string[] {
  try {
    const plugins = (JSON.parse(registryText) as { plugins?: unknown }).plugins
    return typeof plugins === 'object' && plugins !== null
      ? Object.keys(plugins).filter(id => id.startsWith(CONCIERGE_PREFIX))
      : []
  } catch {
    return []
  }
}

/**
 * The enforcer.py paths of every `skill-concierge@*` entry in an `installed_plugins.json` text
 * that the session's hook could be running, highest version first. An entry's version is its
 * `version` field, else the last segment of its `installPath`. Left out: a plugin id in `off`
 * (disabled in settings), and a project- or local-scope entry whose `projectPath` does not
 * contain `cwd`. Unparseable text, or no such entry, gives [].
 */
export function installedEnforcers(
  registryText: string,
  { off = new Set<string>(), cwd }: { off?: ReadonlySet<string>; cwd?: string } = {},
): string[] {
  let plugins: unknown
  try {
    plugins = (JSON.parse(registryText) as { plugins?: unknown }).plugins
  } catch {
    return []
  }
  if (typeof plugins !== 'object' || plugins === null) return []
  const found: { path: string; version: string }[] = []
  for (const [id, entries] of Object.entries(plugins)) {
    if (!id.startsWith(CONCIERGE_PREFIX) || off.has(id) || !Array.isArray(entries)) continue
    for (const entry of entries) {
      const { installPath, version, scope, projectPath } = (entry ?? {}) as {
        installPath?: unknown
        version?: unknown
        scope?: unknown
        projectPath?: unknown
      }
      if (typeof installPath !== 'string' || installPath === '') continue
      if (cwd !== undefined && (scope === 'project' || scope === 'local') && typeof projectPath === 'string' && !isInside(cwd, projectPath)) continue
      const base = installPath.replace(/\/+$/, '')
      found.push({
        path: `${base}/hooks/scripts/enforcer.py`,
        version: typeof version === 'string' ? version : (base.split('/').pop() ?? ''),
      })
    }
  }
  return found.sort((p, q) => compareVersions(q.version, p.version)).map(f => f.path)
}

/**
 * The installed skill-concierge's enforcer.py, or null when there is none or skill-concierge is off.
 *
 * Inert (null) first when every `skill-concierge@*` id the settings or the registry know is
 * explicitly `false` in `enabledPlugins`: the owner's "off" beats everything, an environment
 * variable included. Then SKILL_CONCIERGE_ROOT: it names the checkout a developer runs (a
 * `--plugin-dir` copy the registry cannot see); a live drive of a checkout leaves the installed
 * id enabled or absent rather than disabled. An id that is absent from
 * `enabledPlugins` counts as enabled, and so does an unreadable settings answer. Then
 * `installed_plugins.json` under CLAUDE_CONFIG_DIR (default ~/.claude): the highest-version entry
 * of an enabled id that applies to this cwd and whose enforcer.py exists. Whether that enforcer
 * can speculate is learned from its first answer.
 */
export async function locateEnforcer(ports: LocatePorts): Promise<Enforcer | null> {
  const { isFile } = ports
  const enabled = await ports.enabledPlugins().catch((): Record<string, unknown> => ({}))
  const config = (await ports.configEnv()) || `${(await ports.homeEnv()) ?? ''}/.claude`
  const registry = await ports.readText(`${config}/plugins/installed_plugins.json`).catch(() => null)
  const known = new Set([...Object.keys(enabled).filter(id => id.startsWith(CONCIERGE_PREFIX)), ...registeredIds(registry ?? '')])
  const off = new Set([...known].filter(id => enabled[id] === false))
  if (known.size > 0 && off.size === known.size) return null
  const root = (await ports.rootEnv())?.replace(/\/+$/, '')
  if (root) {
    const path = `${root}/hooks/scripts/enforcer.py`
    if (await isFile(path)) return { argv: ['python3', path] }
  }
  if (registry === null) return null
  const cwd = await ports.cwd().catch(() => undefined)
  for (const path of installedEnforcers(registry, { off, cwd })) {
    if (await isFile(path)) return { argv: ['python3', path] }
  }
  return null
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

/** Rankable by the mod's cheap pre-gate: not empty, not a slash command, at least MIN_WORDS. */
export function rankable(draft: string): boolean {
  const d = draft.trim()
  return d !== '' && !d.startsWith('/') && d.split(/\s+/).length >= MIN_WORDS
}

/**
 * The boundary parser: the enforcer's stdout (one JSON object on its last line) to a Preview,
 * 'incompatible' when the object lacks `skillConciergeSpeculation` with `v === 1`, or null when
 * the output does not parse (or a v1 answer carries a preview this mod cannot read). Reads
 * `skillConciergeSpeculation.ticket` and `.preview`:
 *   { kind: 'menu' | 'no-skill' | 'consult' | 'silent', skills?: string[], whole_shelf?: boolean }
 * The enforcer decides what the menu holds; this function only maps names. `wholeShelf` is true
 * only when the run's ticket state is 'ranked': any other state means the hook ranks the sent
 * text itself and may build another menu, so the status line must say "preview".
 */
export function parseSpeculation(stdout: string): Preview | 'incompatible' | null {
  const last = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .pop()
  if (!last) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    return null
  }
  const speculation = (parsed as { skillConciergeSpeculation?: unknown } | null)?.skillConciergeSpeculation
  if (typeof speculation !== 'object' || speculation === null) return 'incompatible'
  if ((speculation as { v?: unknown }).v !== 1) return 'incompatible'
  const { preview, ticket } = speculation as { preview?: unknown; ticket?: unknown }
  if (typeof preview !== 'object' || preview === null) return null
  const { kind, skills, whole_shelf: wholeShelf } = preview as { kind?: unknown; skills?: unknown; whole_shelf?: unknown }
  if (kind === 'no-skill' || kind === 'consult' || kind === 'silent') return { kind }
  if (kind !== 'menu' || !Array.isArray(skills)) return null
  const names = skills
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return { kind: 'menu', skills: names, wholeShelf: wholeShelf === true && ticket === 'ranked' }
}

// The line shares a terminal row with the engine's own notices and the mod cannot read the width,
// so it fits the names into a fixed budget. A name that must shrink loses its middle, never either
// end (the owner's rule), and every name gets the same cap; only when even the shortest cap would
// not fit are the last skills counted as "+N".
const NAMES_BUDGET = 76
const MIN_NAME = 9

export function middleCut(name: string, cap: number): string {
  if (name.length <= cap) return name
  const head = Math.ceil((cap - 1) / 2)
  const tail = cap - 1 - head
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`
}

function fitNames(skills: readonly string[], suffix: string): string {
  const budget = NAMES_BUDGET - suffix.length
  for (let shown = skills.length; shown >= 1; shown--) {
    const more = shown < skills.length ? ` +${skills.length - shown}` : ''
    const room = budget - more.length - 3 * (shown - 1)
    const names = skills.slice(0, shown)
    const longest = Math.max(...names.map(name => name.length))
    for (let cap = longest; cap >= Math.min(MIN_NAME, longest); cap--) {
      if (names.reduce((sum, name) => sum + Math.min(name.length, cap), 0) <= room) {
        return names.map(name => middleCut(name, cap)).join(' · ') + more + suffix
      }
    }
  }
  return middleCut(skills[0] ?? '', MIN_NAME) + (skills.length > 1 ? ` +${skills.length - 1}` : '') + suffix
}

// How much of the ledger's tail the sent-menu read scans, and how long it may take.
export const SENT_TAIL_LINES = 400
export const SENT_READ_MS = 2_000

type OfferRow = { readonly band?: unknown; readonly offered?: unknown }

/** The last offer row in `tail` (JSON lines) for this session and this sent text, or null. */
export function findOffer(tail: string, sid: string, sent: string): OfferRow | null {
  const q = sent.slice(0, 120)
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i] ?? '') as Record<string, unknown>
      if (row.ev === 'offer' && row.sid === sid && row.q === q) return row
    } catch {
      // not a JSON row
    }
  }
  return null
}

/**
 * The status line for the menu the model got. Literal forms (tests assert them):
 *   offered rows        -> 'concierge ✓ ui-styling · frontend-design'
 *   a skip band, none   -> 'concierge ✓ no skill needed'
 *   consult route       -> 'concierge ✓ consult'
 *   no row, other bands -> undefined
 */
export function sentStatus(row: OfferRow | null): StatusLine {
  if (row === null) return undefined
  const names = Array.isArray(row.offered)
    ? row.offered.map(o => (Array.isArray(o) ? o[0] : o)).filter((n): n is string => typeof n === 'string' && n !== '')
    : []
  if (names.length > 0) return `concierge ✓ ${fitNames(names, '')}`
  if (row.band === 'consult_route') return 'concierge ✓ consult'
  if (row.band === 'jev_skip' || row.band === 'getaway' || row.band === 'intent_skip') return 'concierge ✓ no skill needed'
  return undefined
}

/**
 * The status line for a Preview. Literal forms (tests assert them):
 *   menu, ranked ticket -> 'concierge ▸ ui-styling · frontend-design · ak-test'
 *   any other menu      -> 'concierge ▸ ui-styling · frontend-design (preview)'
 *   no-skill           -> 'concierge ▸ no skill needed'
 *   consult            -> 'concierge ▸ consult'
 *   silent, empty menu -> undefined
 */
export function statusFor(preview: Preview): StatusLine {
  switch (preview.kind) {
    case 'menu':
      return preview.skills.length === 0
        ? undefined
        : `concierge ▸ ${fitNames(preview.skills, preview.wholeShelf ? '' : ' (preview)')}`
    case 'no-skill':
      return 'concierge ▸ no skill needed'
    case 'consult':
      return 'concierge ▸ consult'
    case 'silent':
      return undefined
  }
}

// ── the Speculator ───────────────────────────────────────────────────────────────────────────

export class Speculator {
  // One owner for every piece of mod-side state: all fields are private to this class.
  private job: Job | null = null
  private timer: Timer | null = null
  private watch: Timer | null = null
  private runs = 0                          // enforcer runs since the last send (the cost cap)
  private isWorking = false
  private incompatible = false              // the located enforcer cannot speculate: stay inert
  private readonly intents = new Map<string, string>()   // draft -> intent, last 8 drafts
  private shownFor: string | null = null    // the exact draft the status line describes; null: no line

  /**
   * @param p ports over the session.start hook's `$`, kept for the session's life: settle
   *   timers, intent calls and enforcer runs outlive every other dispatch.
   */
  constructor(
    private readonly p: Ports,
    private readonly enforcer: Enforcer,
    private readonly options: SpeculatorOptions = { intent: false },
  ) {}

  /**
   * The draft changed. Arms (or re-arms) the settle timer; never awaits anything.
   *
   * Invariants:
   * - the status line only ever describes the exact current draft: any change clears it;
   * - nothing is armed while a turn runs, for a draft that is empty, a slash command, or
   *   shorter than MIN_WORDS, or once the enforcer proved unable to speculate;
   * - a run for a draft that is no longer the box's is killed at once.
   */
  note(draft: string): void {
    const d = draft.trim()
    if (this.shownFor !== null && d !== this.shownFor) this.show(undefined, null)
    this.timer?.cancel()
    this.timer = null
    if (this.job && this.job.draft !== d) this.cancel()
    if (this.incompatible || this.isWorking || !rankable(d)) return
    this.timer = this.p.after(this.options.settleMs ?? SETTLE_MS, () => void this.settle())
  }

  /**
   * A model turn started (true) or ended (false). Starting cancels the timer and any run and
   * clears the status: Jev's context (the last assistant text) is about to change. Ending
   * re-arms the timer for the draft that waits in the box. Neither resets the per-prompt run
   * count: a notification turn must not buy the same unchanged draft more runs.
   */
  working(isWorking: boolean): void {
    this.isWorking = isWorking
    if (isWorking) {
      this.timer?.cancel()
      this.timer = null
      this.cancel()
      if (this.shownFor !== '') this.show(undefined, null)   // a preview goes; the sent menu ('') stays
      return   // `runs` is kept: the draft is still the same composed prompt
    }
    void this.p.readPrompt().then(
      box => this.note(box.text),
      () => undefined,
    )
  }

  /**
   * Wraps one composer send. `go` is the hook's `next(e)`; it runs exactly once, unchanged, and
   * its result (or its rejection) is returned as is. This call adds no wait of its own.
   *
   * Order:
   * 1. A run whose draft is not exactly `text.trim()`, or that has not spawned its child yet, is
   *    cancelled now: nothing it could write would be read by this send.
   * 2. A spawned run for the sent text stays alive while `go()` runs: the enforcer may be
   *    waiting on its ticket (hooks/scripts/offer_ticket.py, `redeem`).
   * 3. The settle timer is cancelled, the status cleared, and the per-prompt run count reset: a
   *    send is the only thing that ends a composed prompt (besides `end()`).
   * 4. After `go()` settles (the command hooks are done), every run is cancelled.
   */
  async send<R>(text: string, go: () => Promise<R>): Promise<R> {
    const sent = text.trim()
    try {
      if (this.job && (this.job.draft !== sent || this.job.stream === null)) this.cancel()
      this.timer?.cancel()
      this.timer = null
      this.show(undefined, null)
      this.runs = 0
    } catch {
      // Bookkeeping must never stop a prompt from being sent.
    }
    try {
      return await go()
    } finally {
      this.cancel()
      void this.showSent(sent)
    }
  }

  /**
   * After a send: the menu the model actually got, read from the offer row the hook wrote for
   * this session and this text (the tail of concierge's ledger; no Jev call). Shown as
   * `concierge ✓ …` while the box stays empty; typing clears it. Never throws.
   */
  private async showSent(sent: string): Promise<void> {
    const ledger = this.options.ledger
    if (!ledger) return
    try {
      const sid = await this.p.sessionId()
      const stream = this.p.spawn({ argv: ['tail', '-n', String(SENT_TAIL_LINES), ledger] })
      const kill = this.p.after(SENT_READ_MS, () => void stream.return?.(undefined as never))
      let out = ''
      try {
        for (;;) {
          const step = await stream.next()
          if (step.done) break
          if (step.value.stream === 'stdout') out += step.value.text
        }
      } finally {
        kill.cancel()
      }
      const line = sentStatus(findOffer(out, sid, sent))
      if (line !== undefined && (await this.p.readPrompt()).text.trim() === '') this.show(line, '')
    } catch {
      // Display only: a missing or unreadable ledger leaves the line empty.
    }
  }

  /**
   * The session ended (a /clear too) or the module is rebuilt: cancel the timer and every run.
   * Idempotent. The run count survives, so a /clear cannot buy a draft more runs: only a send resets it.
   */
  end(): void {
    this.timer?.cancel()
    this.timer = null
    this.cancel()
    this.show(undefined, null)
    this.isWorking = false
    this.intents.clear()
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  /**
   * The settle timer fired. Re-reads the box (the timer's draft may be stale), then starts one
   * run when the draft is rankable, differs from the latest run's, and the cap allows it.
   * Shows the result only if the box still holds exactly that draft when it lands.
   */
  private async settle(): Promise<void> {
    this.timer = null
    try {
      const draft = (await this.p.readPrompt()).text.trim()
      if (this.incompatible || this.isWorking || !rankable(draft)) return
      if (this.job && this.job.draft === draft) {
        // Typed a character and took it back: the latest run's ticket is still this draft's.
        if (this.job.preview && this.shownFor !== draft) this.show(statusFor(this.job.preview), draft)
        return
      }
      if (this.runs >= MAX_RUNS_PER_DRAFT) return
      this.cancel()
      this.runs++
      const job = this.start(draft, this.runs)
      this.job = job
      const preview = await job.done
      job.preview = preview
      if (!preview || this.job !== job || this.isWorking) return
      if ((await this.p.readPrompt()).text.trim() === draft) this.show(statusFor(preview), draft)
    } catch {
      // A failed read or status call costs the preview, never the prompt.
    }
  }

  /**
   * Starts one speculative run for `draft`: the intent line, then `python3 enforcer.py` with stdin
   *   { prompt: draft, session_id, cwd, speculate: { intent, n } }
   * (no transcript_path: the API exposes none, so the enforcer finds the transcript by session
   * id; the ticket's context fingerprint makes any miss there safe). Collects stdout, kills the
   * child on abort or after RANK_TIMEOUT_MS, and parses the last stdout line with
   * `parseSpeculation`. An answer without `skillConciergeSpeculation` sets `incompatible`.
   */
  private start(draft: string, n: number): Job {
    const job: Job = {
      draft,
      abort: new AbortController(),
      stream: null,
      killTimer: null,
      preview: null,
      done: Promise.resolve(null),
    }
    job.done = this.run(job, n).catch(() => null)
    return job
  }

  private async run(job: Job, n: number): Promise<Preview | null> {
    const { signal } = job.abort
    const intent = await this.intentFor(job.draft, signal)
    if (signal.aborted) return null
    const [sessionId, cwd] = await Promise.all([this.p.sessionId(), this.p.cwd()])
    if (signal.aborted) return null
    const stream = this.p.spawn({
      argv: this.enforcer.argv,
      env: { ...SPECULATION_ENV },
      input: JSON.stringify({ prompt: job.draft, session_id: sessionId, cwd, speculate: { intent, n } }),
    })
    job.stream = stream
    job.killTimer = this.p.after(RANK_TIMEOUT_MS, () => this.cancelJob(job))
    const aborted = new Promise<'aborted'>(resolve => {
      signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    let out = ''
    try {
      for (;;) {
        const step = await Promise.race([stream.next(), aborted])
        if (step === 'aborted' || step.done) break
        if (step.value.stream === 'stdout') out += step.value.text
      }
    } finally {
      job.killTimer?.cancel()
    }
    if (signal.aborted) return null
    const parsed = parseSpeculation(out)
    if (parsed === 'incompatible') {
      this.incompatible = true
      return null
    }
    return parsed
  }

  /**
   * The intent line for `draft`, or '' (rank the draft alone). Cached per draft. One
   * `$.model.complete` call on the session's own client (Max): model INTENT_MODEL, system
   * INTENT_RULES, prompt = the recent assistant tail (RECENT_CHARS) as context plus the draft in
   * <rough_prompt>, maxTokens 200, timeoutMs INTENT_TIMEOUT_MS, `{ signal }`. Any arm but
   * `isAnswered` with a non-empty <intent> gives ''. Never throws.
   */
  private async intentFor(draft: string, signal: AbortSignal): Promise<string> {
    if (!this.options.intent) return ''
    const cached = this.intents.get(draft)
    if (cached !== undefined) return cached
    try {
      const recent = await this.recentTail()
      const prompt =
        (recent ? `<recent_assistant_message>\n${recent}\n</recent_assistant_message>\n\n` : '') +
        `<rough_prompt>\n${draft}\n</rough_prompt>`
      const reply = await this.p.complete(
        { model: INTENT_MODEL, system: INTENT_RULES, prompt, maxTokens: 200, timeoutMs: INTENT_TIMEOUT_MS },
        { signal },
      )
      if (!reply.isAnswered) return ''
      const intent = (reply.text.match(/<intent>([\s\S]*?)<\/intent>/)?.[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, INTENT_MAX_CHARS)
      if (intent) {
        if (this.intents.size >= 8) this.intents.delete(this.intents.keys().next().value as string)
        this.intents.set(draft, intent)
      }
      return intent
    } catch {
      return ''
    }
  }

  /** The tail of the session's last assistant message, or '' when there is none. */
  private async recentTail(): Promise<string> {
    try {
      const rows = await this.p.messages()
      const last = [...rows].reverse().find(r => r.role === 'assistant' && r.text.trim() !== '')
      return last ? last.text.trim().slice(-RECENT_CHARS) : ''
    } catch {
      return ''
    }
  }

  /** Cancels the current job (abort, `stream.return()` kills the child, kill timer off). */
  private cancel(): void {
    const job = this.job
    this.job = null
    if (job) this.cancelJob(job)
  }

  private cancelJob(job: Job): void {
    job.abort.abort()
    job.killTimer?.cancel()
    job.killTimer = null
    // Not awaited: the engine ends the child when the stream is closed. A job that never
    // spawned has no stream, and its abort flag stops it before it would.
    void job.stream?.return({ code: null, signal: null }).catch(() => undefined)
  }

  /** Pins `line` as this plugin's status (`$.ui.status`, one per plugin: no peer shares it). */
  private show(line: StatusLine, forDraft: string | null): void {
    if (line === undefined && this.shownFor === null) return
    this.shownFor = line === undefined ? null : forDraft
    this.watch?.cancel()
    this.watch = null
    this.p.status(line)
    if (line !== undefined) this.watch = this.p.every(WATCH_MS, () => void this.verify())
  }

  /** The status line's guard: the box must still hold the draft the line describes. */
  private async verify(): Promise<void> {
    try {
      if (this.shownFor !== null && (await this.p.readPrompt()).text.trim() !== this.shownFor) {
        this.show(undefined, null)
      }
    } catch {
      this.show(undefined, null)
    }
  }
}
