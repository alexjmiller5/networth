"""Run with `uv run --with httpx python scripts/test_provision.py`. No real credentials."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import provision


class HubTokenTest(unittest.TestCase):
    def test_mints_only_read_scope_and_refuses_to_replace_live_token(self):
        with patch.object(provision.subprocess, "run") as run:
            run.side_effect = [
                subprocess.CompletedProcess([], 0, "[]", ""),
                subprocess.CompletedProcess([], 0, json.dumps({"token": "test-token", "scopes": "tables:read"}), ""),
            ]
            self.assertEqual(provision.mint_hub_token(), "test-token")
            self.assertEqual(run.call_args.args[0], ["life", "token", "create", "networth", "--scopes", "tables:read"])
            run.reset_mock()
            run.side_effect = [subprocess.CompletedProcess([], 0, '[{"name":"networth","revoked_at":null}]', "")]
            with self.assertRaises(RuntimeError):
                provision.mint_hub_token()
            self.assertEqual(run.call_count, 1)

    def test_secret_delivery_uses_stdin_and_refuses_unresolved_values(self):
        script = Path(__file__).with_name('sync-secrets.sh')
        with tempfile.TemporaryDirectory() as directory:
            tools = Path(directory)
            (tools / 'op').write_text('#!/bin/sh\nshift 3\nexec "$@"\n')
            (tools / 'bunx').write_text(
                '#!/usr/bin/env python3\nimport json, os, sys\n'
                'value = os.environ["LIFE_HUB_TOKEN"]\n'
                'assert value not in " ".join(sys.argv)\n'
                'assert sys.stdin.read() in (value, "LIFE_HUB_TOKEN=" + value + "\\n")\n'
                'print(json.dumps(sys.argv[1:]))\n'
            )
            for path in tools.iterdir():
                path.chmod(0o700)
            env = {**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}'}
            for value in ('', 'CHANGEME', 'op://unresolved/reference', 'invalid\nvalue'):
                result = subprocess.run(['bash', str(script), '--deploy'], env={**env, 'LIFE_HUB_TOKEN': value}, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
            result = subprocess.run(['bash', str(script), '--deploy', '--dry-run'], env={**env, 'LIFE_HUB_TOKEN': 'fixture-only'}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), ['wrangler', 'deploy', '--secrets-file', '/dev/stdin', '--dry-run'])


if __name__ == "__main__":
    unittest.main()
