"""Diagnostic/transport entry point; enrollment and capture are not activated."""

import argparse
import json
import os
import sys
from pathlib import Path

from .companion import Companion
from .journal import Journal
from .transport import Transport, TransportError


def readiness():
    return {
        "capture_enabled": False,
        "providers": [
            {"kind": "claude", "model": "default", "auth": "native_subscription"},
            {"kind": "codex", "model": "default", "auth": "native_subscription"},
        ],
        "api_billing_fallback": False,
        "unverified": [
            "native_subscription_context",
            "native_identity",
            "user_reachability",
            "collector_context",
            "source_controls",
        ],
    }


def credential_reader(origin, host_id):
    """Read only this enrolled consumer's supported OS keyring entry."""

    def read():
        try:
            import keyring

            backend = keyring.get_keyring()
            if type(backend).__module__ not in {
                "keyring.backends.macOS",
                "keyring.backends.SecretService",
                "keyring.backends.Windows",
            }:
                raise TransportError("supported native secure storage unavailable")
            token = backend.get_password("networth-host", origin.rstrip("/") + "/" + host_id)
            if not token:
                raise TransportError("host is not enrolled")
            return token
        except TransportError:
            raise
        except Exception:
            raise TransportError("native credential unavailable") from None

    return read


def main(argv=None):
    parser = argparse.ArgumentParser(prog="networth-host")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="Show implementation readiness without contacting services")
    commands.add_parser("run", help="Start collection only when all implementation gates exist")
    poll = commands.add_parser(
        "poll-once",
        help="Transport verification for an already enrolled host; never launches capture",
    )
    poll.add_argument("--url", required=True)
    poll.add_argument("--host-id", required=True)
    poll.add_argument(
        "--state-dir",
        type=Path,
        default=Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
        / "networth-host",
    )
    args = parser.parse_args(argv)
    if args.command == "status":
        print(json.dumps(readiness()))
        return 0
    if args.command == "run":
        print(
            "capture is unavailable: native subscription, client-open, context binding and source controls require verification",
            file=sys.stderr,
        )
        return 2
    journal = None
    try:
        transport = Transport(args.url, credential_reader(args.url, args.host_id))
        journal = Journal(args.state_dir / "host.sqlite3")
        companion = Companion(journal, transport, args.host_id)
        claim = companion.poll_once()
        # Do not print account scopes or credentials to daemon logs.
        print(json.dumps({"claim_received": claim is not None, "capture_enabled": False}))
        return 0
    except (ValueError, RuntimeError, OSError):
        print("host transport unavailable; retained state requires reconciliation", file=sys.stderr)
        return 1
    finally:
        if journal is not None:
            journal.close()


if __name__ == "__main__":
    raise SystemExit(main())
