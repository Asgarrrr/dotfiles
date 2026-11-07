#!/usr/bin/env python3
"""Measure feature and big-feature runs from their workflow journals.

Usage: metrics.py [--glob GLOB] [--json] [--merged REF]

--merged REF counts the lines a human changed after a ready build: the diff
from the branch tip at the end of the run to REF, on the files the run changed.
REF also carries later unrelated edits to those files, so read it as an upper bound.
The tip is the last branch commit before the run ended: a rebase or a deleted
branch breaks it.
"""
import argparse
import collections
import glob
import json
import os
import subprocess
import time

DEFAULT_GLOB = '~/.claude/projects/*/*/workflows/wf_*.json'
STAGES = ['intent', 'design', 'contract', 'build']
STOPS = ('blocked', 'needs-human')
EXECUTED = ('executed', 'blocked', 'paused')


def load(pattern):
    out = []
    for f in sorted(glob.glob(os.path.expanduser(pattern))):
        try:
            with open(f) as h:
                out.append(json.load(h))
        except (OSError, ValueError):
            continue
    return out


def status_of(j):
    r = j.get('result')
    return r.get('status') if isinstance(r, dict) and r.get('status') else j.get('status') or 'unknown'


def git(repo, *a):
    p = subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else None


def human(repo, build, end_s, ref):
    """Lines changed between the run's branch tip and ref, on the run's files."""
    # ISO 8601: git misreads a small @epoch in --before.
    tip = git(repo, 'rev-list', '-1', '--before=' + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(end_s)), build['branch'])
    if not tip:
        return {'error': f"{build['branch']} not found in {repo}"}
    files = (git(repo, 'diff', '--name-only', build['base'], tip) or '').splitlines()
    if not files:
        return {'files': 0, 'insertions': 0, 'deletions': 0}
    # The names are root-relative, and dir can be a subdirectory of the repo.
    stat = (git(repo, 'diff', '--numstat', tip, ref, '--', *(':(top)' + f for f in files)) or '').splitlines()
    rows = [l.split('\t') for l in stat if l]
    num = lambda v: int(v) if v.isdigit() else 0
    return {'files': len(rows), 'insertions': sum(num(r[0]) for r in rows), 'deletions': sum(num(r[1]) for r in rows)}


def feature(journals, merged):
    runs = collections.defaultdict(list)
    for j in journals:
        a = j.get('args') or {}
        runs[f"{a.get('dir')} {a.get('slug')}"].append(j)
    out = {}
    for key, js in runs.items():
        latest = {}
        for j in sorted(js, key=lambda j: j.get('startTime') or 0):
            latest[j['args'].get('stage')] = j
        res = lambda st: (latest.get(st) or {}).get('result') or {}
        build = res('build')
        findings = collections.defaultdict(collections.Counter)
        for f in build.get('findings') or []:
            findings[f.get('source', '?').split(':')[0]][(f.get('outcome') or 'none').split(':')[0]] += 1
        mutation = collections.Counter(s['mutation'] for s in build.get('slices') or [] if s.get('mutation'))
        if (build.get('final') or {}).get('mutation'):
            mutation[build['final']['mutation']] += 1
        run = {
            'stages': {st: status_of(latest[st]) for st in STAGES if st in latest},
            'groundFalse': res('contract').get('groundFalse'),
            'ledger': dict(collections.Counter(l.get('verdict') for l in res('contract').get('ledger') or [])),
            'findings': {k: dict(v) for k, v in findings.items()},
            'mutation': dict(mutation),
            'journals': len(js),
            'tokens': sum(j.get('totalTokens') or 0 for j in js),
            'agents': sum(j.get('agentCount') or 0 for j in js),
            'minutes': round(sum(j.get('durationMs') or 0 for j in js) / 60000, 1),
        }
        if merged and build.get('status') == 'ready':
            b = latest['build']
            run['human'] = human(b['args']['dir'], build, ((b.get('startTime') or 0) + (b.get('durationMs') or 0)) // 1000, merged)
        out[key] = run
    statuses = collections.Counter(status_of(j) for j in journals)
    # A killed or failed journal has no result: it did not finish, so it cannot stop.
    finished = sum(isinstance(j.get('result'), dict) for j in journals)
    return {'runs': out, 'stageRuns': len(journals), 'finished': finished, 'statuses': dict(statuses),
            'stopRate': sum(statuses[s] for s in STOPS) / finished if finished else 0}


def big_feature(journals):
    modes = collections.Counter(((j.get('result') or {}) if isinstance(j.get('result'), dict) else {}).get('mode') or j.get('status') for j in journals)
    results = [j['result'] for j in journals if isinstance(j.get('result'), dict)]
    outcomes = [o for r in results for o in (r.get('recheck') or {}).get('outcomes') or []]
    # Only these modes executed slices; a plan run cannot block.
    executed = sum(modes[m] for m in EXECUTED)
    return {'runs': len(journals), 'modes': dict(modes), 'executed': executed,
            'stopRate': modes['blocked'] / executed if executed else 0,
            'review': sum(len(r.get('review') or []) for r in results), 'red': sum(len(r.get('red') or []) for r in results),
            'rechecked': len(outcomes), 'fixed': sum(o.get('state') == 'fixed' for o in outcomes)}


def markdown(m):
    f, b = m['feature'], m['big-feature']
    lines = ['## feature', '', f"{f['stageRuns']} stage run(s), {f['finished']} finished; blocked or needs-human: {f['stopRate']:.0%} of finished; statuses: {f['statuses']}", '',
             '| run | stages | groundFalse | ledger | findings | mutation | human | journals | tokens | minutes |',
             '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for key, r in f['runs'].items():
        lines.append(f"| {key} | {r['stages']} | {r['groundFalse']} | {r['ledger']} | {r['findings']} | {r['mutation']} | "
                     f"{r.get('human', '')} | {r['journals']} | {r['tokens']} | {r['minutes']} |")
    lines += ['', '## big-feature', '', f"{b['runs']} run(s), {b['executed']} executed; blocked: {b['stopRate']:.0%} of executed; modes: {b['modes']}",
              f"review findings: {b['review']}; red-team findings: {b['red']}; rechecked: {b['rechecked']}, fixed: {b['fixed']}"]
    return '\n'.join(lines)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--glob', default=DEFAULT_GLOB)
    p.add_argument('--json', action='store_true')
    p.add_argument('--merged', metavar='REF')
    o = p.parse_args()
    js = load(o.glob)
    m = {'feature': feature([j for j in js if j.get('workflowName') == 'feature-stage' and isinstance(j.get('args'), dict)], o.merged),
         'big-feature': big_feature([j for j in js if j.get('workflowName') == 'big-feature'])}
    print(json.dumps(m, indent=2) if o.json else markdown(m))


if __name__ == '__main__':
    main()
