"""Conservative browser selection for a complete candidate branch (stdlib only)."""
import json
import os
from pathlib import Path
import subprocess

SUITES = (
    'demo', 'studio', 'onboarding', 'guild-drafts', 'project-proposals', 'skill-claims',
    'own-assessments', 'practice-portal', 'work-workspace', 'work-creation', 'notifications',
    'practice-review', 'practice-review-inbox', 'assignment-management', 'practice-ownership',
    'practice-assessment', 'skill-taxonomy', 'skill-editor', 'live',
)
WORK = {'work-workspace', 'work-creation', 'notifications'}


def full(reason):
    return {'mode': 'full', 'suites': list(SUITES), 'reason': reason}


def select(paths):
    if not paths:
        return full('No candidate difference; full verification required.')
    chosen = set()
    for path in paths:
        if path.startswith('docs/') or path in {
            'README.md', 'AGENTS.md', 'CLAUDE.md', 'WARP.md', 'RAID_AGENT_BLUEPRINT.md',
            'RAID_BLUEPRINT_MAP.md', '.github/pull_request_template.md',
        }:
            continue
        if path.startswith('tests/test_raid_') and path.endswith('.py'):
            continue  # Always executed by planning-contracts, not a browser dependency.
        if path.startswith(('src/notifications/', 'src/lib/notifications-',
                            'src/app/notifications/', 'src/app/api/v1/notifications/',
                            'tests/notifications-', 'tests/helpers/notifications-')) or path == 'src/components/notifications-panel.tsx':
            chosen.add('notifications')
        elif path == 'src/components/work-wizard.tsx' or path.startswith((
            'src/lib/work-creation-', 'src/work-http/creation-', 'src/app/creator/work/new/',
            'src/app/api/v1/work/creation/', 'src/app/api/v1/work/drafts/',
            'src/app/api/v1/work/recommendations/',
        )):
            chosen.add('work-creation')
        elif path.startswith(('src/work-loop/', 'src/work-http/', 'src/lib/work-',
                              'tests/work-', 'tests/helpers/work-', 'examples/raid-terms/')):
            chosen.update(WORK)
        else:
            matches = {suite for suite in SUITES
                       if path == f'playwright.{suite}.config.ts'
                       or path.startswith(f'tests/browser-{suite}/')}
            if path == 'playwright.config.ts':
                matches.add('demo')
            if not matches:
                return full('Shared infrastructure, migration or unclassified path changed.')
            chosen.update(matches)
    return {'mode': 'affected', 'suites': [suite for suite in SUITES if suite in chosen],
            'reason': 'Explicit feature dependencies; mandatory core checks remain unconditional.'}


def changed_paths(value):
    """Read git --name-status -z, including both names of renames/copies."""
    fields = value.split('\0')
    if not fields or fields.pop() != '':
        raise ValueError('Incomplete NUL-delimited diff')
    result = []
    while fields:
        status = fields.pop(0)
        count = 2 if status.startswith(('R', 'C')) and status[1:].isdigit() else 1
        if status not in {'A', 'M', 'D', 'T'} and count != 2:
            raise ValueError('Unknown diff status')
        if len(fields) < count or any(not field for field in fields[:count]):
            raise ValueError('Incomplete diff path')
        result.extend(fields[:count])
        del fields[:count]
    return result


def from_git(root, ref):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True,
                                       stderr=subprocess.DEVNULL).strip()
    # If HEAD itself cannot be determined, fail the job rather than emit unidentified evidence.
    source = git('rev-parse', 'HEAD')
    base = 'unavailable'
    try:
        tip = git('rev-parse', 'refs/remotes/origin/main')
        base = git('merge-base', source, tip)
        if ref == 'refs/heads/main' or source == tip:
            selection = full('Main dispatch requires full browser coverage.')
        elif base != tip:
            selection = full('Candidate does not include current main; comparison is conservative.')
        else:
            diff = subprocess.check_output(
                ['git', '-C', str(root), 'diff', '--name-status', '-z', '--find-renames', base, source],
                text=True, stderr=subprocess.DEVNULL)
            selection = select(changed_paths(diff))
    except (subprocess.CalledProcessError, ValueError, UnicodeError):
        selection = full('Comparison unavailable or malformed; no selective omission permitted.')
    return {**selection, 'source': source, 'base': base}


def main():
    selection = from_git(Path.cwd(), os.environ.get('GITHUB_REF', ''))
    suites = json.dumps(selection['suites'], separators=(',', ':'))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'browser_suites={suites}\n')
            output.write(f'browser_required={str(bool(selection["suites"])).lower()}\n')
            output.write(f'source_sha={selection["source"]}\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        skipped = [suite for suite in SUITES if suite not in selection['suites']]
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write(f'### Browser coverage: {selection["mode"]}\n\n')
            summary.write(f'Source: `{selection["source"]}`; comparison base: `{selection["base"]}`.\n\n')
            summary.write(f'{selection["reason"]}\n\n')
            summary.write('Selected: ' + (', '.join(selection['suites']) or 'none') + '.\n\n')
            summary.write('Skipped as unaffected: ' + (', '.join(skipped) or 'none') + '.\n')
    print(json.dumps(selection))


if __name__ == '__main__':
    main()
