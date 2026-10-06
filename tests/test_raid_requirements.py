import hashlib
import json
import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ReusableModuleContract(unittest.TestCase):
    def test_new_owner_requirements_are_canonical(self):
        source = (ROOT / 'RAID_AGENT_BLUEPRINT.md').read_text()
        for ident in ['R15', 'R16', 'I13', 'AC73', 'AC74', 'AC75']:
            self.assertTrue(re.search(r'\| ' + ident + r' \|', source), ident)

    def test_authentication_is_explicitly_an_owned_reusable_feature(self):
        source = (ROOT / 'RAID_AGENT_BLUEPRINT.md').read_text()
        self.assertTrue('Owned features include authentication, sessions, wallet linking' in source)

    def test_registry_matches_entire_backlog_and_all_core_contracts(self):
        registry = json.loads((ROOT / 'planning/raid-task-contracts.json').read_text())
        manifest = json.loads((ROOT / 'planning/raid-backlog.json').read_text())
        self.assertEqual(set(registry['packets']), {x['id'] for x in manifest['items']})
        for ident, packet in registry['packets'].items():
            present = {c['id'] for c in packet['criteria']}
            self.assertTrue({ident + '-C' + f'{i:02d}' for i in range(1, 22)} <= present, ident)

    def test_every_task_keeps_tdd_adapter_and_reuse_criteria(self):
        registry = json.loads((ROOT / 'planning/raid-task-contracts.json').read_text())
        for ident, packet in registry['packets'].items():
            for required in ['R15', 'R16', 'I13', 'AC73', 'AC74', 'AC75']:
                self.assertIn(required, packet['requirement_ids'], ident)
            for suffix in ['C19', 'C20', 'C21']:
                self.assertIn(ident + '-' + suffix, [c['id'] for c in packet['criteria']], ident)
        self.assertEqual(registry['blueprint_sha256'], hashlib.sha256((ROOT / 'RAID_AGENT_BLUEPRINT.md').read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
