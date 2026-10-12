// concierge-enhancer v0.3: the wiring. A thin shell; every decision lives in ./speculator.ts.
//
// The mod observes the draft, has skill-concierge rank it while the person types (the enforcer's own
// path, Jev through jevd included) or when they press "Rank now", shows the result on this plugin's own
// status line and in a band above the prompt, and keeps the matching run alive across Enter so the
// UserPromptSubmit hook can serve that same ranking. Every hook but the band's passes its event on
// unchanged; the band composes: its rows, and beneath them whatever the rest of the chain drew.
import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import {
  EMPTY_VIEW,
  RANK_ACTION,
  SETTLE_MS,
  Speculator,
  bandRows,
  enabledPluginsOf,
  locateEnforcer,
  rankChordFrom,
} from './speculator'

// The band's drawing state. `$.state` survives a hot reload of this module; the Speculator that
// writes it does not, so a rebuilt Speculator starts by resetting `view`.
const view = atom({ plugin: 'concierge-enhancer', key: 'view' } as const, EMPTY_VIEW)
const rankChord = atom({ plugin: 'concierge-enhancer', key: 'chord' } as const, null)

// Runtime handles (a child process, a timer, an AbortController) cannot live in `$.state`, which
// holds plain data. A hot reload drops this value together with the timers it armed; the next
// session.start, or the first draft after a reload, builds a fresh one.
let speculator: Speculator | null = null

// Builds the Speculator for this session. Work that outlives a dispatch is started from
// session.start (reference.md, "Work that outlives a dispatch"); the Speculator keeps that `$`.
// session.start fires once per session, so a module reloaded mid-session (/reload-plugins, an
// update) never sees it: the first draft observed after such a reload builds the Speculator instead.
let booted = false

