#!/usr/bin/env python3
"""Refresh the RAID status document using GitHub issue states, never inferred QA."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def safe(text):
    return str(text).replace('|', '\\|').replace('\n', ' ').replace('<', '&lt;').replace('>', '&gt;')

def render(manifest, sync, issues, timestamp):
    actual = {i['number']: i for i in issues if 'pull_request' not in i}
    items = {i['id']: i for i in manifest['items']}
    def state(ident):
        number=sync['issues'].get(ident,{}).get('number')
        return actual.get(number,{}).get('state','unknown')
    def link(ident):
        record=sync['issues'].get(ident,{})
        return '['+ident+']('+record['url']+')' if record.get('url') else ident
    closed=sum(state(i)=='closed' for i in items)
    text=f'# RAID project status\n\nUpdated: {timestamp}. [Project](https://github.com/orgs/solana-hackathon-1/projects/1) · [CI plan](raid-ci-plan.md) · [Weekly plan](raid-sprint-plan.md)\n\n**{closed}/{len(items)} tracked issues closed.** Issue closure is a GitHub state, not proof of QA, UAT or production readiness. Refreshes on issue/epic close or reopen and daily.\n\n## Epics: what is left\n\n| Epic | GitHub state | Children closed / total | Remaining work |\n|---|---|---|---|\n'
    for epic in manifest['items']:
        if epic['kind']!='epic':continue
        ident=epic['id'];children=[i for i in manifest['items'] if i.get('epic')==ident or i.get('parent_epic')==ident];done=sum(state(i['id'])=='closed' for i in children);remaining=[i for i in children if state(i['id'])!='closed'];status=state(ident).title()
        if state(ident)=='closed' and remaining:status='Closed with open children'
        text+=f"| {link(ident)} — {safe(epic['title'])} | {status} | {done}/{len(children)} | "+(', '.join(link(i['id']) for i in remaining) or 'No open children; review completion evidence')+' |\n'
    text+='\n## Next work with no open predecessor\n\nThese are candidates for review, not automatic Ready or authorization. Verify predecessor evidence, assigned role, scope and actual environment before starting.\n\n'
    candidates=[i for i in manifest['items'] if i['kind'] in ['task','uat'] and state(i['id'])=='open' and all(state(d)=='closed' for d in i.get('dependencies',[]))]
    for item in candidates:text+='- '+link(item['id'])+' — '+safe(item['title'])+' ('+item.get('sprint','undated')+').\n'
    if not candidates:text+='No tracked implementation/UAT issue has all listed predecessors closed. Review blockers and decisions.\n'
    text+='\n## Unknown or untracked issues\n\n'
    missing=[i for i in items if state(i)=='unknown']
    text+=('Unknown: '+', '.join(link(i) for i in missing)+'. Missing/deleted records are not complete.\n') if missing else 'No tracked issue is missing from the repository readback.\n'
    numbers={v['number'] for v in sync['issues'].values()}
    extra=[i for i in actual.values() if i['number'] not in numbers and i.get('state')=='open']
    for issue in extra:text+='- [#'+str(issue['number'])+']('+issue.get('html_url','https://github.com/'+manifest.get('repository','solana-hackathon-1/useRAID.fun')+'/issues/'+str(issue['number']))+') — '+safe(issue.get('title','Untracked issue'))+'; assign an epic/backlog ID.\n'
    return text

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--issues-json',type=Path);args=parser.parse_args()
    manifest=json.loads((ROOT/'planning/raid-backlog.json').read_text());sync=json.loads((ROOT/'planning/raid-github-sync.json').read_text())
    if args.issues_json:issues=json.loads(args.issues_json.read_text())
    else:
        issues=[];page=1
        while True:
            result=subprocess.run(['gh','api',f"repos/{manifest['repository']}/issues?state=all&per_page=100&page={page}"],capture_output=True,text=True,check=True);batch=json.loads(result.stdout);issues.extend(batch)
            if len(batch)<100:break
            page+=1
    stamp=datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    (ROOT/'docs/raid-project-status.md').write_text(render(manifest,sync,issues,stamp))

if __name__=='__main__':main()
