// concierge-enhancer v0.3: the Speculator, the mod's one deep module.
//
// Public surface: `locateEnforcer`, and on `Speculator` these calls: `note`, `working`, `send`, `end`,
// and for the band's buttons `rankNow` and `insert`.
// Behind it: settle detection, the intent line (the session's own small model, on Max), one enforcer
// run per settled draft (python3 enforcer.py with a `speculate` request on stdin: concierge's own
// lanes, embedding, Qdrant and Jev-through-jevd path, under the real session id), cancellation of
// superseded runs, the per-prompt cost cap, parsing the enforcer's answer, and the status line.
//
// What it never does: rank in TypeScript, call jevd itself, read or write concierge's files other
// than the plugin registry, rewrite the submitted text, add model context or draw. The one write to
// the prompt box is `insert`: a skill name the person asked for, at the cursor. What the band shows
// leaves through `Ports.band` as a BandView; the AbovePrompt hook in register.tsx draws it. The ticket
// the hook redeems is written and read by Python alone (hooks/scripts/offer_ticket.py).
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

import type { BandMenu, BandView, Preview, StatusLine } from '../types'

// ── Tunables. Each is a decision with its evidence status; none is measured yet. ───────────────
// Quiet time after the last keystroke before a draft counts as settled.
export const SETTLE_MS = 2_000
// Optimization only: the enforcer's MAX_SHORT_WORDS (3) is the authority and drops shorter
// prompts itself. A drift between the two costs a wasted spawn or a missed speculation, never a
// wrong menu. tests/test_offer_ticket.py pins the Python side of this pair.
export const MIN_WORDS = 4
// Cost cap: enforcer runs (each one intent call plus up to two Jev calls) per composed prompt. A
// composed prompt ends when the person sends it (composer Enter); a model turn starting or ending
// or a /clear does not end it, because the draft in the box is still the same prompt. The automatic
// run (after the pause) may use MAX_AUTO_RUNS of the MAX_RUNS_PER_PROMPT; the "Rank now" button may
// use the rest, so one prompt never costs more than two rankings from the mod.
export const MAX_AUTO_RUNS = 1
export const MAX_RUNS_PER_PROMPT = 2
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
// `autoRank` false: a settled draft is not ranked by itself; only `rankNow` ranks (default true).
export type SpeculatorOptions = {
  readonly intent: boolean
  readonly ledger?: string
  readonly settleMs?: number
  readonly autoRank?: boolean
}

// One speculative run: the draft it ranks, how to stop it, and what it decided.
type Job = {
  // The draft this run ranked. The band's `insert` moves it to the text after a skill name went in,
  // so that edit does not read as a new draft to rank.
  draft: string
  readonly abort: AbortController
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null
  killTimer: Timer | null
  // Set when the run lands: null for a cancelled, failed or incompatible run.
  preview: Preview | null
  // True once `done` settled (the run is no longer in flight).
  landed: boolean
  done: Promise<Preview | null>
}

// ── ports ────────────────────────────────────────────────────────────────────────────────────
// `claude plugin validate` follows `$` only into a function declared in the same file, never across
// an import, and wants every `$.noun.event(...)` spelled at its call site. So register.tsx builds
// these ports from the `$` of the session.start dispatch and this file never sees `$`.
export type Ports = {
  readPrompt: () => Promise<{ readonly text: string; readonly cursor?: number }>
  sessionId: () => Promise<string>
  cwd: () => Promise<string>
  messages: () => Promise<readonly { readonly role: string; readonly text: string }[]>
  complete: (request: ModelCompleteRequest, options: ModelCompleteOptions) => Promise<ModelCompleteResult>
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  after: (ms: number, fn: () => void) => Timer
  every: (ms: number, fn: () => void) => Timer
  status: (text: string | undefined) => void
  // Publishes what the band draws; called only when it changed.
  band: (view: BandView) => void
  // Puts text into the prompt box at the cursor; false when the box did not take it.
  insertText: (text: string) => Promise<boolean>
}

/** The band with nothing to show. */
export const EMPTY_VIEW: BandView = { hasDraft: false, busy: false, menu: null, note: null }

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

