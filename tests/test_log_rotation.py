"""The self-heal hooks' background logs must stay bounded.

auto_reindex, auto_flywheel and auto_overrides append a detached child's whole output to
one file per hook, forever. Observed 2026-10-11: auto-reindex.log had reached 237 MB
(2.38 M lines since 2026-07-06) and auto-flywheel.log 69 MB. Each hook now rotates its
log before it opens it: past the cap, the file moves to `.1`, older generations shift up,
and the oldest one past the keep count is dropped.
"""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hooks" / "scripts"))
import auto_flywheel as af  # noqa: E402
import auto_overrides as ao  # noqa: E402
import auto_reindex as ar  # noqa: E402
import selfheal  # noqa: E402


def _gens(log: Path) -> list[str]:
    return sorted(p.name for p in log.parent.iterdir() if p.name.startswith(log.name))


def test_rotate_leaves_a_log_under_the_cap_alone(tmp_path):
    log = tmp_path / "x.log"
    log.write_text("small\n")
    selfheal.rotate_log(log, max_bytes=100, keep=2)
    assert _gens(log) == ["x.log"]
    assert log.read_text() == "small\n"


def test_rotate_shifts_generations_and_drops_the_oldest(tmp_path):
    log = tmp_path / "x.log"
    log.write_text("c" * 200)
    (tmp_path / "x.log.1").write_text("b")
    (tmp_path / "x.log.2").write_text("a")
    selfheal.rotate_log(log, max_bytes=100, keep=2)
    assert _gens(log) == ["x.log.1", "x.log.2"]
    assert (tmp_path / "x.log.1").read_text() == "c" * 200
    assert (tmp_path / "x.log.2").read_text() == "b"


def test_rotate_tolerates_a_missing_log(tmp_path):
    selfheal.rotate_log(tmp_path / "absent.log", max_bytes=1, keep=2)
    assert list(tmp_path.iterdir()) == []


def _arm(mod, monkeypatch, tmp_path, name):
    monkeypatch.setattr(mod, "LOGDIR", tmp_path)
    monkeypatch.setattr(mod, "STAMP", tmp_path / f".{name}-stamp")
    monkeypatch.setattr(mod, "LOGFILE", tmp_path / f"{name}.log")
    monkeypatch.setattr(mod.subprocess, "Popen", lambda *a, **k: None)
    for attr in ("SS_BIN", "PY_BIN", "APPLIER", "FLYWHEEL_PY"):
        if hasattr(mod, attr):
            f = tmp_path / attr.lower()
            f.write_text("")
            f.chmod(0o755)
            monkeypatch.setattr(mod, attr, f)
    for attr, value in (("_mcp_env", lambda: ({}, "http://x")), ("_qdrant_up", lambda _u: True),
                        ("_flywheel_locked", lambda: False), ("_indexed_count", lambda: 1),
                        ("_disk_count", lambda: 1), ("_ping_ok", lambda: True)):
        if hasattr(mod, attr):
            monkeypatch.setattr(mod, attr, value)
    monkeypatch.setenv("FLYWHEEL_LLM_MODEL", "test-model")
    monkeypatch.setenv("SKILL_AUTO_FLYWHEEL", "1")
    big = mod.LOGFILE
    big.write_bytes(b"x" * (selfheal.LOG_MAX_BYTES + 1))
    return big


@pytest.mark.parametrize("mod,name", [(ar, "auto-reindex"), (af, "auto-flywheel"),
                                      (ao, "auto-overrides")])
def test_each_hook_rotates_an_oversized_log_before_appending(mod, name, monkeypatch, tmp_path):
    big = _arm(mod, monkeypatch, tmp_path, name)
    assert mod.main() == 0
    assert (tmp_path / f"{name}.log.1").stat().st_size == selfheal.LOG_MAX_BYTES + 1
    assert big.stat().st_size < 200, "the fresh log should hold only this run's header"
    assert big.read_text().lstrip().startswith(f"=== {name} ")
    assert os.path.exists(mod.STAMP)
