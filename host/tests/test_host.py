import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from networth_host import cli
from networth_host.cli import Api, Config, HerdrError, Host

RUN_ID = "1a2b3c4d-1111-4111-8111-111111111111"


def run(**over):
    base = {
        "id": RUN_ID,
        "account_ids": ["cash", "bofa-checking"],
        "status": "claimed",
        "cancel_requested": False,
        "agent_name": None,
        "agent_kind": None,
        "tab_id": None,
        "pane_id": None,
    }
    return {**base, **over}


class FakeHerdr:
    def __init__(self, screens=None, start_fails=(), agents=None, lifetime=50):
        self.lifetime = lifetime  # agent checks before the fake agent exits, so loops always end
        self.calls = []
        self.screens = screens or {}
        self.start_fails = set(start_fails)
        self.agents = dict(agents or {})
        self.kinds = {}
        self.tabs = 0

    def __call__(self, *args):
        self.calls.append(args)
        cmd = args[:2]
        if cmd == ("tab", "create"):
            self.tabs += 1
            n = self.tabs
            return {"result": {"tab": {"tab_id": f"w1:t{n}"}, "root_pane": {"pane_id": f"w1:p{n}"}}}
        if cmd == ("tab", "close"):
            return {}
        if cmd == ("agent", "start"):
            name, kind, pane = args[2], args[4], args[6]
            if kind in self.start_fails:
                raise HerdrError("timeout", "agent did not start")
            self.agents[name] = {"tab_id": pane.replace(":p", ":t"), "pane_id": pane, "agent": kind}
            self.kinds[name] = kind
            return {}
        if cmd == ("agent", "get"):
            self.lifetime -= 1
            if args[2] not in self.agents or self.lifetime < 0:
                raise HerdrError("agent_not_found", "gone")
            return {"result": {"agent": self.agents[args[2]]}}
        if cmd == ("agent", "read"):
            return self.screens.get(self.kinds.get(args[2]), "Working...")
        return {}

    def prompts(self):
        return [c for c in self.calls if c[:2] == ("agent", "prompt")]


class FakeApi:
    def __init__(self, server_run=None, claims=()):
        self.patches = []
        self.server_run = server_run or run(status="running")
        self.claims = list(claims)

    def claim(self, wait):
        return self.claims.pop(0)

    def patch(self, run_id, **fields):
        self.patches.append((run_id, fields))
        self.server_run = {**self.server_run, **fields}
        return self.server_run

    def get(self, run_id):
        if self.server_run is None:
            raise cli.ApiError(404, "Run not found.")
        return self.server_run


@pytest.fixture
def cfg(tmp_path):
    return Config(url="https://networth.example", state_dir=tmp_path, workspace="w1", cancel_timeout=60)


def host(cfg, herdr, api, clock=None):
    t = clock or [0.0]
    return Host(cfg, api, herdr, sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0])


def test_launches_claude_in_a_new_tab_with_the_run_instruction(cfg):
    herdr, api = FakeHerdr(), FakeApi()
    details = host(cfg, herdr, api).launch(run())
    assert details["agent_kind"] == "claude"
    assert details["agent_name"] == "finance-run-1a2b3c4d"
    assert details["tab_label"].startswith("Finance review 20")
    create = next(c for c in herdr.calls if c[:2] == ("tab", "create"))
    assert ["--workspace", "w1"] == list(create[2:4]) and "--no-focus" in create
    (prompt,) = herdr.prompts()
    assert RUN_ID in prompt[3] and "cash, bofa-checking" in prompt[3]
    assert f"networth-host report --run-id {RUN_ID}" in prompt[3]
    assert not any(c[:2] == ("tab", "close") for c in herdr.calls)


def test_falls_back_to_codex_when_claude_is_out_of_usage(cfg):
    herdr = FakeHerdr(screens={"claude": "You've hit your usage limit · resets 5pm"})
    details = host(cfg, herdr, FakeApi()).launch(run())
    assert details["agent_kind"] == "codex"
    assert ("tab", "close", "w1:t1") in herdr.calls
    assert len(herdr.prompts()) == 2


def test_falls_back_to_codex_when_claude_fails_to_start(cfg):
    herdr = FakeHerdr(start_fails={"claude"})
    details = host(cfg, herdr, FakeApi()).launch(run())
    assert details["agent_kind"] == "codex" and details["tab_id"] == "w1:t2"
    assert len(herdr.prompts()) == 1


def test_adopts_the_existing_agent_after_a_restart(cfg):
    herdr = FakeHerdr(agents={"finance-run-1a2b3c4d": {"tab_id": "w1:t7", "pane_id": "w1:p7", "agent": "claude"}})
    details = host(cfg, herdr, FakeApi()).launch(run())
    assert details["tab_id"] == "w1:t7" and details["agent_kind"] == "claude"
    assert not any(c[:2] in {("tab", "create"), ("agent", "prompt")} for c in herdr.calls)


