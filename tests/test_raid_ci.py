from pathlib import Path
import unittest
import os
import re
import subprocess
import tempfile

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


    def test_runner_reports_unrunnable_browser_layers_instead_of_aborting(self):
        runner = (ROOT / 'scripts/local-ci.sh').read_text()
        self.assertNotIn('playwright install chromium || exit', runner)
        for layer in ['demo', 'studio', 'live-flow', 'live-browser']:
            self.assertIn(f'skip {layer} ', runner)
        self.assertIn('NOT RUN', runner)

    def test_runner_preserves_evidence_on_every_exit_path(self):
        runner = (ROOT / 'scripts/local-ci.sh').read_text()
        cleanup = runner.split('cleanup() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('cp -R test-results playwright-report', cleanup)
        self.assertIn('trap cleanup EXIT', runner)

    def test_runner_fails_fast_when_required_host_ports_are_occupied(self):
        runner = (ROOT / 'scripts/local-ci.sh').read_text()
        for port in ['3000', '3001', '3006', '3007', '3008', '55432']:
            self.assertIn(port, runner.split('ports()', 1)[1].split('\n}\n', 1)[0])
        self.assertLess(runner.index('step ports '), runner.index('step install '))



class LocalCICleanupOwnership(unittest.TestCase):
    def run_candidate(self, failure):
        # A standalone host with deterministic command substitutes; no Docker mutation.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'bin').mkdir()
            runner = (ROOT / 'scripts/local-ci.sh').read_text()
            # Exercise lifecycle independently of the machine's occupied ports.
            runner = re.sub(r'ports\(\) \{.*?\n\}',
                            'ports() { return ' + ('1' if failure == 'ports' else '0') + '; }',
                            runner, count=1, flags=re.S)
            (root / 'scripts/local-ci.sh').write_text(runner)
            stub = r'''#!/bin/bash
printf '%s\n' "$(basename "$0") $*" >> "$COMMAND_LOG"
case "$(basename "$0") $*" in
  "npm ci") [ "$FAIL_AT" != install ]; exit $? ;;
  "docker compose up -d --wait db") [ "$FAIL_AT" != database ]; exit $? ;;
  "docker compose stop db") [ "$FAIL_AT" != cleanup ]; exit $? ;;
  "npm test "*)
    if [ "$FAIL_AT" = interrupt ]; then kill -TERM "$PPID"; fi ;;
  "npm run test:browser"|"npm run test:browser:studio"|"npm run test:browser:live")
    rm -rf test-results playwright-report
    mkdir -p test-results playwright-report
    printf '%s\n' "$*" > test-results/suite.txt
    printf '%s\n' "$*" > playwright-report/suite.txt
    if [ "$*" = 'run test:browser:studio' ] && [ "$FAIL_AT" = studio ]; then exit 1; fi ;;
  "cp "*)
    if [ "$FAIL_AT" = copy ] && [[ "$*" = *-reports* ]]; then exit 1; fi
    exec /bin/cp "$@" ;;

esac
exit 0
'''
            for command in ['git', 'node', 'npm', 'npx', 'docker', 'cp', 'python3']:
                path = root / 'bin' / command
                path.write_text(stub)
                path.chmod(0o755)
            env = dict(os.environ, PATH=str(root / 'bin') + ':' + os.environ['PATH'],
                       COMMAND_LOG=str(root / 'commands'), FAIL_AT=failure,
                       RAID_CI_LOG_DIR=str(root / 'evidence'))
            result = subprocess.run(['bash', str(root / 'scripts/local-ci.sh')],
                                    env=env, capture_output=True, text=True, timeout=15)
            self.reports = {str(p.relative_to(root / 'evidence')): p.read_text()
                            for p in (root / 'evidence').rglob('suite.txt')}
            return result, (root / 'commands').read_text(), (root / 'evidence/results.txt').read_text()

    def test_port_rejection_does_not_stop_database_owned_by_another_run(self):
        result, commands, evidence = self.run_candidate('ports')
        self.assertEqual(result.returncode, 1)
        self.assertIn('ports: 1', evidence)
        self.assertNotIn('docker compose stop db', commands)
        self.assertNotIn('npm ci', commands)
        self.assertIn('Evidence:', result.stdout)

    def test_install_failure_does_not_stop_database_not_started_by_this_run(self):
        result, commands, evidence = self.run_candidate('install')
        self.assertEqual(result.returncode, 1)
        self.assertIn('install: 1', evidence)
        self.assertNotIn('docker compose stop db', commands)

    def test_failed_database_start_attempt_still_cleans_up_partial_start(self):
        result, commands, evidence = self.run_candidate('database')
        self.assertEqual(result.returncode, 1)
        self.assertIn('database: 1', evidence)
        self.assertIn('docker compose stop db', commands)
        self.assertLess(commands.index('docker compose up'), commands.index('docker compose stop'))

    def test_success_stops_owned_database_once_and_reports_cleanup(self):
        result, commands, evidence = self.run_candidate('none')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(commands.count('docker compose stop db'), 1)
        self.assertIn('cleanup: 0', evidence)

    def test_cleanup_failure_is_not_reported_as_success(self):
        result, commands, evidence = self.run_candidate('cleanup')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(commands.count('docker compose stop db'), 1)
        self.assertIn('cleanup: 1', evidence)

    def test_interruption_stops_owned_database_and_preserves_failure_status(self):
        result, commands, evidence = self.run_candidate('interrupt')
        self.assertEqual(result.returncode, 143)
        self.assertEqual(commands.count('docker compose stop db'), 1)
        self.assertIn('cleanup: 0', evidence)
        self.assertNotIn('docker build', commands)

    def test_each_browser_suite_retains_its_own_reports_before_next_suite_overwrites_them(self):
        result, commands, evidence = self.run_candidate('studio')
        self.assertEqual(result.returncode, 1)
        self.assertIn('studio: 1', evidence)
        self.assertIn('live-browser: 0', evidence)
        for name, command in [('demo', 'test:browser'), ('studio', 'test:browser:studio'),
                              ('live-browser', 'test:browser:live')]:
            for report in ['test-results', 'playwright-report']:
                with self.subTest(suite=name, report=report):
                    self.assertEqual(self.reports.get(f'{name}-reports/{report}/suite.txt'),
                                     f'run {command}\n')
        self.assertIn('docker compose stop db', commands)

    def test_report_copy_failure_fails_aggregate_even_when_browser_tests_pass(self):
        result, commands, evidence = self.run_candidate('copy')
        self.assertEqual(result.returncode, 1)
        for name in ['demo', 'studio', 'live-browser']:
            self.assertIn(f'{name}: 0', evidence)
        self.assertIn('Failed to retain demo reports', result.stdout)

if __name__ == '__main__':
    unittest.main()
