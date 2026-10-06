import json
import os
import subprocess
import sys
import tempfile
import unittest


class CLITests(unittest.TestCase):
    def test_status_has_no_network_or_credential_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, "-m", "networth_host", "status"],
                env=os.environ | {"XDG_STATE_HOME": directory},
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads(result.stdout)
            self.assertFalse(state["capture_enabled"])
            self.assertEqual(
                state["providers"],
                [
                    {"kind": "claude", "model": "default", "auth": "native_subscription"},
                    {"kind": "codex", "model": "default", "auth": "native_subscription"},
                ],
            )
            self.assertFalse(state["api_billing_fallback"])
            self.assertEqual(os.listdir(directory), [])

    def test_capture_command_cannot_override_unimplemented_native_gates(self):
        result = subprocess.run(
            [sys.executable, "-m", "networth_host", "run"], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("capture is unavailable", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_provider_model_or_secret_flags_are_not_accepted(self):
        for flag in ("--model", "--api-key", "--effort"):
            result = subprocess.run(
                [sys.executable, "-m", "networth_host", "status", flag, "example"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
