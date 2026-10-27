"""Behavior contracts for conservative browser selection and the aggregate CI gate."""
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHA = 'a' * 40


def module():
    spec = importlib.util.spec_from_file_location('ci_browser_scope', ROOT / 'scripts/ci-browser-scope.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class BrowserSelection(unittest.TestCase):
    def test_notifications_change_runs_notifications_only(self):
        scope = module().select(['src/notifications/storage.ts'])
        self.assertEqual(scope['suites'], ['notifications'])

    def test_work_domain_changes_include_creation_workspace_and_notification_consumers(self):
        self.assertEqual(set(module().select(['src/work-loop/storage.ts'])['suites']),
                         {'work-creation', 'work-workspace', 'notifications'})

    def test_multiple_features_are_unioned_without_duplicates(self):
        self.assertEqual(set(module().select(['src/notifications/storage.ts',
                                             'src/components/work-wizard.tsx',
                                             'tests/browser-notifications/notifications.spec.ts'])['suites']),
                         {'notifications', 'work-creation'})

    def test_documentation_only_explicitly_selects_no_browser_suite(self):
        scope = module().select(['docs/raid-notifications.md', 'RAID_AGENT_BLUEPRINT.md'])
        self.assertEqual(scope['suites'], [])
        self.assertEqual(scope['mode'], 'affected')

    def test_shared_migration_unknown_and_uncertain_changes_each_fall_back_to_full(self):
        for paths in [['prisma/migrations/new/migration.sql'], ['src/lib/auth.ts'],
                      ['package-lock.json'], ['.github/workflows/checks.yml'], ['src/new-feature.ts'], []]:
            with self.subTest(paths=paths):
                scope = module().select(paths)
                self.assertEqual(scope['mode'], 'full')
                self.assertEqual(scope['suites'], list(module().SUITES))

    def test_renames_include_both_old_and_new_paths_and_deletions_are_not_lost(self):
        paths = module().changed_paths('R100\0src/lib/auth.ts\0docs/old-auth.md\0D\0src/notifications/http.ts\0')
        self.assertEqual(paths, ['src/lib/auth.ts', 'docs/old-auth.md', 'src/notifications/http.ts'])
        self.assertEqual(module().select(paths)['mode'], 'full')
        self.assertEqual(module().select(module().changed_paths('D\0src/notifications/http.ts\0'))['suites'],
                         ['notifications'])

    def test_malformed_diff_is_rejected_instead_of_silently_selecting_nothing(self):
        for value in ['R100\0old\0', 'M\0', 'garbage\0file\0']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                module().changed_paths(value)

    def test_git_comparison_uses_all_branch_commits_and_falls_back_for_missing_or_stale_main(self):
        scope = module()
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, *args], text=True).strip()
            git('init', '-b', 'main')
            git('config', 'user.email', 'synthetic@example.test')
            git('config', 'user.name', 'CI fixture')
            (repo / 'README.md').write_text('fixture')
            git('add', '.')
            git('commit', '-m', 'base')
            base = git('rev-parse', 'HEAD')
            git('update-ref', 'refs/remotes/origin/main', base)
            git('switch', '-c', 'candidate')
            (repo / 'src/notifications').mkdir(parents=True)
            (repo / 'src/notifications/storage.ts').write_text('fixture')
            git('add', '.')
            git('commit', '-m', 'feature')
            (repo / 'README.md').write_text('second commit')
            git('commit', '-am', 'docs')
            selected = scope.from_git(repo, 'refs/heads/candidate')
            self.assertEqual(selected['suites'], ['notifications'])
            self.assertEqual(selected['base'], base)
            self.assertEqual(selected['source'], git('rev-parse', 'HEAD'))
            self.assertEqual(scope.from_git(repo, 'refs/heads/main')['mode'], 'full')
            git('switch', 'main')
            (repo / 'README.md').write_text('main advanced')
            git('commit', '-am', 'advance')
            git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'))
            git('switch', 'candidate')
            self.assertEqual(scope.from_git(repo, 'refs/heads/candidate')['mode'], 'full')
            git('update-ref', '-d', 'refs/remotes/origin/main')
            self.assertEqual(scope.from_git(repo, 'refs/heads/candidate')['mode'], 'full')


