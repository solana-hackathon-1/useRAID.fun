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

class LocalCIMode(unittest.TestCase):
    def test_hosted_workflows_are_manual_while_minutes_are_exhausted(self):
        for name in ['checks.yml', 'raid-status.yml']:
            workflow = (ROOT / '.github/workflows' / name).read_text()
            trigger = workflow.split('on:', 1)[1].split('permissions:', 1)[0]
            self.assertEqual(trigger.strip(), 'workflow_dispatch:')

    def test_local_runner_preserves_all_required_layers(self):
        runner = (ROOT / 'scripts/local-ci.sh').read_text()
        for command in ['unittest discover', 'format:check', 'typecheck', 'lint',
                        'audit:check', 'migrate diff', 'RUN_DB_TESTS=true',
                        'docker build', 'playwright install chromium', 'test:browser', 'test:browser:studio',
                        'npm run build', 'test:live', 'test:browser:live']:
            self.assertIn(command, runner)
        self.assertIn('git rev-parse HEAD', runner)
        self.assertIn('exit "$failed"', runner)


if __name__ == '__main__':
    unittest.main()
