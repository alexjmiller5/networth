import json

import pytest
from test_host import NAME, RUN_ID, FakeApi, run

from networth_host import cli
from networth_host.cli import Config, Core, HerdrError, NativeHost


class FakeCore:
    def __init__(self):
        self.calls = []
        self.record = None
        self.status = "idle"
        self.started = True
        self.send_error = None

    def rpc(self, method, **params):
        self.calls.append((method, params))
        if method == "doc.get":
            return {"value": {"spaces": [{"id": "space-example"}]}}
        if method == "terminal.get":
            if self.record is None:
                raise HerdrError("not_found", "missing")
            return self.record
        if method == "terminal.run":
            self.record = {
                "address": "t9",
                "state": "live",
                "labels": {**params["labels"], "session.id": "session-original"},
            }
            return self.record
        if method == "terminal.wait":
            return {"status": self.status, "reason": "status"}
        if method == "terminal.send":
            if self.send_error:
                raise HerdrError(self.send_error, "not acknowledged")
            return {"started": self.started}
        raise AssertionError(method)


@pytest.fixture
def native(tmp_path):
    cfg = Config(url="https://networth.example", state_dir=tmp_path, workspace="space-example", runtime="core")
    core = FakeCore()
    clock = [0.0]
    return NativeHost(
        cfg, FakeApi(), core, sleep=lambda s: clock.__setitem__(0, clock[0] + s), clock=lambda: clock[0]
    ), core


def test_native_launch_uses_owned_space_and_idle_only_send(native):
    host, core = native
    details = host.launch(run())
    params = next(p for m, p in core.calls if m == "terminal.run")
    assert params["argv"] == ["claude"]
    assert params["name"] == NAME and params["no_parent"] and params["no_notify"]
    assert params["labels"]["networth.run"] == RUN_ID
    assert params["labels"]["herdr.space"] == "space-example"
    assert params["env"] == {"NETWORTH_URL": host.cfg.url, "NETWORTH_HOST_STATE_DIR": str(host.cfg.state_dir)}
    send = next(p for m, p in core.calls if m == "terminal.send")
    assert send["terminal"] == "t9" and send["if"] == "idle"
    assert "cash, bofa-checking" in send["text"]
    assert "tab_id" not in details and "pane_id" not in details
    assert host.active()["native_phase"] == "delivered"


def test_native_receipt_precedes_creation_and_send(native):
    host, core = native
    rpc = core.rpc

    def checked(method, **params):
        if method in ("terminal.run", "terminal.send"):
            assert host.active()["native_phase"] == ("starting" if method == "terminal.run" else "delivering")
        return rpc(method, **params)

    core.rpc = checked
    host.launch(run())


@pytest.mark.parametrize("status", [None, "working", "blocked", "error"])
def test_native_startup_failure_preserves_one_blank_terminal(native, status):
    host, core = native
    core.status = status
    with pytest.raises(HerdrError):
        host.launch(run())
    assert host.active()["native_phase"] == "blank"
    assert sum(m == "terminal.run" for m, _ in core.calls) == 1
    assert not any(m in ("terminal.send", "terminal.kill") for m, _ in core.calls)


def test_native_blank_restart_reuses_terminal_and_sends_once(native):
    host, core = native
    core.status = "blocked"
    with pytest.raises(HerdrError):
        host.launch(run())
    core.status = "idle"
    host.launch(run())
    host.launch(run())
    assert sum(m == "terminal.run" for m, _ in core.calls) == 1
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1


def test_native_lost_creation_ack_adopts_owned_terminal_without_respawn(native):
    host, core = native
    rpc = core.rpc

    def lost_creation(method, **params):
        result = rpc(method, **params)
        if method == "terminal.run":
            raise HerdrError("unavailable", "creation acknowledgement lost")
        return result

    core.rpc = lost_creation
    with pytest.raises(HerdrError):
        host.launch(run())
    core.rpc = rpc
    host.launch(run())
    assert sum(m == "terminal.run" for m, _ in core.calls) == 1
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1


