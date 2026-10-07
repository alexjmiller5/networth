import importlib.util
from datetime import datetime, timedelta
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sign', Path(__file__).with_name('sign-widgets.py'))
sign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sign)


def profile(bundle, group='group.com.example.demo', team='TEAM'):
    return {'UUID': bundle.replace('.', '-'), 'TeamIdentifier': [team],
            'ApplicationIdentifierPrefix': [team],
            'ExpirationDate': datetime.now() + timedelta(days=10),
            'ProvisionedDevices': ['device'], 'DeveloperCertificates': [b'cert'],
            'Entitlements': {'application-identifier': team + '.' + bundle,
                             'com.apple.developer.team-identifier': team,
                             'com.apple.security.application-groups': [group],
                             'get-task-allow': False}}


class SigningPlanTests(unittest.TestCase):
    def setUp(self):
        self.settings = [{'buildSettings': {'WRAPPER_EXTENSION': kind,
                         'PRODUCT_BUNDLE_IDENTIFIER': bundle}}
                         for kind, bundle in [('app', 'com.example.demo'),
                                              ('appex', 'com.example.demo.widgets')]]
        self.profiles = {b: profile(b) for b in ['com.example.demo', 'com.example.demo.widgets']}

    def test_exact_app_and_extension_profiles(self):
        team, mapping = sign.signing_plan(self.settings, self.profiles, 'device')
        self.assertEqual(team, 'TEAM')
        self.assertEqual(set(mapping), set(self.profiles))

    def test_repeated_xcode_dependency_settings_are_deduplicated(self):
        team, mapping = sign.signing_plan(self.settings + [self.settings[0]], self.profiles, 'device')
        self.assertEqual(team, 'TEAM')
        self.assertEqual(len(mapping), 2)

    def test_missing_or_extra_profile_rejected(self):
        for profiles in [{k: v for k, v in self.profiles.items() if not k.endswith('widgets')},
                         self.profiles | {'com.example.other': profile('com.example.other')}]:
            with self.assertRaises(ValueError):
                sign.signing_plan(self.settings, profiles, 'device')

    def test_wrong_bundle_or_group_or_team_rejected(self):
        for other in [profile('com.example.other'),
                      profile('com.example.demo.widgets', 'group.com.example.other'),
                      profile('com.example.demo.widgets', team='OTHER')]:
            with self.assertRaises(ValueError):
                sign.signing_plan(self.settings,
                                  self.profiles | {'com.example.demo.widgets': other}, 'device')

    def test_wildcard_or_absent_app_group_rejected(self):
        for group in [[], ['group.com.example.*']]:
            other = profile('com.example.demo.widgets')
            other['Entitlements']['com.apple.security.application-groups'] = group
            with self.assertRaises(ValueError):
                sign.signing_plan(self.settings,
                                  self.profiles | {'com.example.demo.widgets': other}, 'device')

    def test_common_wildcard_group_is_still_rejected(self):
        profiles = {k: profile(k, 'group.com.example.*') for k in self.profiles}
        with self.assertRaises(ValueError):
            sign.signing_plan(self.settings, profiles, 'device')

    def test_unregistered_device_rejected(self):
        with self.assertRaises(ValueError):
            sign.signing_plan(self.settings, self.profiles, 'other-device')


if __name__ == '__main__':
    unittest.main()
