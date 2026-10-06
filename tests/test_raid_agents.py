import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AgentAssignments(unittest.TestCase):
    def test_every_issue_has_valid_assignment_and_human_authority(self):
        data = json.loads((ROOT / 'planning/raid-agent-recommendations.json').read_text())
        items = json.loads((ROOT / 'planning/raid-backlog.json').read_text())['items']
        self.assertEqual(set(data['issues']), {x['id'] for x in items})
        for item in items:
            profile = data['issues'][item['id']]
            for vendor in ['codex', 'claude']:
                selected = profile[vendor]
                self.assertIn(selected['effort'], data['models'][selected['model']])
            self.assertEqual(profile['estimate_points'], item.get('estimate',0))
            self.assertTrue(profile['human_responsibility'])
            if item['kind'] in ['decision', 'release-gate']:
                self.assertEqual(profile['suitability'], 'Human-led')
            if item['kind'] == 'uat':
                self.assertEqual(profile['suitability'], 'AI-assisted')
                self.assertIn('representative', profile['human_responsibility'])
            self.assertIn('independent', profile['capacity'])


if __name__ == '__main__':
    unittest.main()
