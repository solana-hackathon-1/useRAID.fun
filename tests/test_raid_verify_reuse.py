"""Contracts for local-first verification and reuse of an already-green Checks run (DEC-2026-10-27-01).

Fake `gh`/npm executables stand in for hosted services; no credentials, network or containers are used.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TREE = '1' * 40
OTHER = '2' * 40


def run_reuse(runs, trees, tree=TREE, gh_fails=False):
    """Run scripts/ci-reuse-checks.py against a fake `gh api`, returning (result, outputs)."""
    with tempfile.TemporaryDirectory() as directory:
        host = Path(directory)
        (host / 'runs.json').write_text(json.dumps({'workflow_runs': runs}))
        (host / 'trees.json').write_text(json.dumps(trees))
        gh = host / 'gh'
        gh.write_text('#!/usr/bin/env python3\n'
            'import json, os, sys\n'
            'host = os.environ["FAKE_HOST"]\n'
            'if os.environ.get("GH_FAILS") == "true": sys.exit(1)\n'
            'path = sys.argv[2]\n'
            'if "/actions/workflows/checks.yml/runs" in path:\n'
            '    print(open(host + "/runs.json").read())\n'
            'elif "/git/commits/" in path:\n'
            '    sha = path.rsplit("/", 1)[1]\n'
            '    trees = json.load(open(host + "/trees.json"))\n'
            '    if sha not in trees: sys.exit(1)\n'
            '    print(json.dumps({"tree": {"sha": trees[sha]}}))\n'
            'else:\n'
            '    sys.exit(2)\n')
        gh.chmod(0o755)
        git = host / 'git'
        git.write_text('#!/bin/sh\nprintf "%s\\n" "$FAKE_TREE"\n')
        git.chmod(0o755)
        output = host / 'output'
        result = subprocess.run(['python3', str(ROOT / 'scripts/ci-reuse-checks.py')],
            capture_output=True, text=True, cwd=host,
            env={**os.environ, 'PATH': f'{host}:{os.environ["PATH"]}', 'FAKE_HOST': str(host),
                 'FAKE_TREE': tree, 'GH_FAILS': str(gh_fails).lower(),
                 'GITHUB_REPOSITORY': 'solana-hackathon-1/useRAID.fun', 'GITHUB_OUTPUT': str(output)})
        return result, dict(line.split('=', 1) for line in output.read_text().splitlines()) if output.exists() else {}


def run(id, sha, conclusion='success', event='workflow_dispatch'):
    return {'id': id, 'head_sha': sha, 'conclusion': conclusion, 'event': event}


class ReuseGreenChecks(unittest.TestCase):
    def test_green_run_on_identical_tree_is_reused(self):
        result, out = run_reuse([run(7, 'a1' * 20)], {'a1' * 20: TREE})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out, {'verified': 'true', 'verified_run': '7'})

    def test_newest_matching_run_is_chosen_after_skipping_other_trees(self):
        result, out = run_reuse([run(9, 'b2' * 20), run(8, 'a1' * 20)], {'b2' * 20: OTHER, 'a1' * 20: TREE})
        self.assertEqual(out['verified_run'], '8')

    def test_different_tree_is_not_reused(self):
        result, out = run_reuse([run(7, 'a1' * 20)], {'a1' * 20: OTHER})
        self.assertEqual(out['verified'], 'false')

    def test_failed_cancelled_and_non_dispatch_runs_are_never_reused(self):
        for item in [run(1, 'a1' * 20, 'failure'), run(2, 'a1' * 20, 'cancelled'),
                     run(3, 'a1' * 20, None), run(4, 'a1' * 20, event='push')]:
            with self.subTest(run=item['id']):
                result, out = run_reuse([item], {'a1' * 20: TREE})
                self.assertEqual(out['verified'], 'false')

    def test_every_lookup_failure_falls_back_to_full_checks_without_failing_the_job(self):
        result, out = run_reuse([run(7, 'a1' * 20)], {'a1' * 20: TREE}, gh_fails=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out['verified'], 'false')
        result, out = run_reuse([run(7, 'a1' * 20)], {})  # commit lookup fails
        self.assertEqual(out['verified'], 'false')

    def test_malformed_tree_is_never_trusted(self):
        result, out = run_reuse([run(7, 'a1' * 20)], {'a1' * 20: ''}, tree='')
        self.assertEqual(out['verified'], 'false')


class StagingWorkflowWiring(unittest.TestCase):
    source = (ROOT / '.github/workflows/staging-image.yml').read_text()

    def test_reuse_decision_is_made_by_a_read_only_job_before_publication(self):
        reuse = self.source.split('  reuse:', 1)[1].split('\n  publish:', 1)[0]
        self.assertIn('python3 scripts/ci-reuse-checks.py', reuse)
        self.assertIn('actions: read', reuse)
        self.assertNotIn('packages: write', reuse)
        self.assertIn('needs: reuse', self.source)

    def test_only_verification_steps_are_skippable_and_artifact_steps_never_are(self):
        steps = self.source.split('    steps:', 1)[1].split('\n      - name: ')
        skippable = "needs.reuse.outputs.verified != 'true'"
        for step in steps[1:]:
            name = step.split('\n', 1)[0]
            guarded = skippable in step
            if name.startswith(('Build production image', 'Runtime image smoke', 'Publish checked revision')):
                self.assertFalse(guarded, name)
            else:
                self.assertTrue(guarded, name)

    def test_checks_run_before_registry_credentials_when_not_reused(self):
        for check in ['npm run audit:check', 'npm test', 'npm run typecheck', 'unittest discover']:
            self.assertLess(self.source.index(check), self.source.index('docker login ghcr.io'))

    def test_reuse_records_which_run_was_trusted(self):
        self.assertIn('verified_run', self.source)


class LocalVerifyGate(unittest.TestCase):
    def setup_repo(self, directory, commands_fail=()):
        host = Path(directory)
        repo = host / 'repo'
        repo.mkdir()
        bin_dir = host / 'bin'
        bin_dir.mkdir()
        log = host / 'commands.log'
        for name in ['npm', 'npx', 'python3', 'bash']:
            if name == 'bash':
                continue
            exe = bin_dir / name
            exe.write_text('#!/bin/sh\nprintf "%s\\n" "' + name + ' $*" >> "$COMMAND_LOG"\n'
                           'for f in $FAIL_ON; do case "$*" in *"$f"*) exit 3;; esac; done\nexit 0\n')
            exe.chmod(0o755)
        env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'COMMAND_LOG': str(log),
               'FAIL_ON': ' '.join(commands_fail), 'GIT_CONFIG_GLOBAL': '/dev/null'}
        def git(*args):
            return subprocess.run(['git', *args], cwd=repo, capture_output=True, text=True, env=env, check=True).stdout.strip()
        git('init', '-q', '-b', 'main')
        git('config', 'user.email', 't@example.com')
        git('config', 'user.name', 't')
        (repo / 'a.txt').write_text('a\n')
        git('add', '.')
        git('commit', '-q', '-m', 'init')
        git('checkout', '-q', '-b', 'feature')
        for name in ['verify.sh', 'ci-browser-scope.py']:
            (repo / 'scripts').mkdir(exist_ok=True)
            (repo / 'scripts' / name).write_text((ROOT / 'scripts' / name).read_text())
        (repo / '.githooks').mkdir()
        (repo / '.githooks/pre-push').write_text((ROOT / '.githooks/pre-push').read_text())
        (repo / '.githooks/pre-push').chmod(0o755)
        git('add', '.')
        git('commit', '-q', '-m', 'tooling')
        return repo, env, log, git

    def verify(self, repo, env, tier='fast'):
        return subprocess.run(['bash', 'scripts/verify.sh', tier], cwd=repo, capture_output=True, text=True, env=env)

    def test_fast_tier_runs_every_cheap_layer_and_writes_a_tree_bound_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, env, log, git = self.setup_repo(directory)
            result = self.verify(repo, env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            commands = log.read_text()
            for layer in ['unittest discover', 'typecheck', 'lint', 'prettier', 'vitest run']:
                self.assertIn(layer, commands)
            receipt = json.loads((repo / '.git/raid-verify' / (git('rev-parse', 'HEAD^{tree}') + '.json')).read_text())
            self.assertEqual(receipt['tier'], 'fast')
            self.assertEqual(receipt['result'], 'pass')
            self.assertEqual(receipt['head'], git('rev-parse', 'HEAD'))

    def test_failing_layer_fails_the_gate_and_records_no_passing_receipt(self):
        for failing in ['typecheck', 'lint', 'vitest']:
            with self.subTest(layer=failing), tempfile.TemporaryDirectory() as directory:
                repo, env, log, git = self.setup_repo(directory, commands_fail=[failing])
                result = self.verify(repo, env)
                self.assertNotEqual(result.returncode, 0)
                path = repo / '.git/raid-verify' / (git('rev-parse', 'HEAD^{tree}') + '.json')
                self.assertFalse(path.exists() and json.loads(path.read_text())['result'] == 'pass')

    def test_dirty_tracked_tree_refuses_to_issue_a_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, env, log, git = self.setup_repo(directory)
            (repo / 'a.txt').write_text('changed\n')
            result = self.verify(repo, env)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((repo / '.git/raid-verify').exists())

    def test_uncommitted_session_checkpoint_does_not_block_a_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, env, log, git = self.setup_repo(directory)
            (repo / 'docs/ai-handoff').mkdir(parents=True)
            (repo / 'docs/ai-handoff/CURRENT.md').write_text('one\n')
            git('add', '.')
            git('commit', '-q', '-m', 'checkpoint')
            (repo / 'docs/ai-handoff/CURRENT.md').write_text('two\n')
            self.assertEqual(self.verify(repo, env).returncode, 0)

    def test_full_tier_delegates_to_the_existing_local_ci_runner_and_selected_feature_suites(self):
        source = (ROOT / 'scripts/verify.sh').read_text()
        self.assertIn('scripts/local-ci.sh', source)
        self.assertIn('scripts/ci-browser-scope.py', source)
        self.assertIn('RAID_VERIFY_FEATURE_BROWSERS', source)

    def test_local_runner_runs_only_validated_feature_suites_while_the_database_is_still_owned(self):
        runner = (ROOT / 'scripts/local-ci.sh').read_text()
        loop = runner.split('RAID_CI_FEATURE_SUITES', 1)[1].split('\nelse', 1)[0]
        self.assertIn('^[a-z]+(-[a-z]+)*$', loop)
        self.assertIn('playwright.$suite.config.ts', loop)
        self.assertIn('unknown suite name', loop)
        self.assertLess(runner.index('RAID_CI_FEATURE_SUITES'), runner.index('step build '))

    def prepush(self, repo, env, local_sha, remote_sha='0' * 40, extra_env=None):
        return subprocess.run(['sh', '.githooks/pre-push', 'origin', 'url'], cwd=repo, capture_output=True, text=True,
            input=f'refs/heads/x {local_sha} refs/heads/x {remote_sha}\n', env={**env, **(extra_env or {})})

    def issue(self, repo, git, tier, result='pass'):
        directory = repo / '.git/raid-verify'
        directory.mkdir(exist_ok=True)
        (directory / (git('rev-parse', 'HEAD^{tree}') + '.json')).write_text(
            json.dumps({'tier': tier, 'result': result, 'head': git('rev-parse', 'HEAD')}))

    def test_hook_blocks_push_without_a_full_passing_receipt_for_the_pushed_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, env, log, git = self.setup_repo(directory)
            sha = git('rev-parse', 'HEAD')
            self.assertNotEqual(self.prepush(repo, env, sha).returncode, 0)
            self.issue(repo, git, 'fast')
            self.assertNotEqual(self.prepush(repo, env, sha).returncode, 0)
            self.issue(repo, git, 'full', 'fail')
            self.assertNotEqual(self.prepush(repo, env, sha).returncode, 0)

    def test_hook_allows_push_with_full_receipt_deletions_and_documented_bypass(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, env, log, git = self.setup_repo(directory)
            sha = git('rev-parse', 'HEAD')
            self.issue(repo, git, 'full')
            self.assertEqual(self.prepush(repo, env, sha).returncode, 0)
            self.assertEqual(self.prepush(repo, env, '0' * 40, sha).returncode, 0)  # branch deletion
            (repo / '.git/raid-verify').joinpath(git('rev-parse', 'HEAD^{tree}') + '.json').unlink()
            result = self.prepush(repo, env, sha, extra_env={'RAID_SKIP_PREPUSH': '1'})
            self.assertEqual(result.returncode, 0)
            self.assertIn('bypassed', result.stderr)

    def test_docs_only_push_accepts_a_fast_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, env, log, git = self.setup_repo(directory)
            (repo / 'docs').mkdir()
            (repo / 'docs/note.md').write_text('note\n')
            git('add', '.')
            git('commit', '-q', '-m', 'docs')
            git('checkout', '-q', 'main')
            git('merge', '-q', '--ff-only', 'feature~1')  # main now holds tooling; docs commit is the only difference
            git('checkout', '-q', 'feature')
            sha = git('rev-parse', 'HEAD')
            self.issue(repo, git, 'fast')
            self.assertEqual(self.prepush(repo, env, sha).returncode, 0)

    def test_hook_is_opt_in_through_the_install_command_only(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, env, log, git = self.setup_repo(directory)
            self.assertEqual(subprocess.run(['git', 'config', '--get', 'core.hooksPath'], cwd=repo, env=env,
                                            capture_output=True, text=True).stdout, '')
            result = subprocess.run(['bash', 'scripts/verify.sh', 'install'], cwd=repo, capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(git('config', '--get', 'core.hooksPath'), '.githooks')


if __name__ == '__main__':
    unittest.main()
