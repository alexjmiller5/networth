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
    def test_hub_token_is_enrolled_never_minted(self):
        # A Soma consumer token comes from an owner-approved profile enrollment,
        # so bootstrap must not offer to mint one with operator access.
        self.assertNotIn("SOMA_HUB_TOKEN", provision.FIELDS)
        self.assertNotIn("SOMA_HUB_TOKEN", provision.MINTERS)
        with patch.object(provision.subprocess, "run") as run:
            with patch.object(provision.sys, "argv", ["provision.py", "--list"]):
                provision.main()
            run.assert_not_called()

    def test_secret_delivery_uses_stdin_and_refuses_unresolved_values(self):
        script = Path(__file__).with_name('sync-secrets.sh')
        with tempfile.TemporaryDirectory() as directory:
            tools = Path(directory)
            (tools / 'op').write_text('#!/bin/sh\nshift 3\nexec "$@"\n')
            (tools / 'bunx').write_text(
                '#!/usr/bin/env python3\nimport json, os, sys\n'
                'names = ("SOMA_HUB_TOKEN", "TIINGO_API_KEY")\n'
                'assert all(os.environ[n] not in " ".join(sys.argv) for n in names)\n'
                'body = sys.stdin.read()\n'
                'assert body in [os.environ[n] for n in names] + ["".join(f"{n}={os.environ[n]}\\n" for n in names)], body\n'
                'print(json.dumps(sys.argv[1:]))\n'
            )
            for path in tools.iterdir():
                path.chmod(0o700)
            env = {**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}'}
            good = {'SOMA_HUB_TOKEN': 'fixture-only', 'TIINGO_API_KEY': 'fixture-key'}
            for name in good:
                for value in ('', 'CHANGEME', 'op://unresolved/reference', 'invalid\nvalue'):
                    result = subprocess.run(['bash', str(script), '--deploy'], env={**env, **good, name: value}, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, '')
            result = subprocess.run(['bash', str(script)], env={**env, **good}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([json.loads(line) for line in result.stdout.splitlines()], [['wrangler', 'secret', 'put', 'SOMA_HUB_TOKEN'], ['wrangler', 'secret', 'put', 'TIINGO_API_KEY']])
            result = subprocess.run(['bash', str(script), '--deploy', '--dry-run'], env={**env, **good}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), ['wrangler', 'deploy', '--secrets-file', '/dev/stdin', '--dry-run'])


if __name__ == "__main__":
    unittest.main()
