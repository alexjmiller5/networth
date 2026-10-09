"""networth-host: picks up finance review runs started on the Networth site and
launches an agent for each in a new Herdr tab. Outbound HTTPS only; the site
never connects to this machine."""

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

KEYCHAIN_SERVICE = "networth-host"
RUN_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ACTIVE = {"queued", "claimed", "running"}
# ponytail: screen-text heuristic for "no usage left"; replace with a Herdr status if it grows one.
UNAVAILABLE = re.compile(
    r"usage limit|hit your limit|out of credits|credit balance is too low|insufficient credits|limit reached",
    re.I,
)
INSTRUCTION = (
    "You are running finance review run {run_id} launched from the Networth site. "
    "Load the finance-review skill and run it for exactly these account ids: {accounts}. "
    "Follow the skill: login helper, ingest, reconcile, propose categorization; ask the user "
    "in this pane for anything only they can do. When finished (or if you must stop), run "
    "`networth-host report --run-id {run_id} --status done|failed --summary '<one line>'`. "
    "Never change Notion task status."
)
CANCEL = (
    "The user canceled this run from the Networth site. Stop collection safely, close your "
    "browser groups, then run: networth-host report --run-id {run_id} --status canceled "
    "--summary '<what was finished>'"
)


def log(message):
    print(f"{datetime.now().isoformat(timespec='seconds')} {message}", flush=True)


@dataclass
class Config:
    url: str
    state_dir: Path
    workspace: str | None = None
    herdr: str = "herdr"
    herdr_session: str = "default"
    poll_seconds: int = 25
    watch_seconds: int = 10
    cancel_timeout: int = 600
    token_command: list[str] | None = None

    @classmethod
    def from_env(cls, url=None):
        env = os.environ
        state = env.get("NETWORTH_HOST_STATE_DIR") or Path(
            env.get("XDG_STATE_HOME") or Path.home() / ".local/state", "networth-host"
        )
        command = env.get("NETWORTH_HOST_TOKEN_COMMAND")
        return cls(
            url=(url or env.get("NETWORTH_URL", "")).rstrip("/"),
            state_dir=Path(state),
            workspace=env.get("NETWORTH_HOST_HERDR_WORKSPACE") or None,
            herdr=env.get("NETWORTH_HOST_HERDR", "herdr"),
            herdr_session=env.get("NETWORTH_HOST_HERDR_SESSION", "default"),
            poll_seconds=int(env.get("NETWORTH_HOST_POLL_SECONDS", "25")),
            token_command=json.loads(command) if command else None,
        )


# --- site API --------------------------------------------------------------


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    # A redirect means Access intercepted the request (route not bypassed): fail, never follow.
    def redirect_request(self, *args):
        return None


class Api:
    def __init__(self, url, token):
        parts = urlsplit(url)
        local = parts.scheme == "http" and parts.hostname in {"127.0.0.1", "localhost"}
        if not (parts.scheme == "https" or local) or parts.path not in {"", "/"}:
            raise ValueError("the Networth URL must be an https origin")
        self.url, self.token, self._bearer = url.rstrip("/"), token, None
        self.open = build_opener(NoRedirect()).open

    def _call(self, method, path, body=None, timeout=30):
        self._bearer = self._bearer or self.token()
        request = Request(
            self.url + path,
            data=None if body is None else json.dumps(body).encode(),
            method=method,
            headers={
                "Authorization": f"Bearer {self._bearer}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "networth-host/1",
            },
        )
        try:
            with self.open(request, timeout=timeout) as response:
                return json.loads(response.read(1 << 20))
        except HTTPError as error:
            if error.code == 401:
                self._bearer = None
            try:
                message = json.loads(error.read(4096)).get("error", "")
            except ValueError:
                message = error.reason
            raise ApiError(error.code, message) from None

    def claim(self, wait):
        body = {"wait_seconds": wait}
        return self._call("POST", "/api/finance-host/v1/claim", body, timeout=wait + 20)["run"]

    def get(self, run_id):
        return self._call("GET", f"/api/finance-host/v1/runs/{run_id}")["run"]

    def patch(self, run_id, **fields):
        return self._call("PATCH", f"/api/finance-host/v1/runs/{run_id}", fields)["run"]

    def session(self):
        return self._call("GET", "/api/device/session")


def token_source(cfg):
    if literal := os.environ.get("NETWORTH_HOST_TOKEN"):
        return lambda: literal
    argv = cfg.token_command or [
        "/usr/bin/security",
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        cfg.url,
        "-w",
    ]

    def read():
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        token = result.stdout.strip()
        if result.returncode or not re.fullmatch(r"nw_[0-9a-f]{64}", token):
            raise RuntimeError("host credential unavailable; run `networth-host enroll`")
        return token

    return read


