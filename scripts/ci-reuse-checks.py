"""Report whether a successful manual Checks run already verified this exact source tree (stdlib only).

Any lookup failure reports `verified=false` so the caller falls back to running every check.
"""
import json
import os
import re
import subprocess
import sys

RUNS = 30


def find_verified(tree, runs, tree_of):
    """Return the newest successful dispatched run whose commit tree equals `tree`, else None."""
    for run in runs:
        if run.get('conclusion') != 'success' or run.get('event') != 'workflow_dispatch':
            continue
        if tree_of(run['head_sha']) == tree:
            return run['id']
    return None


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', path], text=True, stderr=subprocess.DEVNULL))


def main():
    run_id = None
    try:
        repo = os.environ['GITHUB_REPOSITORY']
        tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip()
        if not re.fullmatch('[0-9a-f]{40}', tree):
            raise ValueError('Unidentified source tree')
        runs = api(f'repos/{repo}/actions/workflows/checks.yml/runs?status=success&event=workflow_dispatch&per_page={RUNS}')['workflow_runs']
        trees = {}

        def tree_of(sha):
            if sha not in trees:
                trees[sha] = api(f'repos/{repo}/git/commits/{sha}')['tree']['sha']
            return trees[sha]

        run_id = find_verified(tree, runs, tree_of)
    except (KeyError, ValueError, TypeError, OSError, subprocess.CalledProcessError) as error:
        print(f'Checks reuse unavailable, running every check: {error.__class__.__name__}')
        run_id = None
    verified = run_id is not None
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'verified={str(verified).lower()}\n')
            if verified:
                output.write(f'verified_run={run_id}\n')
    print(f'Verified by Checks run {run_id}' if verified else 'No green Checks run matches this source tree.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
