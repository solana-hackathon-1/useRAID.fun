"""Staging deployment contracts; command substitutes require no provider credentials."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StagingStartup(unittest.TestCase):
    def run_start(self, mode, migration_status=0):
        with tempfile.TemporaryDirectory() as directory:
            host = Path(directory)
            commands = host / 'commands'
            for name in ['npm', 'node']:
                executable = host / name
                executable.write_text('#!/bin/sh\n'
                    'printf "%s\\n" "' + name + ' $*" >> "$COMMAND_LOG"\n'
                    + ('exit "$MIGRATION_STATUS"\n' if name == 'npm' else 'exit 0\n'))
                executable.chmod(0o755)
            result = subprocess.run(['sh', str(ROOT / 'scripts/staging-start.sh'), mode],
                cwd=host, capture_output=True, text=True,
                env={**os.environ, 'PATH': f'{host}:{os.environ["PATH"]}',
                    'COMMAND_LOG': str(commands), 'MIGRATION_STATUS': str(migration_status)})
            return result, commands.read_text().splitlines() if commands.exists() else []

    def test_web_starts_only_after_migrations(self):
        result, commands = self.run_start('web')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(commands, ['npm run db:migrate',
            'node node_modules/next/dist/bin/next start --hostname 0.0.0.0'])

    def test_worker_starts_only_after_migrations(self):
        result, commands = self.run_start('worker')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(commands, ['npm run db:migrate', 'node --import tsx src/worker.ts'])

    def test_migration_failure_never_launches_either_process(self):
        for mode in ['web', 'worker']:
            with self.subTest(mode=mode):
                result, commands = self.run_start(mode, 23)
                self.assertEqual(result.returncode, 23)
                self.assertEqual(commands, ['npm run db:migrate'])

    def test_unknown_role_performs_no_database_mutation(self):
        result, commands = self.run_start('database')
        self.assertEqual(result.returncode, 64)
        self.assertEqual(commands, [])


class StagingPublication(unittest.TestCase):
    def run_publish(self, current=True, failed_push=False):
        with tempfile.TemporaryDirectory() as directory:
            host = Path(directory)
            log = host / 'commands'
            for name, body in {
                'docker': 'printf "%s\\n" "docker $*" >> "$COMMAND_LOG"\n'
                          'if [ "$FAIL_PUSH" = true ] && [ "$1" = push ]; then exit 9; fi\n',
                'git': 'printf "%s\\n" "$REMOTE_SHA refs/heads/main"\n',
            }.items():
                executable = host / name
                executable.write_text('#!/bin/sh\n' + body)
                executable.chmod(0o755)
            result = subprocess.run(['bash', str(ROOT / 'scripts/staging-publish.sh'), 'useraid:publish'],
                capture_output=True, text=True,
                env={**os.environ, 'PATH': f'{host}:{os.environ["PATH"]}',
                    'GITHUB_REPOSITORY': 'solana-hackathon-1/useRAID.fun',
                    'GITHUB_SHA': 'a' * 40, 'REMOTE_SHA': ('a' if current else 'b') * 40,
                    'COMMAND_LOG': str(log), 'FAIL_PUSH': str(failed_push).lower()})
            return result, log.read_text().splitlines() if log.exists() else []

    def test_success_publishes_immutable_revision_before_staging(self):
        result, commands = self.run_publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        image = 'ghcr.io/solana-hackathon-1/useraid.fun'
        self.assertEqual(commands, [f'docker tag useraid:publish {image}:sha-' + 'a' * 40,
            f'docker push {image}:sha-' + 'a' * 40,
            f'docker tag useraid:publish {image}:staging', f'docker push {image}:staging'])

    def test_superseded_main_never_promotes_staging(self):
        result, commands = self.run_publish(current=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(commands), 2)
        self.assertTrue(all(':staging' not in command for command in commands))

    def test_failed_immutable_push_never_promotes_staging(self):
        result, commands = self.run_publish(failed_push=True)
        self.assertEqual(result.returncode, 9)
        self.assertEqual(len(commands), 2)
        self.assertTrue(all(':staging' not in command for command in commands))


class StagingConsumingHost(unittest.TestCase):
    def test_catalog_editor_and_disabled_host_run_before_artifacts(self):
        commands = ['npx playwright test --config=playwright.skill-editor.config.ts',
                    'SKILL_EDITOR_TEST_WRITES=false npx playwright test --config=playwright.skill-editor.config.ts']
        for file, artifact in [('checks.yml', '- name: Production build'),
                               ('staging-image.yml', '- name: Build production image')]:
            with self.subTest(workflow=file):
                source = (ROOT / '.github/workflows' / file).read_text()
                for command in commands:
                    self.assertIn(command, source)
                    self.assertLess(source.index(command), source.index(artifact))

    def test_admin_taxonomy_api_runs_before_production_artifact(self):
        command = 'npx playwright test --config=playwright.skill-taxonomy.config.ts'
        for file, artifact in [('checks.yml', '- name: Production build'),
                               ('staging-image.yml', '- name: Build production image')]:
            with self.subTest(workflow=file):
                source = (ROOT / '.github/workflows' / file).read_text()
                self.assertIn(command, source)
                self.assertLess(source.index(command), source.index(artifact))

    def test_private_skill_browser_runs_before_production_artifact(self):
        command = 'npx playwright test --config=playwright.skill-claims.config.ts'
        for file, artifact in [('checks.yml', '- name: Production build'),
                               ('staging-image.yml', '- name: Build production image')]:
            with self.subTest(workflow=file):
                source = (ROOT / '.github/workflows' / file).read_text()
                self.assertIn(command, source)
                self.assertLess(source.index(command), source.index(artifact))


    def test_publication_is_main_only_and_checks_precede_registry_credentials(self):
        workflow = (ROOT / '.github/workflows/staging-image.yml').read_text()
        trigger = workflow.split('on:', 1)[1].split('permissions:', 1)[0]
        self.assertIn('push:', trigger)
        self.assertIn('branches: [main]', trigger)
        self.assertIn('workflow_dispatch:', trigger)
        self.assertNotIn('pull_request', trigger)
        self.assertIn("if: github.ref == 'refs/heads/main'", workflow)
        self.assertIn('runs-on: ubuntu-24.04-arm', workflow)
        for check in ['npm run audit:check', 'npm test', 'npm run typecheck',
                      'unittest discover', 'docker build', 'Runtime image smoke']:
            self.assertLess(workflow.index(check), workflow.index('docker login ghcr.io'))
        self.assertIn('packages: write', workflow)
        self.assertIn('contents: read', workflow)
        self.assertIn('staging-publish.sh useraid:publish', workflow)
        self.assertNotIn('ssh ', workflow)

    def test_rendered_compose_is_private_and_limits_updates_to_application(self):
        with tempfile.TemporaryDirectory() as directory:
            host = Path(directory)
            for name in ['.env.app', '.env.web', '.env.worker']:
                (host / name).write_text('')
            result = subprocess.run(['docker', 'compose', '--project-directory', str(host),
                '-f', str(ROOT / 'compose.staging.yaml'), 'config', '--format', 'json'],
                capture_output=True, text=True,
                env={**os.environ, 'STAGING_ROOT': str(host), 'STAGING_BIND_ADDRESS': '192.168.101.13',
                    'STAGING_HTTPS_PORT': '8443'})
            self.assertEqual(result.returncode, 0, result.stderr)
            services = json.loads(result.stdout)['services']
            watched = []
            for name, service in services.items():
                labels = service.get('labels', {})
                if labels.get('com.centurylinklabs.watchtower.enable') == 'true':
                    watched.append(name)
                if name in ['db', 'web', 'worker', 'watchtower']:
                    self.assertFalse(service.get('ports'), name)
            self.assertEqual(sorted(watched), ['web', 'worker'])
            for role in ['web', 'worker']:
                app = services[role]
                self.assertEqual(app['command'], ['sh', '/app/scripts/staging-start.sh', role])
                self.assertEqual(app['environment']['ACCOUNT_FOLDS_ENABLED'], 'false')
                self.assertEqual(app['environment']['X_TRACKING_V2_SETTLEMENT_ENABLED'], 'false')
                self.assertEqual(app['labels']['com.centurylinklabs.watchtower.scope'], 'useraid-staging')
                self.assertNotIn('/var/run/docker.sock', str(app.get('volumes', [])))
            self.assertEqual(services['proxy']['ports'][0]['host_ip'], '192.168.101.13')
            watcher = services['watchtower']
            self.assertEqual(watcher['environment']['WATCHTOWER_SCOPE'], 'useraid-staging')
            self.assertEqual(watcher['environment']['WATCHTOWER_LABEL_ENABLE'], 'true')
            self.assertEqual(watcher['environment']['WATCHTOWER_INCLUDE_RESTARTING'], 'true')
            self.assertIn('postgres', json.loads(result.stdout)['volumes'])


if __name__ == '__main__':
    unittest.main()