def keychain_store(account, token):
    # `security -i` reads commands from stdin, keeping the token out of argv. -A lets the
    # daemon read it whatever binary Nix builds next.
    script = (
        f'delete-generic-password -s {KEYCHAIN_SERVICE} -a "{account}"\n'
        f'add-generic-password -s {KEYCHAIN_SERVICE} -a "{account}" -w {token} -A\n'
    )
    subprocess.run(["/usr/bin/security", "-i"], input=script, capture_output=True, text=True)
    check = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True,
        text=True,
    )
    if check.stdout.strip() != token:
        raise SystemExit(
            "Could not save the credential to the login Keychain. Over ssh the Keychain is locked: "
            "run enroll from a desktop Terminal, or via `launchctl submit` in the login session."
        )


def enroll(cfg, label, store=None, sleep=time.sleep):
    device_id, token = str(uuid.uuid4()), "nw_" + secrets.token_hex(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    (store or (lambda t: keychain_store(cfg.url, t)))(token)
    query = urlencode({"id": device_id, "hash": digest, "label": label, "kind": "host"})
    print(f"Approve this host in Networth (code {digest[:8].upper()}):\n  {cfg.url}/widgets#{query}", flush=True)
    api = Api(cfg.url, lambda: token)
    for _ in range(200):
        try:
            state = api.session()["state"]
        except ApiError as error:
            if error.status != 401:
                raise
            state = "unstaged"
        if state == "active":
            break
        if state in {"expired", "revoked"}:
            raise SystemExit(f"Enrollment {state}; run enroll again.")
        sleep(3)
    else:
        raise SystemExit("Enrollment was not approved within 10 minutes; run enroll again.")
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    receipt = cfg.state_dir / "enrollment.json"
    receipt.write_text(
        json.dumps(
            {
                "device_id": device_id,
                "url": cfg.url,
                "label": label,
                "kind": "host",
                "approved_at": datetime.now(UTC).isoformat(timespec="seconds"),
                "credential": f"login Keychain item {KEYCHAIN_SERVICE} / {cfg.url}",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Enrolled host {device_id}. Receipt: {receipt}", flush=True)
    return receipt


# --- agent reports (the agent's shell cannot read the Keychain; the daemon delivers) ---


def queue_report(state_dir, run_id, status, summary):
    if not RUN_ID.match(run_id) or status not in {"done", "failed", "canceled"}:
        raise ValueError("expected a run id and --status done|failed|canceled")
    folder = Path(state_dir) / "reports"
    folder.mkdir(parents=True, exist_ok=True)
    path, tmp = folder / f"{run_id}.json", folder / f".{run_id}.tmp"
    tmp.write_text(json.dumps({"status": status, "summary": " ".join(summary.split())[:1000] or "No summary."}))
    os.replace(tmp, path)
    return path


# --- Herdr --------------------------------------------------------------------


class HerdrError(Exception):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code


class Herdr:
    def __init__(self, cfg):
        self.base = [cfg.herdr, "--session", cfg.herdr_session]

    def __call__(self, *args):
        result = subprocess.run([*self.base, *args], capture_output=True, text=True, timeout=180)
        if result.returncode:
            text = (result.stderr or result.stdout).strip()
            try:
                error = json.loads(text)["error"]
            except (ValueError, KeyError, TypeError):
                error = {"code": "failed", "message": text[:300]}
            raise HerdrError(error["code"], error["message"])
        if args[:2] == ("agent", "read"):
            return result.stdout
        return json.loads(result.stdout) if result.stdout.strip() else {}


class Host:
    def __init__(self, cfg, api, herdr, sleep=time.sleep, clock=time.monotonic):
        self.cfg, self.api, self.herdr, self.sleep, self.clock = cfg, api, herdr, sleep, clock

    def handle(self, run):
        run_id, name = run["id"], run.get("agent_name")
        if run["cancel_requested"] and not name:
            self.api.patch(run_id, status="canceled", summary="Canceled before the agent started.")
            return
        if not name:
            try:
                details = self.launch(run)
            except HerdrError as error:
                self.api.patch(run_id, status="failed", summary=f"Could not start an agent: {error}"[:1000])
                return
            self.api.patch(run_id, status="running", **details)
            name = details["agent_name"]
        self.watch(run_id, name)

    def launch(self, run):
        name = "finance-run-" + run["id"][:8]
        try:
            agent = self.herdr("agent", "get", name)["result"]["agent"]
            # Restarted after launching but before reporting: adopt, never launch twice.
            tab = self.herdr("tab", "get", agent["tab_id"]).get("result", {}).get("tab", {})
            label = tab.get("label") or self.label()
            return self.details(name, agent["agent"], agent["tab_id"], agent["pane_id"], label)
        except HerdrError as error:
            if error.code != "agent_not_found":
                raise
        label = self.label()
        text = INSTRUCTION.format(run_id=run["id"], accounts=", ".join(run["account_ids"]))
        workspace = ("--workspace", self.cfg.workspace) if self.cfg.workspace else ()
        for kind in ("claude", "codex"):
            created = self.herdr("tab", "create", *workspace, "--cwd", str(Path.home()), "--label", label, "--no-focus")
            tab_id, pane = created["result"]["tab"]["tab_id"], created["result"]["root_pane"]["pane_id"]
            try:
                self.herdr("agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "60000")
                self.herdr("agent", "wait", name, "--until", "idle", "--timeout", "60000")
                self.prompt(name, text)
                if kind == "claude":
                    self.sleep(20)
                    if UNAVAILABLE.search(self.herdr("agent", "read", name, "--source", "visible")):
                        raise HerdrError("unavailable", "claude reports no usage left")
                return self.details(name, kind, tab_id, pane, label)
            except HerdrError as error:
                log(f"{kind} could not take run {run['id']}: {error}")
                if kind == "codex":
                    raise
                try:
                    self.herdr("tab", "close", tab_id)
                except HerdrError:
                    pass

    def prompt(self, name, text):
        try:
            self.herdr("agent", "prompt", name, text, "--wait", "--until", "working", "--timeout", "30000")
        except HerdrError as error:
            if error.code != "agent_prompt_stalled":
                raise
            self.herdr("agent", "send-keys", name, "enter")

    @staticmethod
    def label():
        return f"Finance review {date.today().isoformat()}"

    @staticmethod
    def details(name, kind, tab_id, pane_id, label):
        return {"tab_id": tab_id, "pane_id": pane_id, "tab_label": label, "agent_name": name, "agent_kind": kind}

    def deliver(self, run_id):
        path = Path(self.cfg.state_dir) / "reports" / f"{run_id}.json"
        if not path.exists():
            return False
        try:
            self.api.patch(run_id, **json.loads(path.read_text()))
        except ApiError as error:
            if error.status != 409:  # 409: the run already ended; the report is moot
                raise
        path.unlink()
        return True

    def alive(self, name):
        try:
            self.herdr("agent", "get", name)
            return True
        except HerdrError as error:
            if error.code == "agent_not_found":
                return False
            raise

    def watch(self, run_id, name):
        cancel_seen, prompted = None, False
        while not self.deliver(run_id):
            run = self.api.get(run_id)
            if run["status"] not in ACTIVE:
                return
            if run["cancel_requested"]:
                cancel_seen = self.clock() if cancel_seen is None else cancel_seen
                if not prompted:
                    try:
                        self.herdr("agent", "prompt", name, CANCEL.format(run_id=run_id))
                        prompted = True
                    except HerdrError as error:
                        log(f"cancel prompt for {name} not delivered yet: {error}")
                if self.clock() - cancel_seen >= self.cfg.cancel_timeout:
                    self.api.patch(run_id, status="canceled", summary="Canceled; the agent did not confirm in time.")
                    return
            if not self.alive(name):
                if not self.deliver(run_id):
                    status = "canceled" if cancel_seen is not None else "failed"
                    self.api.patch(run_id, status=status, summary="The agent exited without reporting.")
                return
            self.sleep(self.cfg.watch_seconds)


def serve(cfg):
    api = Api(cfg.url, token_source(cfg))
    host, delay = Host(cfg, api, Herdr(cfg)), 5
    log(f"polling {cfg.url}")
    while True:
        started = time.monotonic()
        try:
            run = api.claim(cfg.poll_seconds)
            delay = 5
            if run:
                log(f"claimed run {run['id']} for {', '.join(run['account_ids'])}")
                host.handle(run)
                log(f"run {run['id']} handled")
            elif time.monotonic() - started < 5:
                time.sleep(5)
        except Exception as error:  # noqa: BLE001 - the daemon must outlive any one failure
            delay = 300 if isinstance(error, ApiError) and error.status in {401, 403} else min(delay * 2, 300)
            log(f"error: {error}; retrying in {delay}s")
            time.sleep(delay)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="networth-host", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("run", help="long-poll the site and launch agents for claimed runs")
    enroll_cmd = commands.add_parser("enroll", help="approve this machine as the finance host")
    enroll_cmd.add_argument("--label", default="Finance host")
    for cmd in (commands.choices["run"], enroll_cmd):
        cmd.add_argument("--url", help="Networth site origin (default: $NETWORTH_URL)")
    report = commands.add_parser("report", help="report a run's outcome (run by the agent)")
    report.add_argument("--run-id", required=True)
    report.add_argument("--status", required=True, choices=["done", "failed", "canceled"])
    report.add_argument("--summary", default="")
    args = parser.parse_args(argv)
    cfg = Config.from_env(getattr(args, "url", None))
    if args.command == "report":
        try:
            queue_report(cfg.state_dir, args.run_id, args.status, args.summary)
        except ValueError as error:
            parser.error(str(error))
        print("Report queued; the host delivers it to the site within seconds.")
        return
    if not cfg.url:
        parser.error("set --url or NETWORTH_URL")
    if args.command == "enroll":
        enroll(cfg, args.label)
    else:
        serve(cfg)


if __name__ == "__main__":
    sys.exit(main())
