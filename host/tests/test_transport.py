import io
import json
import unittest
from urllib.error import HTTPError

from networth_host.transport import Transport, TransportError


class Response(io.BytesIO):
    def __init__(self, content):
        super().__init__(content)
        self.headers = {"Content-Type": "application/json"}


class TransportTests(unittest.TestCase):
    def test_only_https_origin_allowed_before_credential_read(self):
        def credential():
            self.fail("invalid URL must not retrieve secure credential")

        for url in (
            "http://example.test",
            "https://u:p@example.test",
            "https://example.test/x",
            "https://example.test?x=1",
            "https://example.test#fragment",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                Transport(url, credential)

    def test_claim_is_bounded_outbound_post_with_no_provider_facts(self):
        seen = []

        def opener(request, timeout):
            seen.append(
                (
                    request.full_url,
                    request.method,
                    json.loads(request.data),
                    request.get_header("Authorization"),
                    timeout,
                )
            )
            return Response(b'{"claim":null}')

        client = Transport("https://example.test", lambda: "synthetic-token", opener=opener)
        result = client.claim({"request_id": "poll-1", "wait_seconds": 25})
        self.assertEqual(result, {"claim": None})
        self.assertEqual(
            seen,
            [
                (
                    "https://example.test/api/finance-host/v1/claims",
                    "POST",
                    {"request_id": "poll-1", "wait_seconds": 25},
                    "Bearer synthetic-token",
                    35,
                )
            ],
        )

    def test_run_id_cannot_escape_route(self):
        urls = []

        def opener(request, timeout):
            urls.append(request.full_url)
            return Response(b"{}")

        client = Transport("https://example.test", lambda: "synthetic-token", opener=opener)
        client.control("../other?token=x")
        self.assertEqual(
            urls,
            ["https://example.test/api/finance-host/v1/runs/..%2Fother%3Ftoken%3Dx/control"],
        )

    def test_redirect_error_does_not_retry_or_echo_token_or_response(self):
        calls = []

        def opener(request, timeout):
            calls.append(request.full_url)
            raise HTTPError(
                request.full_url,
                302,
                "synthetic-secret",
                {},
                io.BytesIO(b"secret body"),
            )

        client = Transport("https://example.test", lambda: "synthetic-token", opener=opener)
        with self.assertRaises(TransportError) as error:
            client.claim({"request_id": "poll-1", "wait_seconds": 25})
        self.assertEqual(str(error.exception), "host service returned HTTP 302")
        self.assertEqual(len(calls), 1)

    def test_malformed_or_oversized_response_is_not_an_ack(self):
        for content in (b"not-json", b"x" * (524288 + 1), b"[]"):
            client = Transport(
                "https://example.test",
                lambda: "synthetic-token",
                opener=lambda request, timeout, content=content: Response(content),
            )
            with self.assertRaises(TransportError):
                client.control("run-1")

    def test_timeout_never_automatically_replays_mutation(self):
        calls = []

        def opener(request, timeout):
            calls.append(request.full_url)
            raise TimeoutError()

        client = Transport("https://example.test", lambda: "synthetic-token", opener=opener)
        with self.assertRaises(TransportError):
            client.start("run-1", {"instruction_id": "i1"})
        self.assertEqual(len(calls), 1)

    def test_no_secret_in_transport_representation(self):
        client = Transport("https://example.test", lambda: "synthetic-token")
        self.assertNotIn("synthetic-token", repr(client))
