"""Cloudflare provisioning must preserve rollback and exclude administration."""
import json
import os
import unittest
from unittest.mock import patch

import httpx
import provision


class DeployTokenTest(unittest.TestCase):
    def test_new_token_is_account_scoped_and_never_deletes_previous_token(self):
        requests = []
        def respond(request):
            requests.append(request)
            if request.method == "DELETE":
                self.fail("Provisioning cannot retire the working credential")
            if request.url.path.endswith("permission_groups"):
                result = [{"name": name, "id": name} for name in [
                    "Workers Scripts Write", "Workers R2 Storage Write", "D1 Write",
                    "Zone Read", "Workers Routes Write", "Zone Settings Write",
                ]]
            elif request.method == "POST":
                body = json.loads(request.content)
                self.assertEqual(len(body["policies"]), 1)
                account = body["policies"][0]
                self.assertEqual(account["resources"], {"com.cloudflare.api.account.account-fixture": "*"})
                self.assertEqual(account["permission_groups"], [{"id": "Workers Scripts Write"}])
                self.assertNotEqual(body["name"], provision.NAME + "-deploy")
                result = {"id": "new-id", "value": "fixture-token"}
            else:
                result = [{"id": "existing-id", "name": provision.NAME + "-deploy"}]
            return httpx.Response(200, json={"success": True, "result": result})
        client = httpx.Client(base_url="https://fixture.invalid", transport=httpx.MockTransport(respond))
        with patch.object(provision.httpx, "Client", return_value=client), patch.object(provision, "op_read", return_value="fixture-admin"), patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": "account-fixture", "CLOUDFLARE_ZONE_ID": "zone-fixture"}):
            self.assertEqual(provision.mint_deploy_token(), "fixture-token")
        self.assertTrue(any(request.method == "POST" for request in requests))


if __name__ == "__main__":
    unittest.main()