def test_handle_reports_running_then_delivers_the_agents_report(cfg):
    herdr, api = FakeHerdr(), FakeApi()
    h = host(cfg, herdr, api)
    cli.queue_report(cfg.state_dir, RUN_ID, "done", "3 cash rows added")
    h.handle(run())
    statuses = [f.get("status") for _, f in api.patches]
    assert statuses == ["running", "done"]
    assert api.patches[-1][1]["summary"] == "3 cash rows added"
    assert not (cfg.state_dir / "reports" / f"{RUN_ID}.json").exists()


def test_cancel_prompts_the_agent_once_then_gives_up_after_the_timeout(cfg):
    herdr = FakeHerdr(agents={"finance-run-1a2b3c4d": {"tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "claude"}})
    api = FakeApi(run(status="running", cancel_requested=True, agent_name="finance-run-1a2b3c4d"))
    host(cfg, herdr, api).watch(RUN_ID, "finance-run-1a2b3c4d")
    (prompt,) = herdr.prompts()
    assert "canceled this run" in prompt[3] and f"--run-id {RUN_ID} --status canceled" in prompt[3]
    assert api.patches[-1][1]["status"] == "canceled"


def test_cancel_before_launch_never_starts_an_agent(cfg):
    herdr, api = FakeHerdr(), FakeApi()
    host(cfg, herdr, api).handle(run(cancel_requested=True))
    assert herdr.calls == [] and api.patches[0][1]["status"] == "canceled"


def test_an_agent_that_exits_without_reporting_fails_the_run(cfg):
    herdr, api = FakeHerdr(), FakeApi(run(status="running"))
    host(cfg, herdr, api).watch(RUN_ID, "finance-run-1a2b3c4d")
    assert api.patches == [(RUN_ID, {"status": "failed", "summary": "The agent exited without reporting."})]


NAME = "finance-run-1a2b3c4d"
ALIVE = {NAME: {"tab_id": "w1:t7", "pane_id": "w1:p7", "agent": "claude"}}


def remember(cfg, **over):
    state = {"run_id": RUN_ID, "agent_name": NAME, "agent_kind": "claude", "tab_id": "w1:t7", "pane_id": "w1:p7"}
    (cfg.state_dir / "active-run.json").write_text(json.dumps({**state, "tab_label": "Finance review", **over}))


def test_persists_the_run_and_agent_before_starting_the_agent(cfg):
    seen = []

    class Recording(FakeHerdr):
        def __call__(self, *args):
            if args[:2] == ("agent", "start"):
                seen.append(json.loads((cfg.state_dir / "active-run.json").read_text()))
            return super().__call__(*args)

    api = FakeApi()
    cli.queue_report(cfg.state_dir, RUN_ID, "done", "ok")
    host(cfg, Recording(), api).handle(run())
    assert seen and seen[0]["run_id"] == RUN_ID and seen[0]["agent_name"] == NAME
    assert seen[0]["tab_id"] == "w1:t1" and seen[0]["pane_id"] == "w1:p1"
    assert not (cfg.state_dir / "active-run.json").exists()


def test_restart_resumes_the_persisted_agent_instead_of_claiming(cfg):
    remember(cfg)
    herdr = FakeHerdr(agents=ALIVE)
    api = FakeApi(run(status="running", agent_name=NAME))  # no claims: claiming would fail
    cli.queue_report(cfg.state_dir, RUN_ID, "done", "resumed fine")
    cli.poll_once(cfg, host(cfg, herdr, api), api)
    assert ("agent", "get", NAME) in herdr.calls
    assert not any(c[:2] in {("tab", "create"), ("agent", "start"), ("agent", "prompt")} for c in herdr.calls)
    assert api.patches == [(RUN_ID, {"status": "done", "summary": "resumed fine"})]
    assert not (cfg.state_dir / "active-run.json").exists()


def test_restart_cancel_reaches_the_resumed_agent(cfg):
    remember(cfg)
    herdr = FakeHerdr(agents=ALIVE)
    api = FakeApi(run(status="running", agent_name=NAME, cancel_requested=True))
    cli.poll_once(cfg, host(cfg, herdr, api), api)
    (prompt,) = herdr.prompts()
    assert prompt[2] == NAME and "--status canceled" in prompt[3]
    assert not any(c[:2] == ("agent", "start") for c in herdr.calls)


def test_agent_lost_after_restart_fails_the_run_without_a_second_agent(cfg):
    remember(cfg)
    herdr = FakeHerdr()
    api = FakeApi(run(status="running", agent_name=NAME))
    cli.poll_once(cfg, host(cfg, herdr, api), api)
    assert api.patches == [(RUN_ID, {"status": "failed", "summary": cli.LOST})]
    assert "agent lost after host restart" in cli.LOST.lower()
    assert not any(c[:2] in {("tab", "create"), ("agent", "start")} for c in herdr.calls)
    assert not (cfg.state_dir / "active-run.json").exists()


def test_agent_lost_after_restart_with_a_cancel_pending_ends_canceled(cfg):
    remember(cfg)
    api = FakeApi(run(status="running", agent_name=NAME, cancel_requested=True))
    cli.poll_once(cfg, host(cfg, FakeHerdr(), api), api)
    assert api.patches == [(RUN_ID, {"status": "canceled", "summary": cli.LOST})]


def test_crash_between_agent_start_and_running_report_resumes_and_reports_running(cfg):
    remember(cfg)
    herdr = FakeHerdr(agents=ALIVE)
    api = FakeApi(run(status="claimed"))
    cli.queue_report(cfg.state_dir, RUN_ID, "done", "ok")
    cli.poll_once(cfg, host(cfg, herdr, api), api)
    assert api.patches[0] == (
        RUN_ID,
        {
            "status": "running",
            "agent_name": NAME,
            "agent_kind": "claude",
            "tab_id": "w1:t7",
            "pane_id": "w1:p7",
            "tab_label": "Finance review",
        },
    )
    assert not any(c[:2] == ("agent", "start") for c in herdr.calls)


def test_a_server_resume_without_local_state_never_starts_a_second_agent(cfg):
    herdr = FakeHerdr()
    api = FakeApi(claims=[(run(status="running", agent_name=NAME), True)])
    cli.poll_once(cfg, host(cfg, herdr, api), api)
    assert api.patches == [(RUN_ID, {"status": "failed", "summary": cli.LOST})]
    assert not any(c[:2] in {("tab", "create"), ("agent", "start")} for c in herdr.calls)


def test_a_resumed_run_that_ended_on_the_site_is_forgotten(cfg):
    remember(cfg)
    api = FakeApi(run(status="canceled", agent_name=NAME))
    herdr = FakeHerdr(agents=ALIVE)
    cli.poll_once(cfg, host(cfg, herdr, api), api)
    assert api.patches == [] and herdr.calls == []
    assert not (cfg.state_dir / "active-run.json").exists()


def test_a_resumed_run_missing_on_the_site_is_forgotten(cfg):
    remember(cfg)
    api = FakeApi()
    api.server_run = None
    cli.poll_once(cfg, host(cfg, FakeHerdr(agents=ALIVE), api), api)
    assert not (cfg.state_dir / "active-run.json").exists()


def test_a_fresh_claim_launches_and_forgets_the_run_when_it_ends(cfg):
    herdr = FakeHerdr()
    api = FakeApi(claims=[(run(), False)])
    cli.queue_report(cfg.state_dir, RUN_ID, "done", "ok")
    cli.poll_once(cfg, host(cfg, herdr, api), api)
    assert [f.get("status") for _, f in api.patches] == ["running", "done"]
    assert sum(c[:2] == ("agent", "start") for c in herdr.calls) == 1
    assert not (cfg.state_dir / "active-run.json").exists()


def test_report_validates_and_flattens_input(cfg):
    path = cli.queue_report(cfg.state_dir, RUN_ID, "failed", "line one\nline two")
    assert json.loads(path.read_text()) == {"status": "failed", "summary": "line one line two"}
    for bad in [("not-a-run", "done"), (RUN_ID, "running")]:
        with pytest.raises(ValueError):
            cli.queue_report(cfg.state_dir, *bad, "x")


class Handler(BaseHTTPRequestHandler):
    seen = []
    approve_after = 2

    def do_GET(self):
        Handler.seen.append((self.command, self.path, self.headers.get("Authorization")))
        n = sum(1 for s in Handler.seen if s[1] == "/api/finance-host/v1/session")
        if n < Handler.approve_after:
            return self.reply(401, {"error": "Enroll this host in Networth."})
        self.reply(200, {"state": "active"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Handler.seen.append((self.command, self.path, self.headers.get("Authorization"), body))
        self.reply(200, {"run": run(), "resume": True})

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


@pytest.fixture
def server():
    Handler.seen = []
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_api_claims_with_the_bearer_token(server):
    api = Api(server, lambda: "nw_" + "a" * 64)
    claimed, resume = api.claim(3)
    assert claimed["id"] == RUN_ID and resume is True
    assert Handler.seen[0] == ("POST", "/api/finance-host/v1/claim", "Bearer nw_" + "a" * 64, {"wait_seconds": 3})


def test_enroll_stores_the_token_first_then_waits_for_approval(server, tmp_path, capsys):
    stored = []
    receipt = cli.enroll(Config(url=server, state_dir=tmp_path), "Mac mini", store=stored.append, sleep=lambda s: None)
    token = stored[0]
    assert token.startswith("nw_") and len(token) == 67
    out = capsys.readouterr().out
    assert f"{server}/hosts#id=" in out and "kind=" not in out and token not in out
    assert all(s[2] == f"Bearer {token}" for s in Handler.seen)
    saved = json.loads((tmp_path / "enrollment.json").read_text())
    assert saved == json.loads(receipt.read_text()) and token not in receipt.read_text()
    assert "kind" not in saved and saved["url"] == server
