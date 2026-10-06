from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StudioCISafety(unittest.TestCase):
    def test_studio_has_isolated_compose_database_matching_preview_contract(self):
        workflow = (ROOT / '.github/workflows/checks.yml').read_text()
        studio = workflow.split('- name: Studio desktop and mobile suite', 1)[1].split('- name: Production build', 1)[0]
        self.assertIn('COMPOSE_FILE: compose.yaml:compose.test.yaml', studio)
        self.assertIn('COMPOSE_PROJECT_NAME: raid-ci-studio', studio)
        self.assertIn('localhost:55432/useraid_studio_test', studio)
        self.assertIn('docker compose up -d --wait db', studio)
        self.assertIn('docker compose down -v', workflow)


if __name__ == '__main__':
    unittest.main()