// The engine keybinding action the "Rank now" button names (Button `action`: the person's chord for it
// presses the button from the prompt). It is the action the plugin API's own example uses, and its
// only built-in chord is `ctrl+x b` in the diff panel, so it is free in the prompt: no prompt-side
// handler of it is mounted, and no key the owner uses today (cmd+e focuses the band) is taken.
export const RANK_ACTION = 'app:cycleDiffBase'
export const DEFAULT_RANK_CHORD = 'ctrl+x b'

/**
 * The chord that presses "Rank now" from the prompt, as the person's keybindings.json (its text, or
 * null when unreadable) has it: their own binding of RANK_ACTION in the Chat, Global or DiffPanel
 * context first, else the built-in chord unless they remapped or unbound it in the DiffPanel
 * context (then null: no chord to show). Never throws.
 */
export function rankChordFrom(text: string | null): string | null {
  const bound: Record<string, Record<string, unknown>> = {}
  try {
    const file = JSON.parse(text ?? '') as { bindings?: unknown }
    for (const block of Array.isArray(file.bindings) ? file.bindings : []) {
      const { context, bindings } = (block ?? {}) as { context?: unknown; bindings?: unknown }
      if (typeof context !== 'string' || typeof bindings !== 'object' || bindings === null) continue
      const into = (bound[context] ??= {})
      for (const [chord, action] of Object.entries(bindings)) into[chord.toLowerCase()] = action
    }
  } catch {
    // No keybindings.json, or one that does not parse: Claude Code uses its defaults.
  }
  for (const context of ['Chat', 'Global', 'DiffPanel']) {
    const own = Object.keys(bound[context] ?? {}).find(chord => bound[context]?.[chord] === RANK_ACTION)
    if (own) return own
  }
  const builtin = bound['DiffPanel']?.[DEFAULT_RANK_CHORD]
  return builtin === undefined ? DEFAULT_RANK_CHORD : null
}

/** Rankable by the mod's cheap pre-gate: not empty, not a slash command, at least MIN_WORDS. */
export function rankable(draft: string): boolean {
  const d = draft.trim()
  return d !== '' && !d.startsWith('/') && d.split(/\s+/).length >= MIN_WORDS
}

