"""Outbound HTTPS only. Mutations are never automatically retried here."""

from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .wire import canonical_request, parse_json


class TransportError(RuntimeError):
    """No trustworthy acknowledgment; retain the exact pending operation."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Transport:
    def __init__(self, origin, credential, *, opener=None):
        parsed = urlsplit(origin)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("host endpoint must be an HTTPS origin")
        self.origin = origin.rstrip("/")
        self.credential = credential
        self.open = opener or build_opener(NoRedirect()).open

    def _request(self, method, suffix, body=None, *, timeout=15):
        token = self.credential()
        if not isinstance(token, str) or not token or any(c.isspace() for c in token):
            raise TransportError("host credential unavailable")
        request = Request(
            self.origin + "/api/finance-host/v1/" + suffix,
            data=canonical_request(body).encode("utf-8") if body is not None else None,
            method=method,
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Cache-Control": "no-store",
                "User-Agent": "networth-host/1",
            },
        )
        try:
            with self.open(request, timeout=timeout) as response:
                if (
                    response.headers.get("Content-Type", "").split(";")[0].strip()
                    != "application/json"
                ):
                    raise TransportError("host service returned non-JSON content")
                raw = response.read(524289)
                if len(raw) > 524288:
                    raise TransportError("host response exceeds limit")
                value = parse_json(raw)
                if not isinstance(value, dict):
                    raise TransportError("invalid host response")
                return value
        except HTTPError as exc:
            raise TransportError(f"host service returned HTTP {exc.code}") from None
        except (URLError, TimeoutError, OSError):
            raise TransportError(
                "host service contact unavailable; outcome may be unknown"
            ) from None
        except (ValueError, UnicodeError):
            raise TransportError("invalid host response") from None

    def claim(self, request):
        wait = request.get("wait_seconds")
        if type(wait) is not int or not 0 <= wait <= 25:
            raise ValueError("invalid poll duration")
        return self._request("POST", "claims", request, timeout=wait + 10)

    def control(self, run_id):
        return self._request("GET", "runs/" + quote(run_id, safe="") + "/control")

    def event(self, run_id, event):
        return self._request("POST", "runs/" + quote(run_id, safe="") + "/events", event)

    def start(self, run_id, request):
        return self._request("POST", "runs/" + quote(run_id, safe="") + "/start", request)
