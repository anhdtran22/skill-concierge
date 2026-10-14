# ADR-0091: The Command Code mod resolves its root from an installer-written pointer

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-14 |
| **Supersedes** | none |
| **Amends** | ADR-0038 (the Command Code adapter's plugin-root resolution) |

## Context

`adapters/commandcode/install.sh` **copies** `skill-concierge.mod.ts` to
`~/.commandcode/mods/skill-concierge.ts`. Command Code loads a mod from its registered path, so
`__dirname` inside the installed copy is `~/.commandcode/mods` — and the mod's sibling candidate,
`resolve(__dirname, "../..")`, is the user's **home directory**, which contains no
`hooks/scripts/enforcer.py`.

Before this ADR the resolution order ended with a hardcoded personal checkout path:

```ts
const defaultPath = join(homedir(), "in-PROD/MY-WORKBENCH/skill-concierge");
if (existsSync(defaultPath)) return defaultPath;
return candidate;                       // = $HOME on an installed copy
```

That fallback can only ever be right on the maintainer's machine. Everywhere else
`PLUGIN_ROOT` degraded to `$HOME`, so `ENFORCER_SCRIPT` named a file that does not exist and the
mod's `spawnSync` calls failed. Because the mod is fail-open by design ("all handlers catch
exceptions and degrade to no-op"), the failure was **silent**: the SessionStart settings hooks
still ran (they carry absolute paths written by the installer), `install.sh` printed
`verify: OK` (its step 5a compares the copy for byte-identity, which says nothing about whether
the copy can resolve a root), and `doctor.py`'s `Command Code integration` row read `[✓]`. The
per-turn enforcer was simply dead: no `offer` row, no `search` row.

`scripts/smoke.py commandcode` is what caught it — FAIL without `SKILL_CONCIERGE_ROOT`, PASS
with it, same commit. Report and reproduction: issue #1.

## Decision

**The installer records the checkout path; the mod reads it.**

1. `install.sh` writes `~/.commandcode/skill-concierge-root` (the checkout root, one line,
   atomically through `adapters/lib/safe_write.py`, in the same commit phase as the other
   writes).
2. `resolvePluginRoot()` resolves in this order: `SKILL_CONCIERGE_ROOT` → the sibling `../..`
   (a dev copy still inside its checkout) → the pointer file. The hardcoded personal path is
   deleted.
3. **Every candidate must carry `hooks/scripts/enforcer.py`.** A candidate that does not is
   skipped rather than returned, so a home directory, a stale checkout or a dangling pointer
   falls through instead of arming the mod with scripts that are not there. This also means a
   `SKILL_CONCIERGE_ROOT` set to something useless no longer blocks a working pointer.
4. **The failure becomes loud.** `install.sh` step 5 gains a resolution check (env → sibling →
   pointer, the way the mod resolves) and fails the run when no root is reachable; `doctor.py`
   gains the same check as a finding on the `Command Code integration` row.

The copy stays byte-identical to the checkout's file, so step 5a keeps its meaning; the pointer,
not the mod's location, carries the machine-specific fact.

## Alternatives rejected

- **Bake the root into the copied mod.** Makes the copy a generated artifact: step 5a's
  byte-identity check would have to compare against generated content, and the deployed file
  would no longer be the file in the repo.
- **Symlink `~/.commandcode/mods/skill-concierge.ts` to the checkout's file** so `../..`
  resolves. Verified live: no effect — Command Code resolves the mod from its registered path,
  not the realpath, so `__dirname` is still `~/.commandcode/mods`.
- **Derive the root from `~/.commandcode/mcp.json`** (the installer already writes an absolute
  `<root>/bin/skill-search-mcp` there). Rejected as an implicit coupling: the mod would break
  whenever MCP is disabled or reconfigured, for a fact the installer can just state outright.
- **A settings-level `env` block in `~/.commandcode/settings.json`.** Verified live: Command
  Code does not propagate it to mods.

## Consequences

- A fresh clone + `./setup.sh` + `adapters/commandcode/install.sh` produces a **working**
  Command Code install with no environment variable, which was not true before.
- `SKILL_CONCIERGE_ROOT` keeps its meaning as the explicit dev override and still wins.
- The pointer is a new piece of install state under `~/.commandcode/`. It is rewritten on every
  installer run; nothing removes it on uninstall, and nothing reads it except this mod.
- An install made before this change keeps working as it did (via the env var) until the
  installer is re-run; re-running it writes the pointer.
- `doctor.py` now reports the silent case instead of `[✓]`, so the next version of this bug is
  visible in one command rather than only under a live smoke turn.
