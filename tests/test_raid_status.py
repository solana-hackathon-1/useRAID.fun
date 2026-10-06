import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('raid_status', ROOT / 'scripts/update-raid-status.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class StatusRefresh(unittest.TestCase):
    def test_closed_epic_with_open_child_is_flagged(self):
        manifest={'items':[{'id':'E01','kind':'epic','title':'Foundation'},{'id':'T001','kind':'task','epic':'E01','title':'Build','dependencies':[]}]}
        sync={'issues':{'E01':{'number':3,'url':'https://example.test/3'},'T001':{'number':4,'url':'https://example.test/4'}}}
        text=MODULE.render(manifest,sync,[{'number':3,'state':'closed'},{'number':4,'state':'open'}],'2026-10-06')
        self.assertIn('Closed with open children',text)
        self.assertIn('T001',text)

    def test_deleted_issue_not_counted_as_complete(self):
        manifest={'items':[{'id':'E01','kind':'epic','title':'Foundation'},{'id':'T001','kind':'task','epic':'E01','title':'Build','dependencies':[]}]}
        sync={'issues':{'E01':{'number':3,'url':'https://example.test/3'},'T001':{'number':4,'url':'https://example.test/4'}}}
        text=MODULE.render(manifest,sync,[{'number':3,'state':'open'}],'2026-10-06')
        self.assertIn('Unknown',text)

    def test_fully_closed_epic_has_no_open_children(self):
        manifest={'items':[{'id':'E01','kind':'epic','title':'Foundation'},{'id':'T001','kind':'task','epic':'E01','title':'Build','dependencies':[]}]}
        sync={'issues':{'E01':{'number':3,'url':'https://example.test/3'},'T001':{'number':4,'url':'https://example.test/4'}}}
        text=MODULE.render(manifest,sync,[{'number':3,'state':'closed'},{'number':4,'state':'closed'}],'2026-10-06')
        self.assertIn('2/2 tracked issues closed',text)
        self.assertNotIn('Closed with open children',text)

    def test_reopened_predecessor_removes_next_work_candidate(self):
        manifest={'items':[{'id':'T001','kind':'task','epic':'E01','title':'First','dependencies':[]},{'id':'T002','kind':'task','epic':'E01','title':'Second','dependencies':['T001']}]}
        sync={'issues':{'T001':{'number':3,'url':'https://example.test/3'},'T002':{'number':4,'url':'https://example.test/4'}}}
        closed=MODULE.render(manifest,sync,[{'number':3,'state':'closed'},{'number':4,'state':'open'}],'2026-10-06').split('## Next work')[1].split('## Unknown')[0]
        reopened=MODULE.render(manifest,sync,[{'number':3,'state':'open'},{'number':4,'state':'open'}],'2026-10-06').split('## Next work')[1].split('## Unknown')[0]
        self.assertIn('T002',closed)
        self.assertNotIn('T002',reopened)

if __name__=='__main__':unittest.main()