/** A draft the band offers to rank: not empty, not a slash command. (`rankable` adds the word floor.) */
export function isDraft(draft: string): boolean {
  const d = draft.trim()
  return d !== '' && !d.startsWith('/')
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

// The line shares a terminal row with the engine's prefix ("⚠ concierge-enhancer: "). Its width
// comes from the band's last drawing (bodyColumns); before any drawing it falls back to a fixed
// budget. A name that must shrink loses its middle, never either
// end (the owner's rule), and every name gets the same cap; only when even the shortest cap would
// not fit are the last skills counted as "+N".
const NAMES_BUDGET = 76
const MIN_NAME = 9
// The engine's prefix, the mark ("concierge ▸ ") and a two-column margin.
const STATUS_CHROME = '⚠ concierge-enhancer: '.length + 'concierge ▸ '.length + 2

/** The names budget of the status line on a terminal `columns` wide (0: unknown). */
export function statusBudget(columns: number): number {
  return columns > 0 ? Math.max(40, columns - STATUS_CHROME) : NAMES_BUDGET
}

export function middleCut(name: string, cap: number): string {
  if (name.length <= cap) return name
  const head = Math.ceil((cap - 1) / 2)
  const tail = cap - 1 - head
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`
}

function fitNames(skills: readonly string[], suffix: string, total = NAMES_BUDGET): string {
  const budget = total - suffix.length
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
export function sentStatus(row: OfferRow | null, budget = NAMES_BUDGET): StatusLine {
  if (row === null) return undefined
  const names = offeredNames(row)
  if (names.length > 0) return `concierge ✓ ${fitNames(names, '', budget)}`
  const text = sentText(row)
  return text === undefined ? undefined : `concierge ✓ ${text}`
}

/** The skill names an offer row carries, in order. */
function offeredNames(row: OfferRow): string[] {
  return Array.isArray(row.offered)
    ? row.offered.map(o => (Array.isArray(o) ? o[0] : o)).filter((n): n is string => typeof n === 'string' && n !== '')
    : []
}

/** What a row with no offered skills says: 'consult', 'no skill needed', or undefined. */
function sentText(row: OfferRow): string | undefined {
  if (row.band === 'consult_route') return 'consult'
  if (row.band === 'jev_skip' || row.band === 'getaway' || row.band === 'intent_skip') return 'no skill needed'
  return undefined
}

/** The band's menu for the menu the model got (the ✓ one); null where `sentStatus` shows nothing. */
export function sentMenu(row: OfferRow | null): BandMenu | null {
  if (row === null) return null
  const skills = offeredNames(row)
  if (skills.length > 0) return { mark: '✓', kind: 'skills', skills }
  const text = sentText(row)
  return text === undefined ? null : { mark: '✓', kind: 'text', text }
}

/**
 * The status line for a Preview. Literal forms (tests assert them):
 *   menu, ranked ticket -> 'concierge ▸ ui-styling · frontend-design · ak-test'
 *   any other menu      -> 'concierge ▸ ui-styling · frontend-design (preview)'
 *   no-skill           -> 'concierge ▸ no skill needed'
 *   consult            -> 'concierge ▸ consult'
 *   silent, empty menu -> undefined
 */
export function statusFor(preview: Preview, budget = NAMES_BUDGET): StatusLine {
  switch (preview.kind) {
    case 'menu':
      return preview.skills.length === 0
        ? undefined
        : `concierge ▸ ${fitNames(preview.skills, preview.wholeShelf ? '' : ' (preview)', budget)}`
    case 'no-skill':
      return 'concierge ▸ no skill needed'
    case 'consult':
      return 'concierge ▸ consult'
    case 'silent':
      return undefined
  }
}

/** The band's menu for a Preview (the ▸ one); null where `statusFor` shows nothing. */
export function menuFor(preview: Preview): BandMenu | null {
  switch (preview.kind) {
    case 'menu':
      return preview.skills.length === 0 ? null : { mark: '▸', kind: 'skills', skills: preview.skills }
    case 'no-skill':
      return { mark: '▸', kind: 'text', text: 'no skill needed' }
    case 'consult':
      return { mark: '▸', kind: 'text', text: 'consult' }
    case 'silent':
      return null
  }
}

// The band shows at most this many skills, one insert key each (digits 1 to MAX_INSERT).
export const MAX_INSERT = 5

/**
 * The labels of the band's insert buttons, fitted to `columns` cells (a terminal; a desktop passes
 * Infinity and gets whole names). `overhead` is what each item costs beside its name (the digit and
 * colon plus a gap, or a separator). A name that must shrink loses its middle; only when even the
 * shortest cap would not fit are the last skills left out, and `more` counts them.
 */
export type BandSlot = { readonly label: string; readonly index: number }

/**
 * The band's skill buttons laid out on up to `lines` rows of a terminal `columns` wide. Every name
 * keeps both ends; all names share one cap, the largest that fits; only when even MIN_NAME does not
 * fit are the last skills counted as "+N". `overhead` is the button chrome per slot ("1: " = 3).
 */
export function bandRows(
  skills: readonly string[],
  columns: number,
  overhead: number,
  lines: number,
): { rows: BandSlot[][]; more: number } {
  const all = skills.slice(0, MAX_INSERT)
  if (!Number.isFinite(columns)) return { rows: [all.map((label, index) => ({ label, index }))], more: skills.length - all.length }
  const width = columns - 2   // the "▸ " mark, or the indent under it
  const pack = (labels: string[], tail: number): BandSlot[][] | null => {
    const rows: BandSlot[][] = []
    let used = Infinity
    labels.forEach((label, index) => {
      const slot = label.length + overhead + 1
      if (used + slot > width) {
        rows.push([])
        used = 0
      }
      rows[rows.length - 1]?.push({ label, index })
      used += slot
    })
    return rows.length <= Math.max(1, lines) && used + tail <= width ? rows : null
  }
  for (let shown = all.length; shown >= 1; shown--) {
    const more = skills.length - shown
    const names = all.slice(0, shown)
    const longest = Math.max(...names.map(name => name.length))
    for (let cap = longest; cap >= Math.min(MIN_NAME, longest); cap--) {
      const rows = pack(names.map(name => middleCut(name, cap)), more > 0 ? ` +${more}`.length : 0)
      if (rows) return { rows, more }
    }
  }
  return { rows: [[{ label: middleCut(all[0] ?? '', MIN_NAME), index: 0 }]], more: skills.length - 1 }
}

// ── the Speculator ───────────────────────────────────────────────────────────────────────────

export class Speculator {
  // One owner for every piece of mod-side state: all fields are private to this class.
  private job: Job | null = null
  private timer: Timer | null = null
  private watch: Timer | null = null
  private runs = 0                          // enforcer runs since the last send (the cost cap)
  private autoRuns = 0                      // of those, the ones the settle timer started
  private isWorking = false
  private incompatible = false              // the located enforcer cannot speculate: stay inert
  private readonly intents = new Map<string, string>()   // draft -> intent, last 8 drafts
  private shownFor: string | null = null    // the exact draft the status line describes; null: no line
  private line: StatusLine = undefined      // the status line shown for `shownFor`
  private lineAt: ((budget: number) => StatusLine) | null = null   // rebuilds `line` for a new width
  private columns = 0                       // the terminal width the band last drew at (0: unknown)
  private menu: BandMenu | null = null      // the band's menu, shown and cleared with the line
  private hasDraft = false                  // the box holds a draft the band offers to rank
  private noteText: string | null = null    // the band's short message
  private lastDraft = ''                    // the draft `note` saw last: a message lives until it changes
  private inserted: string | null = null    // the box text right after the band's own last insert
  private published = JSON.stringify(EMPTY_VIEW)

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
   *   shorter than MIN_WORDS, once the enforcer proved unable to speculate, or with `autoRank` off;
   * - a run for a draft that is no longer the box's is killed at once.
   */
  note(draft: string): void {
    const d = draft.trim()
    this.hasDraft = isDraft(d)
    if (d === this.inserted) {
      // The band's own insert, echoed back as an edit: the same prompt, the menu stays, nothing to re-rank.
      this.syncWatch()
      this.publish()
      return
    }
    this.inserted = null
    if (this.shownFor !== null && d !== this.shownFor) this.show(undefined, null)
    if (d !== this.lastDraft) {
      this.lastDraft = d
      this.noteText = null
    }
    this.timer?.cancel()
    this.timer = null
    if (this.job && this.job.draft !== d) this.cancel()
    this.syncWatch()
    this.publish()
    if (this.options.autoRank === false || this.incompatible || this.isWorking || !rankable(d)) return
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
   * 3. The settle timer is cancelled, the status cleared, and the per-prompt run counts reset: a
   *    send is the only thing that ends a composed prompt (besides `end()`, which keeps the counts).
   * 4. After `go()` settles (the command hooks are done), every run is cancelled.
   */
  async send<R>(text: string, go: () => Promise<R>): Promise<R> {
    const sent = text.trim()
    try {
      if (this.job && (this.job.draft !== sent || this.job.stream === null)) this.cancel()
      this.timer?.cancel()
      this.timer = null
      this.show(undefined, null)
      this.hasDraft = false
      this.noteText = null
      this.inserted = null
      this.lastDraft = ''
      this.runs = 0
      this.autoRuns = 0
      this.syncWatch()
      this.publish()
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
   * The "Rank now" button: ranks the box's draft at once, through the same run as the automatic one
   * (`launch`), and shows the menu. Never throws; says why on the band when it ranks nothing:
   * a draft under MIN_WORDS, a running turn, an enforcer that cannot speculate, the cap.
   * A draft already ranked (or being ranked) is shown again and costs no run.
   */
  async rankNow(): Promise<void> {
    try {
      const draft = (await this.p.readPrompt()).text.trim()
      this.noteText = null
      if (this.incompatible) return this.say('This skill-concierge cannot rank drafts; update it')
      if (!rankable(draft)) return this.say(`Type a draft of ${MIN_WORDS} words or more`)
      if (this.isWorking) return this.say('A turn is running; rank after it ends')
      this.timer?.cancel()
      this.timer = null
      if (this.job && this.job.draft === draft && (!this.job.landed || this.job.preview)) {
        const job = this.job
        const preview = await job.done
        if (preview) await this.display(job, preview, draft)
        else this.say('Ranking failed; try again')
        return
      }
      if (this.runs >= MAX_RUNS_PER_PROMPT) return this.say(`Ranking limit reached for this prompt (${MAX_RUNS_PER_PROMPT})`)
      const outcome = await this.launch(draft)
      if (outcome === 'failed') this.say(this.incompatible ? 'This skill-concierge cannot rank drafts; update it' : 'Ranking failed; try again')
      else if (outcome === 'empty') this.say('Nothing to offer for this draft')
    } catch {
      this.say('Ranking failed; try again')
    }
  }

  /**
   * An insert key: puts `name` and a space into the box at the cursor, and keeps the menu that is
   * showing for the box as it is now, so several skills can go in one after another. Typing
   * clears the menu as always. The edit does not count as a new draft: it starts no ranking.
   */
  async insert(name: string): Promise<void> {
    const kept = { line: this.line, menu: this.menu, job: this.job }
    try {
      // A space before the name when the cursor sits right after a word, one after it always.
      const box = await this.p.readPrompt()
      const at = box.cursor ?? box.text.length
      const lead = at > 0 && !/\s/.test(box.text.charAt(at - 1)) ? ' ' : ''
      if (!(await this.p.insertText(`${lead}${name} `))) return this.say('The prompt box did not take the text')
      const after = (await this.p.readPrompt()).text.trim()
      this.inserted = after
      this.lastDraft = after
      this.hasDraft = isDraft(after)
      // An autocomplete raised by the fill itself may already have cancelled the run and cleared the menu.
      if (kept.job?.landed) {
        kept.job.draft = after
        this.job = kept.job
      }
      if (kept.line !== undefined && kept.menu !== null) this.show(kept.line, after, kept.menu)
      this.noteText = null
      this.syncWatch()
      this.publish()
    } catch {
      this.say('Could not insert the skill name')
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
      const row = findOffer(out, sid, sent)
      const line = sentStatus(row)
      if (line !== undefined && (await this.p.readPrompt()).text.trim() === '') this.show(b => sentStatus(row, b), '', sentMenu(row))
    } catch {
      // Display only: a missing or unreadable ledger leaves the line empty.
    }
  }

  /**
   * The session ended (a /clear too) or the module is rebuilt: cancel the timer and every run.
   * Idempotent. The run counts survive, so a /clear cannot buy a draft more runs: only a send resets them.
   */
  end(): void {
    this.timer?.cancel()
    this.timer = null
    this.cancel()
    this.show(undefined, null)
    this.hasDraft = false
    this.noteText = null
    this.inserted = null
    this.lastDraft = ''
    this.isWorking = false
    this.intents.clear()
    this.syncWatch()
    this.publish()
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  /**
   * The settle timer fired. Re-reads the box (the timer's draft may be stale), then starts one
   * run when the draft is rankable, differs from the latest run's, and the caps allow it (the
   * automatic run uses at most MAX_AUTO_RUNS of a prompt's MAX_RUNS_PER_PROMPT).
   * Shows the result only if the box still holds exactly that draft when it lands.
   */
  private async settle(): Promise<void> {
    this.timer = null
    try {
      const draft = (await this.p.readPrompt()).text.trim()
      if (this.options.autoRank === false || this.incompatible || this.isWorking || !rankable(draft)) return
      if (this.job && this.job.draft === draft) {
        // Typed a character and took it back: the latest run's ticket is still this draft's.
        const preview = this.job.preview
        if (preview && this.shownFor !== draft) this.show(b => statusFor(preview, b), draft, menuFor(preview))
        return
      }
      if (this.autoRuns >= MAX_AUTO_RUNS || this.runs >= MAX_RUNS_PER_PROMPT) return
      this.autoRuns++
      await this.launch(draft)
    } catch {
      // A failed read or status call costs the preview, never the prompt.
    }
  }

  /**
   * The one way a run starts, automatic or manual: spends a run, cancels the one in flight, starts
   * `draft`'s and shows its result if the box still holds exactly that draft when it lands.
   * 'shown': on the line and the band; 'empty': a result with nothing to show; 'failed': no
   * result; 'stale': superseded, or the draft moved on (nothing to say).
   */
  private async launch(draft: string): Promise<'shown' | 'empty' | 'failed' | 'stale'> {
    this.cancel()
    this.runs++
    const job = this.start(draft, this.runs)
    this.job = job
    this.publish()
    const preview = await job.done
    job.preview = preview
    this.publish()
    if (this.job !== job || this.isWorking) return 'stale'
    if (!preview) return 'failed'
    return this.display(job, preview, draft)
  }

  /** Shows `preview` for `draft` when the box still holds exactly it. */
  private async display(job: Job, preview: Preview, draft: string): Promise<'shown' | 'empty' | 'stale'> {
    if (this.job !== job || this.isWorking) return 'stale'
    if ((await this.p.readPrompt()).text.trim() !== draft) return 'stale'
    const line = statusFor(preview)
    if (line === undefined) return 'empty'
    this.noteText = null
    this.show(b => statusFor(preview, b), draft, menuFor(preview))
    return 'shown'
  }

  /** A short message on the band. */
  private say(text: string): void {
    this.noteText = text
    this.publish()
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
      landed: false,
      done: Promise.resolve(null),
    }
    job.done = this.run(job, n)
      .catch(() => null)
      .finally(() => {
        job.landed = true
      })
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
    if (job) {
      this.cancelJob(job)
      this.publish()
    }
  }

  private cancelJob(job: Job): void {
    job.abort.abort()
    job.killTimer?.cancel()
    job.killTimer = null
    // Not awaited: the engine ends the child when the stream is closed. A job that never
    // spawned has no stream, and its abort flag stops it before it would.
    void job.stream?.return({ code: null, signal: null }).catch(() => undefined)
  }

  /**
   * Pins `line` as this plugin's status (`$.ui.status`, one per plugin: no peer shares it) and
   * `menu` as the band's menu, both for the draft `forDraft`. Both go together.
   */
  /**
   * The band drew at `columns`: the status line is refitted to that width. Called while drawing, so
   * the line is re-sent from a timer and no state is written here.
   */
  setColumns(columns: number): void {
    if (!(columns > 0) || columns === this.columns) return
    this.columns = columns
    const lineAt = this.lineAt
    if (lineAt === null || this.shownFor === null) return
    this.p.after(0, () => {
      if (this.lineAt !== lineAt) return
      this.line = lineAt(statusBudget(this.columns))
      this.p.status(this.line)
    })
  }

  private show(at: StatusLine | ((budget: number) => StatusLine), forDraft: string | null, menu: BandMenu | null = null): void {
    this.lineAt = typeof at === 'function' ? at : null
    const line = typeof at === 'function' ? at(statusBudget(this.columns)) : at
    if (line === undefined && this.shownFor === null) return
    this.shownFor = line === undefined ? null : forDraft
    this.line = line
    this.menu = line === undefined ? null : menu
    this.p.status(line)
    this.syncWatch()
    this.publish()
  }

  /**
   * The guard timer runs while the status line or the band has something that depends on the
   * box: it must still hold the draft the line describes, and a band that offers to rank a
   * draft must not outlive that draft when an edit raised no `prompt.autocomplete`.
   */
  private syncWatch(): void {
    const needed = this.shownFor !== null || this.hasDraft
    if (needed && this.watch === null) this.watch = this.p.every(WATCH_MS, () => void this.verify())
    if (!needed && this.watch !== null) {
      this.watch.cancel()
      this.watch = null
    }
  }

  private async verify(): Promise<void> {
    try {
      const d = (await this.p.readPrompt()).text.trim()
      this.hasDraft = isDraft(d)
      if (this.shownFor !== null && d !== this.shownFor) this.show(undefined, null)
      this.syncWatch()
      this.publish()
    } catch {
      this.show(undefined, null)
    }
  }

  /** Hands the band its view; only when it differs from the last one handed over. */
  private publish(): void {
    const view: BandView = {
      hasDraft: this.hasDraft,
      busy: this.job !== null && !this.job.landed,
      menu: this.menu,
      note: this.noteText,
    }
    const key = JSON.stringify(view)
    if (key === this.published) return
    this.published = key
    try {
      this.p.band(view)
    } catch {
      // Display only.
    }
  }
}