class AggregateGate(unittest.TestCase):
    def candidate(self, suites=('notifications',), browser='success'):
        jobs = {name: {'result': 'success'} for name in
                ['planning-contracts', 'static', 'dependency-security', 'test', 'docker']}
        jobs['planning-contracts']['outputs'] = {
            'browser_suites': json.dumps(list(suites)), 'source_sha': SHA,
            'browser_required': 'true' if suites else 'false',
        }
        jobs['browser'] = {'result': browser}
        return jobs

    def gate(self, jobs):
        return subprocess.run(['python3', str(ROOT / 'scripts/ci-gate.py')], capture_output=True,
                              text=True, env={**os.environ, 'JOB_RESULTS': json.dumps(jobs), 'GITHUB_SHA': SHA})

    def test_all_required_checks_and_selected_browser_succeed(self):
        self.assertEqual(self.gate(self.candidate()).returncode, 0)

    def test_browser_skip_is_allowed_only_for_an_explicit_valid_empty_selection(self):
        self.assertEqual(self.gate(self.candidate((), 'skipped')).returncode, 0)
        self.assertNotEqual(self.gate(self.candidate(browser='skipped')).returncode, 0)

    def test_each_failed_cancelled_or_skipped_required_check_rejects_the_candidate(self):
        for name in self.candidate():
            for state in ['failure', 'cancelled', 'skipped']:
                with self.subTest(name=name, state=state):
                    jobs = self.candidate()
                    jobs[name]['result'] = state
                    self.assertNotEqual(self.gate(jobs).returncode, 0)

    def test_missing_jobs_missing_selection_invalid_selection_or_wrong_source_fail_closed(self):
        for mutation in ['missing-job', 'missing-output', 'malformed', 'unknown', 'wrong-source', 'inconsistent']:
            with self.subTest(mutation=mutation):
                jobs = self.candidate((), 'skipped')
                output = jobs['planning-contracts']['outputs']
                if mutation == 'missing-job': del jobs['test']
                elif mutation == 'missing-output': del jobs['planning-contracts']['outputs']
                elif mutation == 'malformed': output['browser_suites'] = 'not json'
                elif mutation == 'unknown': output['browser_suites'] = '["unknown"]'
                elif mutation == 'wrong-source': output['source_sha'] = 'b' * 40
                else: output['browser_required'] = 'true'
                self.assertNotEqual(self.gate(jobs).returncode, 0)


class WorkflowWiring(unittest.TestCase):
    def test_selection_is_published_and_browser_requires_the_selection_job(self):
        workflow = (ROOT / '.github/workflows/checks.yml').read_text()
        planning = workflow.split('  planning-contracts:', 1)[1].split('  static:', 1)[0]
        for required in ['fetch-depth: 0', 'id: browser-scope', 'python3 scripts/ci-browser-scope.py',
                         'browser_suites: ${{ steps.browser-scope.outputs.browser_suites }}',
                         'browser_required: ${{ steps.browser-scope.outputs.browser_required }}',
                         'source_sha: ${{ steps.browser-scope.outputs.source_sha }}']:
            self.assertIn(required, planning)
        browser = workflow.split('  browser:', 1)[1].split('  ci-gate:', 1)[0]
        self.assertIn('needs: planning-contracts', browser)
        self.assertIn("if: needs.planning-contracts.outputs.browser_required == 'true'", browser)

    def test_every_browser_command_is_guarded_by_its_selected_suite(self):
        workflow = (ROOT / '.github/workflows/checks.yml').read_text()
        browser = workflow.split('  browser:', 1)[1].split('  ci-gate:', 1)[0]
        for step in browser.split('      - name: ')[1:]:
            commands = re.findall(r'(?:playwright test(?: --config=playwright\.([\w-]+)\.config\.ts)?|npm run test:(browser(?::(?:studio|live))?|live))', step)
            for config, npm in commands:
                suite = config or {'browser': 'demo', 'browser:studio': 'studio',
                                   'browser:live': 'live', 'live': 'live'}.get(npm, 'demo')
                with self.subTest(step=step.splitlines()[0]):
                    self.assertIn(f"if: contains(fromJSON(needs.planning-contracts.outputs.browser_suites), '{suite}')", step)

    def test_gate_runs_the_tested_validator_and_core_jobs_stay_unconditional(self):
        workflow = (ROOT / '.github/workflows/checks.yml').read_text()
        gate = workflow.split('  ci-gate:', 1)[1]
        self.assertIn('if: always()', gate)
        self.assertIn('JOB_RESULTS: ${{ toJSON(needs) }}', gate)
        self.assertIn('python3 scripts/ci-gate.py', gate)
        for name in ['planning-contracts', 'static', 'dependency-security', 'test', 'docker']:
            block = re.search(rf'(?ms)^  {name}:.*?(?=^  [a-z]|\Z)', workflow).group()
            self.assertNotRegex(block.split('    steps:', 1)[0], r'\bif:')
        self.assertIn("if: always() && contains(fromJSON(needs.planning-contracts.outputs.browser_suites), 'studio')", workflow)


if __name__ == '__main__':
    unittest.main()
