"""The enforcer ranks the concierge-enhancer mod's route hint instead of the prompt as sent,
only for the exact prompt the hint names, only while it is fresh, and only once."""
import json
import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROMPT = "Write a docker compose file for postgres with a named volume and a health check."
ROUTE = "write a docker compose file for postgres\n\nAuthor a Docker Compose YAML file for a PostgreSQL service."


def run(tmp_path, prompt, sid="sess-1"):
    env = {**os.environ, "HOME": str(tmp_path), "SKILL_CONCIERGE_LOG": str(tmp_path / "logs"),
           "ENFORCER_LEDGER": "1", "ENFORCER_JEV_ROUTER": "0", "SKILL_OWNER_AUTOSTART": "0"}
    r = subprocess.run(["python3", str(ROOT / "hooks" / "scripts" / "enforcer.py")],
                       input=json.dumps({"prompt": prompt, "session_id": sid}),
                       capture_output=True, text=True, timeout=60, env=env)
    assert r.returncode == 0
    ledger = tmp_path / "logs" / "skill-invocation-ledger.log"
    rows = [json.loads(l) for l in ledger.read_text().splitlines()] if ledger.exists() else []
    return [row for row in rows if row.get("ev") == "offer"]


def hint(tmp_path, sid="sess-1", prompt=PROMPT, route=ROUTE, age=0.0):
    d = tmp_path / ".claude" / "skill-concierge" / "route-hints"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{sid}.json"
    path.write_text(json.dumps({"prompt": prompt, "route": route, "t": time.time() - age}))
    return path


def test_a_fresh_matching_hint_routes_the_turn_and_is_consumed(tmp_path):
    path = hint(tmp_path)
    [row] = run(tmp_path, PROMPT)
    assert row["q"] == PROMPT[:120]    # as sent, so the offer still pairs with its turn row by (sid, q)
    assert row["rq"] == ROUTE[:120]
    assert row["via"] == "enhancer"
    assert not path.exists()


def test_surrounding_whitespace_on_the_hinted_prompt_still_matches(tmp_path):
    hint(tmp_path, prompt=PROMPT + "\n")
    [row] = run(tmp_path, PROMPT)
    assert row["via"] == "enhancer"


def test_a_hint_with_a_non_finite_time_is_dropped_unused(tmp_path):
    d = tmp_path / ".claude" / "skill-concierge" / "route-hints"
    d.mkdir(parents=True)
    (d / "sess-1.json").write_text('{"prompt": %s, "route": %s, "t": NaN}' % (json.dumps(PROMPT), json.dumps(ROUTE)))
    [row] = run(tmp_path, PROMPT)
    assert "via" not in row
    assert not (d / "sess-1.json").exists()


def test_a_hint_is_consumed_even_when_an_early_lane_ends_the_turn(tmp_path):
    path = hint(tmp_path, prompt="ok thanks")
    assert run(tmp_path, "ok thanks") == []    # too short to rank: no offer row at all
    assert not path.exists()


def test_a_hint_for_another_prompt_is_dropped_unused(tmp_path):
    path = hint(tmp_path, prompt="some earlier prompt the user never sent")
    [row] = run(tmp_path, PROMPT)
    assert row["q"] == PROMPT[:120]
    assert "via" not in row
    assert not path.exists()


def test_a_stale_hint_is_dropped_unused(tmp_path):
    path = hint(tmp_path, age=3600)
    [row] = run(tmp_path, PROMPT)
    assert row["q"] == PROMPT[:120]
    assert "via" not in row
    assert not path.exists()


def test_a_session_id_that_is_not_a_plain_name_reads_no_file(tmp_path):
    path = hint(tmp_path, sid="sess-1")
    [row] = run(tmp_path, PROMPT, sid="../route-hints/sess-1")
    assert "via" not in row
    assert path.exists()


def test_no_hint_leaves_the_prompt_as_sent(tmp_path):
    [row] = run(tmp_path, PROMPT)
    assert row["q"] == PROMPT[:120]
    assert "via" not in row