@pytest.mark.parametrize("outcome", ["lost", "not_started"])
def test_native_uncertain_delivery_never_replays(native, outcome):
    host, core = native
    core.send_error = "unavailable" if outcome == "lost" else None
    core.started = False
    for _ in range(2):
        with pytest.raises(HerdrError, match="uncertain_delivery"):
            host.launch(run())
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1
    assert host.active()["native_phase"] == "delivering"


def test_native_wrong_run_or_changed_session_is_never_adopted(native):
    host, core = native
    host.launch(run())
    core.record["labels"]["networth.run"] = "different-run"
    with pytest.raises(HerdrError, match="unsafe_adoption"):
        host.alive(NAME)
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1


def test_native_changed_conversation_is_never_adopted(native):
    host, core = native
    host.launch(run())
    core.record["labels"]["session.id"] = "session-other"
    with pytest.raises(HerdrError, match="unsafe_adoption"):
        host.alive(NAME)


def test_native_reused_name_cannot_adopt_a_different_terminal(native):
    host, core = native
    host.launch(run())
    core.record["address"] = "t-other"
    with pytest.raises(HerdrError, match="unsafe_adoption"):
        host.alive(NAME)


def test_native_restart_reports_only_existing_public_api_fields(native):
    host, core = native
    host.launch(run())
    cli.queue_report(host.cfg.state_dir, RUN_ID, "done", "synthetic result")
    host.handle(run())
    fields = host.api.patches[0][1]
    assert fields == {"status": "running", "agent_name": NAME, "agent_kind": "claude", "tab_label": host.label()}
    assert not any(k.startswith("native_") or k == "runtime" for k in fields)
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1


def test_native_uncertain_handle_keeps_receipt_and_does_not_claim_running(native):
    host, core = native
    core.send_error = "unavailable"
    with pytest.raises(HerdrError, match="uncertain_delivery"):
        host.handle(run())
    assert host.active()["native_phase"] == "delivering"
    assert host.api.patches == []


def test_native_rejects_existing_legacy_receipt_before_core_access(native):
    host, core = native
    host.remember(RUN_ID, {"agent_name": NAME, "tab_id": "w1:t1"})
    with pytest.raises(HerdrError, match="legacy"):
        host.handle(run())
    assert core.calls == []


def test_native_other_run_cannot_consume_or_forget_the_active_receipt(native):
    host, core = native
    host.launch(run())
    calls = len(core.calls)
    with pytest.raises(HerdrError, match="unsafe_adoption"):
        host.handle(run(id="other-run", cancel_requested=True))
    assert host.active()["run_id"] == RUN_ID and len(core.calls) == calls
    assert host.api.patches == []


def test_native_blank_handle_resumes_without_another_launch(native):
    host, core = native
    core.status = "blocked"
    with pytest.raises(HerdrError):
        host.handle(run())
    core.status = "idle"
    rpc = core.rpc

    def report_after_send(method, **params):
        result = rpc(method, **params)
        if method == "terminal.send":
            cli.queue_report(host.cfg.state_dir, RUN_ID, "done", "synthetic result")
        return result

    core.rpc = report_after_send
    host.handle(run())
    assert sum(m == "terminal.run" for m, _ in core.calls) == 1
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1


def test_native_cancel_waits_for_idle_without_typing_over_work(native):
    host, core = native
    host.launch(run())
    core.status = "working"
    host.api = FakeApi(run(status="running", cancel_requested=True))
    host.handle(run(status="running", cancel_requested=True))
    assert host.api.patches[-1][1]["status"] == "canceled"
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1
    assert not any(m == "terminal.kill" for m, _ in core.calls)


