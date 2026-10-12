# concierge-enhancer v0.2: the draft-time ticket (synthesized design, build contract)

Base: `arena/candidate-opus/` (read its `rationale.md` and `sketch/` in full; this file overrides it where they differ). Grounding: `grounding.md`, `grounding-explained.md`. Decision trail: `decisions.tsv`.

## One paragraph

While the person types, the mod waits for a settled draft, writes a one-line intent with the session's small model, and runs concierge's own `enforcer.py` on that draft in **speculate** mode, under the real session id and transcript, through the same lanes and the same Jev route via jevd. That run writes a **ticket** (Python to Python; the mod never touches it) holding its Jev verdict for exactly that text, and prints a preview the mod pins with `$.ui.status`. At Enter, the UserPromptSubmit hook finds the ticket for exactly the sent text, checks the conversation context and ranking settings are unchanged, and serves that verdict instead of calling Jev again (or waits for a run still in flight, never past today's Jev deadline). Everything after the Jev leg (retrieval, gates, annexes, render, ledger) runs unchanged. One ranking, one menu; the preview is that menu by construction. No band, no hotkey, no prompt rewrite, no added model context: nothing to collide with.

## Synthesis decision

- **Base: opus.** Cleanest ownership (the ticket is written and read only by Python), the smallest mod surface (`$.ui.status` only), a hook that redeems only the Jev leg (so lanes, keep-off, blocklist, annexes and chain hints stay live), an explicit deadline invariant, and the context and environment fingerprints that make a stale verdict impossible to serve.
- **Convergence:** all four runners (opus, fable, sonnet, haiku) independently chose the same whole shape: rank the settled draft through the enforcer's own Jev route before Enter, reuse it at Enter, drop the Enhance band. Each named a structurally different alternative and rejected it (TypeScript jevd client; submit-time context injection; fixed v0.67.0 band; synchronous submit-time ranking; hook-only cache). That agreement is the signal; this is a consensus shape with grafts, not an average.
- **Grafts:**
  - from **sonnet**: (1) skip speculation for drafts that match the enforcer's secret patterns (`_JEV_SECRET_RES`); (2) store a verdict only when Jev reached the **full** stage (a wide-only or failed route settles `unranked`, so the hook gets its own full-budget chance and keeps the ADR-0087 wide safety net); (3) one `{"ev":"speculate", …}` ledger row per speculative run, so wasted runs are countable (`analyze.py` ignores unknown `ev`); (4) a test that the mod's minimum word count equals the enforcer's `MAX_SHORT_WORDS + 1`.
  - from **fable**: record `jev.src: "ticket"` and `jev.age_ms` on a served turn; a 1.0 s settle (between fable's 1.2 s and opus's 0.7 s).
  - from **haiku**: a golden test that a session without the mod produces offer rows and output identical to before (no `spec`, no `via`).
- **Rejected:** fable's mod-written handoff at Enter and its `AbovePrompt` row and `PromptHint` tail (shared surfaces; the status line is per plugin); sonnet's per-digest artifact files and pending markers (opus's one ticket per session with a sent-text hash does the same with less); haiku's whole-menu replay (serves draft-time lanes and annexes; a second offer path).

## Decisions taken on the owner's behalf (AFK, logged in decisions.tsv)

1. **The visible Enhance rewrite is removed.** The owner's goal is the menu; the A/B ranked the full rewrite worst; the rewrite is the standalone prompt-enhancer's job and kept the contested band and hotkey. The useful part, the intent line, now runs automatically as a hidden ranking input.
2. **Unsent drafts reach Jev (through jevd, keyless, the owner's approved Command Code / TypeSafe channels) and the session's small model (Max).** Mitigations: a 1.0 s settle, a ≥4-word floor, the secret-pattern guard, at most **3** speculative runs per composed prompt, and two kill switches: `ENFORCER_TICKET=0` (hook ignores tickets, speculative runs write none) and the mod's own userConfig `enabled` / `intent` options. Reversible; flagged for the owner.
3. **Intent writer = `haiku`, gated.** It is untested as the generator (the A/B used sonnet/fork). The A/B harness is re-run with the haiku writer before release; if raw+intent does not beat raw head to head with no empty menus, the intent option ships default **off**.

## Contract between the two halves (exact)

**Mod → enforcer (speculative run).** `python3 <enforcer.py>` with stdin JSON
`{"prompt": <draft, trimmed>, "session_id": <$.session.id()>, "cwd": <session cwd>, "speculate": {"intent": <string, '' when none>, "n": <run count for this composed prompt, 1-based>}}`
and env `{"SKILL_CONCIERGE_HARNESS": "claude", "ENFORCER_LEDGER": "defer"}` laid over the host env. `transcript_path` is absent; the enforcer finds it by session id (`offer_ticket.find_transcript`).

**Enforcer → mod.** The last stdout line is one JSON object carrying
`"skillConciergeSpeculation": {"v": 1, "ticket": "ranking"|"ranked"|"unranked"|"none", "preview": {"kind": "menu"|"no-skill"|"consult"|"silent", "skills": [<names, the main menu rows in order, ≤5>], "whole_shelf": <bool>}}`.
`kind` derives from the band the run reached: an offer → `menu`; `jev_skip` / a `SKILL-CHECK` skip → `no-skill`; `consult_route` → `consult`; every silent or lane exit → `silent`. A mod that does not find this key treats the enforcer as incompatible and goes inert for the session.

**Ticket (private to `hooks/scripts/offer_ticket.py`).** One file per session, `~/.claude/skill-concierge/route-hints/<sid>.ticket.json`, atomic writes, fields `{v, sid, qh (sha256 of the stripped sent text), intent, state, made, deadline, pid, ctx, env, n, verdict}`; `verdict` = `_jev_route`'s `(result, event)` as JSON. API: `route_text`, `fingerprint_ctx`, `fingerprint_env`, `find_transcript`, `open_ticket`, `settle`, `find`, `redeem` (see the opus sketch for each docstring; keep them).

## Enforcer changes (`hooks/scripts/enforcer.py`)

- Read `speculate` from stdin; a module flag marks the run speculative. A speculative run: forces defer (never an `offer` row; it appends one `ev:"speculate"` row with `sid, n, intent: bool, ticket state, jev stage, ms`), never reads a ticket, opens one after the lanes pass (state `ranking` if Jev starts, else `unranked`), settles it when its Jev job joins (`ranked` only for a full-stage result), skips Jev and writes no ticket when the draft matches `_JEV_SECRET_RES`, and prints `skillConciergeSpeculation` as its last stdout line.
- Hook path: `offer_ticket.find(sid, prompt)` first (read-only); the lanes judge the sent text unchanged; the ranked text is `route_text(sent, ticket.intent)`; deterministic routes match the **sent** text only; `_jev_start(prompt, tp, ticket)` redeems inside the worker and falls back to a live `_jev_route(..., deadline=<the same deadline>)` with the time left.
- Offer row on a ticketed turn: `via:"enhancer"`, `q` = sent text (pairs with the turn row), `rq` = ranked text when an intent was used, `spec = {st, age_ms, wait_ms, n, intent}`, `jev.src:"ticket"`, `jev.age_ms`.
- Delete `ROUTE_HINTS`, `ROUTE_HINT_TTL`, `_route_hint` and `tests/test_enforcer_route_hint.py`; replace with `tests/test_offer_ticket.py`.
- New flag `ENFORCER_TICKET` (default ON), hook-side: add it to the AGENTS.md *Runtime flags* per-turn table and to `docs/runtime-flags.md` (driftcheck enforces parity).
- Python 3.9 compatible; stdlib only; every new path fail-silent: any error means today's behaviour.

## Mod (`adapters/claude-code/mod/`)

- `hooks/register.tsx`: `session.start` (build the Speculator with the `$` of that dispatch, locate the enforcer: `SKILL_CONCIERGE_ROOT` env, else the **highest-version** `skill-concierge@*` entry in `installed_plugins.json`), `prompt.autocomplete` (`note(e.text)`, pass through), `turn.start` / `turn.complete` (pause / resume), `prompt.submit` with `origin.kind === 'composer'` (`send(text, () => next(e))`, never altering `e`), `session.end` (`end()`). Every gate hook has a `.catch` that passes through.
- `hooks/speculator.ts`: one class; settle 1000 ms; rankable = ≥4 words, not starting with `/`, not empty; one run in flight, latest draft wins; ≤3 runs per composed prompt; intent via `$.model.complete({model:'haiku', timeoutMs: 2500, ...})` with the standing rules (name no skills, keep the author's terms verbatim, ask nothing, one sentence); spawn the enforcer (killable); pin `$.ui.status("concierge ▸ a · b · c · d · e")` only while the box still holds that exact draft; clear on edit, on Enter, on turn start. On Enter, cancel runs for other text, keep the matching run alive until `next(e)` settles, then cancel all.
- Remove: the `AbovePrompt` band, the Enhance button and hotkey, `$.prompt.fill`, the rewrite prompt, `rankMenu`, `routeHintFor` / `leaveRouteHint`, the keybinding reader. Bump the mod to `0.2.0`.
- userConfig options `enabled` (default true) and `intent` (default per the gate) if the manifest supports `userConfig`; else module constants.

## Verification (release gates)

- Python: `tests/test_offer_ticket.py` per opus plan B1-B9 plus the grafts (full-stage-only, secret skip, speculate row, golden no-mod rows); the full suite; `test_python39_hooks`, `test_hook_definitions_pinned` unchanged.
- Mod: `claude plugin test adapters/claude-code/mod` per opus plan A1-A10, including an inline peer band plugin that does not compose and binds hotkey `e` (coexistence by construction); `claude plugin validate` lists no `ui.render`.
- One live drive in tmux: type, settle, see the status, Enter; the offer row has `spec.st` `ready` (or `waited`) and `jev.src: "ticket"`, its bullet names equal the status names, and it pairs with its turn row. Report Enter→model latency vs a no-mod turn as measured, not as a target. The coexistence drive with the old prompt-enhancer waits for the owner (his order).
- Intent gate (haiku) as above. Release: bump, driftcheck, commit, `adapters/install-all.sh` (smoke), push only if green, reinstall from GitHub.