async function boot(
  $: Parameters<Hook<'session.start'>>[0],
  intent: boolean,
  settleMs: number,
  autoRank: boolean,
): Promise<void> {
  booted = true
  speculator?.end()
  try {
    // `$` stays in this file: the validator follows it only into same-file functions, so the
    // Speculator gets closures that spell each `$.noun.event(...)` here.
    const enforcer = await locateEnforcer({
      rootEnv: () => $.env.get('SKILL_CONCIERGE_ROOT'),
      configEnv: () => $.env.get('CLAUDE_CONFIG_DIR'),
      homeEnv: () => $.env.get('HOME'),
      cwd: () => $.session.cwd(),
      // Every settings source in precedence order, so the later one wins per plugin id; a source that
      // cannot be read counts as holding nothing (an unreadable answer never switches the mod off).
      enabledPlugins: async () => {
        const merged: Record<string, unknown> = {}
        for (const source of ['user', 'project', 'local', 'flag', 'policy'] as const) {
          Object.assign(merged, enabledPluginsOf(await $.settings.read({ source }).catch(() => ({}))))
        }
        return merged
      },
      isFile: path =>
        $.fs.stat(path).then(
          stat => stat.kind === 'file',
          () => false,
        ),
      readText: path => $.fs.read(path),
    })
    // No concierge install, or skill-concierge disabled in settings: the mod stays inert and concierge is unchanged.
    speculator = enforcer
      ? new Speculator(
          {
            readPrompt: () => $.prompt.read(),
            sessionId: () => $.session.id(),
            cwd: () => $.session.cwd(),
            messages: () => $.session.messages(),
            complete: (request, init) => $.model.complete(request, init),
            spawn: request => $.process.spawn(request),
            after: (ms, fn) => $.clock.after(ms, fn),
            every: (ms, fn) => $.clock.every(ms, fn),
            status: text => $.ui.status(text),
            band: next => void update($, view, () => next).catch(() => undefined),
            insertText: text => $.prompt.fill({ text, mode: 'insert' }).then(filled => filled.isFilled),
          },
          enforcer,
          {
            intent,
            settleMs,
            autoRank,
            ledger: `${((await $.env.get('SKILL_CONCIERGE_LOG')) || `${(await $.env.get('HOME')) ?? ''}/.claude/skill-concierge/logs`).replace(/\/+$/, '')}/skill-invocation-ledger.log`,
          },
        )
      : null
    // A rebuilt Speculator starts from an empty band, and the band shows the chord as the person bound it.
    await update($, view, () => EMPTY_VIEW)
    const dir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`).replace(/\/+$/, '')
    const keybindings = await $.fs.read(`${dir}/keybindings.json`).then(String, () => null)
    await update($, rankChord, () => rankChordFrom(keybindings))
  } catch {
    speculator = null
  }
}

export const register: Register = (on, options) => {
  // The `enabled` option off: no hook is registered, so the mod does nothing and concierge ranks
  // each prompt at send time as it does without this mod. A change in the config menu reloads this.
  if (options.enabled === false) return
  // Off unless set: the intent gate did not beat the plain draft (see the `intent` option in plugin.json).
  const intent = options.intent === true
  // The pause before a draft is ranked, from /config (seconds); out of range or unset: SETTLE_MS.
  const pause = typeof options.pauseSeconds === 'number' ? options.pauseSeconds : NaN
  const settleMs = pause >= 0.5 && pause <= 30 ? Math.round(pause * 1000) : SETTLE_MS
  // Off: a settled draft is not ranked by itself; only the band's "Rank now" ranks. On unless set.
  const autoRank = options.autoRank !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await boot($, intent, settleMs, autoRank)
    return started
  })

  // The draft observer (probe P6: fires while typing, and the engine does not wait on it).
  // Observe only: other plugins' suggestions pass through untouched.
  on('prompt.autocomplete', ($, e, next) => {
    if (booted) speculator?.note(e.text)
    else void boot($, intent, settleMs, autoRank).then(() => speculator?.note(e.text))
    return next(e)
  })

  // A running turn changes the context Jev reads (the last assistant text), so nothing is ranked
  // while one runs; the draft is ranked once it ends. A subagent's loop raises turn.complete too,
  // with `agentId` set and no turn.start of its own: only the main loop's end resumes ranking.
  on('turn.start', ($, e, next) => {
    speculator?.working(true)
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) speculator?.working(false)
    return next(e)
  })

  // Enter. `next(e)` runs the UserPromptSubmit command hooks (probe P5), concierge's enforcer
  // among them. The event passes on exactly as received: no text rewrite, no added context.
  // Only the person's own Enter is wrapped; notifications, peers and plugins pass straight through.
  // This site can refuse a prompt, so it carries a `.catch`: a failure here lets the prompt go on.
  on('prompt.submit', ($, e, next) =>
    e.origin.kind === 'composer' && speculator ? speculator.send(e.text, () => next(e)) : next(e),
  ).catch(($, e, next) => next(e))

  // The band above the prompt: drawn while the box holds a draft or a menu (▸ ranked draft, ✓ the
  // menu the model got) is showing. It composes with the rest of the chain: it draws its own rows and
  // the drawing beneath them (`next(e)`), whoever drew that, and it yields to a survey.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = await read($, view)
    if (e.props.maxRows < 1 || !(shown.hasDraft || shown.menu !== null)) return next(e)
    const chord = await read($, rankChord)
    const below = await next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const { menu } = shown
    // A bare digit typed into an EMPTY box presses a band button (d.ts, Button `hotkey`), so digit keys
    // exist only while the ▸ menu of a draft in the box is up; the ✓ menu is shown over an empty box.
    const digits = menu !== null && menu.mark === '▸' && shown.hasDraft
    const names = menu?.kind === 'skills' ? menu.skills : []
    if (isTerminal) speculator?.setColumns(e.props.bodyColumns)
    // The menu takes one row, or two when the band has room: the line under the rank button stays one.
    const lines = Math.max(1, Math.min(2, e.props.maxRows - 1))
    const { rows, more } = bandRows(names, isTerminal ? e.props.bodyColumns : Infinity, digits ? 3 : 1, lines)

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>concierge </Text>
          {/* Not awaited: a ranking can outlast the 10s ui.press budget; the Speculator guards re-entry. */}
          <Button key="rank" label="Rank now" hotkey="r" action={RANK_ACTION} variant="primary" onPress={() => void speculator?.rankNow()} />
          {shown.busy ? <Text dimColor> ranking…</Text> : null}
          {isTerminal && chord ? <Text dimColor>  {chord} rank now</Text> : null}
          {shown.note ? (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {shown.note}
            </Text>
          ) : null}
        </Box>
        {menu !== null && e.props.maxRows >= 2
          ? (menu.kind === 'text' ? [[]] : rows).map((row, r) => (
              <Box key={`menu-${r}`}>
                <Text dimColor>{r === 0 ? `${menu.mark} ` : '  '}</Text>
                {menu.kind === 'text' ? (
                  <Text dimColor>{menu.text}</Text>
                ) : (
                  row.map(({ label, index }) => (
                    <Box key={`slot-${index + 1}`}>
                      <Button
                        key={`insert-${index + 1}`}
                        label={label}
                        plain
                        hotkey={digits ? String(index + 1) : undefined}
                        onPress={() => void speculator?.insert(names[index] ?? '')}
                      />
                      <Text> </Text>
                    </Box>
                  ))
                )}
                {more > 0 && r === rows.length - 1 ? <Text dimColor>+{more}</Text> : null}
              </Box>
            ))
          : null}
        {below}
      </Box>
    )
  })

  // `reason: 'clear'` raises session.end with no session.start after it, so the Speculator stays
  // usable: end() only drops its timers, runs and status, and the next run reads the new session id.
  on('session.end', ($, e, next) => {
    speculator?.end()
    return next(e)
  })
}
