#!/usr/bin/env python3
"""Validate a RAID completion packet's structure; humans still verify evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ['canonical_reference', 'repository_facts', 'entities', 'permissions',
            'state_transitions', 'setup', 'action', 'expected', 'observed',
            'evidence_url', 'sha', 'environment', 'reviewer']


def validate(task_id, report, registry):
    errors = []
    packet = registry['packets'].get(task_id)
    if not packet:
        return ['Unknown task ID']
    present = {c['id'] for c in packet['criteria']}
    mandatory = {task_id + '-C' + f'{i:02d}' for i in range(1, 23)}
    if not mandatory <= present:
        errors.append('Task registry omits mandatory core contracts: ' + ', '.join(sorted(mandatory - present)))
    current = hashlib.sha256((ROOT / 'RAID_AGENT_BLUEPRINT.md').read_bytes()).hexdigest()
    if registry['blueprint_sha256'] != current:
        errors.append('Canonical blueprint changed: reconcile task contracts first')
    if report.get('task_id') != task_id:
        errors.append('Completion report task ID does not match')
    for key in ['implementer', 'reviewer', 'handoff', 'migration_rollback',
                'dependency_evidence', 'open_decisions', 'release_gate_disposition']:
        if not report.get(key):
            errors.append('Missing report field: ' + key)
    if report.get('reviewer') == report.get('implementer'):
        errors.append('Implementation owner cannot supply their own independent review')
    if packet.get('tdd_required'):
        tdd = report.get('tdd', {})
        if not isinstance(tdd, dict):
            errors.append('TDD evidence must be an object')
        elif tdd.get('non_code_rationale'):
            if tdd.get('acceptance_defined_before_execution') is not True or not tdd.get('reviewer') or tdd.get('reviewer') == report.get('implementer'):
                errors.append('Non-code exception requires independent review and acceptance-first evidence')
        else:
            for phase in ['red', 'green', 'refactor']:
                stage = tdd.get(phase, {})
                if not isinstance(stage, dict):
                    errors.append('Invalid TDD phase: ' + phase)
                    continue
                keys = ['command', 'sha', 'evidence_url'] + (['expected_failure', 'observed_failure'] if phase == 'red' else ['observed'])
                for key in keys:
                    if not stage.get(key):
                        errors.append('TDD ' + phase + ': missing ' + key)
                sha = stage.get('sha', '')
                if not isinstance(sha, str) or len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
                    errors.append('TDD ' + phase + ': invalid commit SHA')
                if stage.get('result') != ('FAIL' if phase == 'red' else 'PASS'):
                    errors.append('TDD ' + phase + ': incorrect or missing actual result')
    if packet.get('tdd_required') and not report.get('tdd', {}).get('non_code_rationale'):
        ci = report.get('ci', {})
        if not isinstance(ci, dict):
            errors.append('CI evidence must map required check names to results')
        else:
            for name in packet.get('ci_requirements', []):
                check = ci.get(name, {})
                if not isinstance(check, dict) or check.get('result') != 'SUCCESS':
                    errors.append('Required CI check has no successful result: ' + name)
                    continue
                if not check.get('evidence_url'):
                    errors.append('Missing CI evidence URL: ' + name)
                sha = check.get('sha', '')
                if not isinstance(sha, str) or len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
                    errors.append('Invalid CI candidate SHA: ' + name)
            candidates = {check.get('sha') for name, check in ci.items() if name in packet.get('ci_requirements', []) and isinstance(check, dict) and isinstance(check.get('sha'), str)}
            if len(candidates) > 1:
                errors.append('Required CI checks must verify the same candidate SHA')
    evidence = report.get('criteria', {})
    expected_ids = {c['id'] for c in packet['criteria']}
    if not isinstance(evidence, dict):
        return errors + ['criteria must be a mapping by exact criterion ID']
    for extra in set(evidence) - expected_ids:
        errors.append('Unknown criterion: ' + extra)
    for criterion in packet['criteria']:
        ident = criterion['id']
        record = evidence.get(ident)
        if not isinstance(record, dict):
            errors.append(ident + ': missing evidence record')
            continue
        result = record.get('result')
        if result == 'NOT APPLICABLE':
            for key in ['rationale', 'canonical_reference', 'reviewer']:
                if not record.get(key):
                    errors.append(ident + ': missing exclusion ' + key)
            if record.get('reviewer') == report.get('implementer'):
                errors.append(ident + ': self-approved exclusion')
        elif result == 'PASS':
            for key in REQUIRED:
                if not record.get(key):
                    errors.append(ident + ': missing ' + key)
            if record.get('reviewer') == report.get('implementer'):
                errors.append(ident + ': self-reviewed evidence')
            if not isinstance(record.get('sha'), str) or len(record.get('sha', '')) != 40 or any(c not in '0123456789abcdef' for c in record.get('sha', '')):
                errors.append(ident + ': invalid commit SHA')
        else:
            errors.append(ident + ': ' + str(result) + ' prevents completion')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('task_id')
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    try:
        registry = json.loads((ROOT / 'planning/raid-task-contracts.json').read_text())
        report = json.loads(args.report.read_text())
        errors = validate(args.task_id, report, registry)
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        print('Invalid completion packet: ' + str(exc), file=sys.stderr)
        return 1
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print('Completion packet structure passes; independent review must verify actual evidence. No production authority granted.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
