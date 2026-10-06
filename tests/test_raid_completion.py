import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('raid_completion', ROOT / 'scripts/verify-raid-completion.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
REGISTRY = json.loads((ROOT / 'planning/raid-task-contracts.json').read_text())


def complete_report():
    report = {key: 'Evidence-backed disposition' for key in ['handoff', 'migration_rollback', 'dependency_evidence', 'open_decisions', 'release_gate_disposition']}
    report.update(task_id='T001', implementer='implementer', reviewer='independent-reviewer')
    report['criteria'] = {c['id']: {**{key: 'Fixture evidence' for key in MODULE.REQUIRED}, 'result': 'PASS', 'sha': 'a' * 40, 'reviewer': 'independent-reviewer'} for c in REGISTRY['packets']['T001']['criteria']}
    report['tdd'] = {phase: {'command': 'recorded test command', 'sha': 'a' * 40, 'evidence_url': 'https://example.test/fixture-report', 'result': 'FAIL' if phase == 'red' else 'PASS', 'expected_failure': 'missing behavior', 'observed_failure': 'assertion failed', 'observed': 'required assertions passed'} for phase in ['red', 'green', 'refactor']}
    return report


class CompletionValidation(unittest.TestCase):
    def setUp(self):
        self.report = complete_report()

    def errors(self):
        return MODULE.validate('T001', self.report, REGISTRY)

    def test_complete_structure_passes(self):
        self.assertEqual(self.errors(), [])

    def test_registry_cannot_drop_a_mandatory_core_contract(self):
        registry = copy.deepcopy(REGISTRY)
        registry['packets']['T001']['criteria'] = [c for c in registry['packets']['T001']['criteria'] if c['id'] != 'T001-C01']
        self.report['criteria'].pop('T001-C01')
        self.assertTrue(MODULE.validate('T001', self.report, registry))

    def test_missing_criterion_rejected(self):
        self.report['criteria'].pop('T001-C01')
        self.assertTrue(self.errors())

    def test_failed_criterion_rejected(self):
        self.report['criteria']['T001-C01']['result'] = 'FAIL'
        self.assertTrue(self.errors())

    def test_self_review_rejected(self):
        self.report['reviewer'] = 'implementer'
        self.assertTrue(self.errors())

    def test_missing_tdd_rejected(self):
        self.report.pop('tdd')
        self.assertTrue(self.errors())

    def test_false_red_result_rejected(self):
        self.report['tdd']['red']['result'] = 'PASS'
        self.assertTrue(self.errors())

    def test_missing_red_failure_evidence_rejected(self):
        self.report['tdd']['red'].pop('observed_failure')
        self.assertTrue(self.errors())

    def test_invalid_tdd_sha_rejected(self):
        self.report['tdd']['red']['sha'] = 'not-a-real-commit-sha'
        self.assertTrue(self.errors())

    def test_non_code_exception_requires_actual_acceptance_first_flag(self):
        self.report['tdd'] = {'non_code_rationale': 'Inventory only', 'reviewer': 'independent-reviewer', 'acceptance_defined_before_execution': 'false'}
        self.assertTrue(self.errors())

    def test_reviewed_non_code_boundary(self):
        self.report['tdd'] = {'non_code_rationale': 'Inventory only; no application code', 'reviewer': 'independent-reviewer', 'acceptance_defined_before_execution': True}
        self.assertEqual(self.errors(), [])

    def test_unknown_criterion_rejected(self):
        self.report['criteria']['invented'] = copy.deepcopy(self.report['criteria']['T001-C01'])
        self.assertTrue(self.errors())

    def test_missing_evidence_url_rejected(self):
        self.report['criteria']['T001-C01'].pop('evidence_url')
        self.assertTrue(self.errors())


if __name__ == '__main__':
    unittest.main()