def test_native_queued_report_ends_blank_startup_without_sending(native):
    host, core = native
    core.status = "blocked"
    with pytest.raises(HerdrError):
        host.handle(run())
    cli.queue_report(host.cfg.state_dir, RUN_ID, "done", "synthetic result")
    host.handle(run())
    assert not any(m == "terminal.send" for m, _ in core.calls)
    assert host.api.patches == [(RUN_ID, {"status": "done", "summary": "synthetic result"})]


def test_native_existing_terminal_without_receipt_is_not_prompted(native):
    host, core = native
    host.launch(run())
    host.forget()
    with pytest.raises(HerdrError, match="unsafe_adoption"):
        host.launch(run())
    assert sum(m == "terminal.run" for m, _ in core.calls) == 1
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1


def test_native_cancel_is_persisted_and_not_repeated_after_lost_ack(native):
    host, core = native
    host.launch(run())
    core.send_error = "unavailable"
    with pytest.raises(HerdrError):
        host.cancel_prompt(NAME, RUN_ID)
    host.cancel_prompt(NAME, RUN_ID)
    assert sum(m == "terminal.send" for m, _ in core.calls) == 2


@pytest.mark.parametrize("replacement", ["session", "terminal"])
def test_native_cancel_revalidates_ownership_after_readiness(native, replacement):
    host, core = native
    host.launch(run())
    rpc = core.rpc

    def replaced(method, **params):
        result = rpc(method, **params)
        if method == "terminal.wait":
            if replacement == "session":
                core.record["labels"]["session.id"] = "replacement"
            else:
                core.record["address"] = "t-replacement"
        return result

    core.rpc = replaced
    with pytest.raises(HerdrError, match="unsafe_adoption"):
        host.cancel_prompt(NAME, RUN_ID)
    # The only send was the original launch, never cancellation to the replacement.
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1
    host.cancel_prompt(NAME, RUN_ID)
    assert sum(m == "terminal.send" for m, _ in core.calls) == 1


def test_native_requires_explicit_existing_space(native):
    host, core = native
    host.cfg.workspace = "missing"
    with pytest.raises(HerdrError, match="space"):
        host.launch(run())
    assert not any(m == "terminal.run" for m, _ in core.calls)


def test_native_session_changed_during_readiness_is_not_prompted(native):
    host, core = native
    rpc = core.rpc

    def changed(method, **params):
        result = rpc(method, **params)
        if method == "terminal.wait":
            core.record["labels"]["session.id"] = "other-session"
        return result

    core.rpc = changed
    with pytest.raises(HerdrError, match="unsafe_adoption"):
        host.launch(run())
    assert not any(m == "terminal.send" for m, _ in core.calls)


def test_native_transport_selection_uses_existing_environment_seam(monkeypatch, tmp_path):
    monkeypatch.setenv("NETWORTH_URL", "https://networth.example")
    monkeypatch.setenv("NETWORTH_HOST_RUNTIME", "core")
    monkeypatch.setenv("NETWORTH_HOST_CORE", "native-core")
    cfg = Config.from_env()
    assert cfg.runtime == "core" and cfg.core == "native-core"
    with pytest.raises(ValueError):
        Config(url=cfg.url, state_dir=tmp_path, runtime="unknown")


def test_core_transport_uses_structured_request_and_preserves_errors(monkeypatch):
    from types import SimpleNamespace

    calls = []

    def request(argv, **kwargs):
        calls.append((argv, kwargs))
        return SimpleNamespace(returncode=1, stdout='{"error":{"message":"busy","data":{"kind":"blocked"}}}')

    monkeypatch.setattr("networth_host.cli.subprocess.run", request)
    with pytest.raises(HerdrError) as error:
        Core("native-core").rpc("terminal.send", text="literal $() `x`\nnext")
    assert error.value.code == "blocked"
    assert calls[0][0] == ["native-core", "connect"]
    assert json.loads(calls[0][1]["input"])["params"]["text"] == "literal $() `x`\nnext"
