"""Reject failed core jobs or missing/failed selected browser coverage."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


def main():
    try:
        spec = importlib.util.spec_from_file_location('scope', Path(__file__).with_name('ci-browser-scope.py'))
        scope = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scope)
        jobs = json.loads(os.environ['JOB_RESULTS'])
        for name in ['planning-contracts', 'static', 'dependency-security', 'test', 'docker']:
            if jobs[name]['result'] != 'success':
                raise ValueError(f'Required job {name} did not succeed')
        output = jobs['planning-contracts']['outputs']
        source = output['source_sha']
        if not re.fullmatch('[0-9a-f]{40}', source) or source != os.environ['GITHUB_SHA']:
            raise ValueError('Selection source does not match this candidate')
        selected = json.loads(output['browser_suites'])
        if not isinstance(selected, list) or any(not isinstance(s, str) or s not in scope.SUITES for s in selected):
            raise ValueError('Missing or invalid browser selection')
        if len(set(selected)) != len(selected) or output['browser_required'] != str(bool(selected)).lower():
            raise ValueError('Inconsistent browser selection')
        expected = 'success' if selected else 'skipped'
        if jobs['browser']['result'] != expected:
            raise ValueError(f'Browser job must be {expected} for this selection')
    except (KeyError, ValueError, TypeError) as error:
        print(f'CI gate rejected candidate: {error}')
        return 1
    print('Every mandatory check and selected browser suite passed for this candidate.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
