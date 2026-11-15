"""Tests for metrics.py on fixture journals. Run: bash tests/feature-eval.test.sh"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
METRICS = os.path.join(HERE, 'metrics.py')


def journal(root, session, run_id, name, args, result, status='completed', start=1_000_000, ms=60_000, tokens=1000, agents=3):
    d = os.path.join(root, 'proj', session, 'workflows')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f'wf_{run_id}.json'), 'w') as f:
        json.dump({'runId': f'wf_{run_id}', 'workflowName': name, 'status': status, 'args': args, 'result': result,
                   'startTime': start, 'durationMs': ms, 'totalTokens': tokens, 'agentCount': agents}, f)


def git(repo, *a):
    return subprocess.run(['git', '-C', repo, *a], check=True, capture_output=True, text=True).stdout.strip()


def metrics(root, *extra):
    p = subprocess.run([sys.executable, '-I', METRICS, '--glob', os.path.join(root, 'proj', '*', 'workflows', 'wf_*.json'), '--json', *extra],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


class Metrics(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        a = {'dir': '/r', 'slug': 'x'}
        journal(self.root, 's1', 'i2', 'feature-stage', {**a, 'stage': 'intent'}, {'stage': 'intent', 'status': 'needs-human'}, start=1000)
        journal(self.root, 's1', 'i1', 'feature-stage', {**a, 'stage': 'intent'}, {'stage': 'intent', 'status': 'ready'}, start=2000)
        journal(self.root, 's1', 'c1', 'feature-stage', {**a, 'stage': 'contract'},
                {'stage': 'contract', 'status': 'ready', 'groundFalse': 2, 'ledger': [{'verdict': 'proven'}, {'verdict': 'proven'}, {'verdict': 'unproven'}]}, start=3000)
        journal(self.root, 's2', 'b2', 'feature-stage', {**a, 'stage': 'build'},
                {'stage': 'build', 'status': 'blocked', 'at': 1}, start=4000)
        journal(self.root, 's2', 'b1', 'feature-stage', {**a, 'stage': 'build'},
                {'stage': 'build', 'status': 'ready', 'branch': 'feature/x', 'base': 'b',
                 'slices': [{'index': 0, 'mutation': 'pass'}, {'index': 1, 'mutation': 'survivors'}, {'index': 2, 'mutation': 'skipped'}, {'index': 3}],
                 'final': {'mutation': 'pass'},
                 'findings': [{'source': 'peer:1', 'outcome': 'applied'}, {'source': 'redteam', 'outcome': 'declined: x'}, {'source': 'review:security', 'outcome': 'applied'}]}, start=5000)
        journal(self.root, 's3', 'k1', 'feature-stage', {'dir': '/r', 'slug': 'y', 'stage': 'intent'}, None, status='killed')
        journal(self.root, 's4', 'f1', 'big-feature', {'task': 't', 'dir': '/r'},
                {'mode': 'executed', 'review': [{}, {}], 'red': [{}], 'recheck': {'outcomes': [{'state': 'fixed'}, {'state': 'open'}]}})
        journal(self.root, 's4', 'f2', 'big-feature', {'task': 't', 'dir': '/r'}, {'mode': 'blocked'})
        journal(self.root, 's4', 'f3', 'big-feature', {'task': 't', 'dir': '/r'}, {'mode': 'plan'})
        journal(self.root, 's4', 'o1', 'other', {}, {})

    def tearDown(self):
        self.tmp.cleanup()

    def test_feature_run_uses_the_latest_journal_per_stage(self):
        run = metrics(self.root)['feature']['runs']['/r x']
        self.assertEqual(run['stages'], {'intent': 'ready', 'contract': 'ready', 'build': 'ready'})
        self.assertEqual(run['groundFalse'], 2)
        self.assertEqual(run['ledger'], {'proven': 2, 'unproven': 1})

    def test_feature_build_findings_and_mutation(self):
        run = metrics(self.root)['feature']['runs']['/r x']
        self.assertEqual(run['findings'], {'peer': {'applied': 1}, 'redteam': {'declined': 1}, 'review': {'applied': 1}})
        self.assertEqual(run['mutation'], {'pass': 2, 'survivors': 1, 'skipped': 1})

    def test_cost_sums_every_journal_of_the_run_reruns_included(self):
        run = metrics(self.root)['feature']['runs']['/r x']
        self.assertEqual((run['journals'], run['tokens'], run['agents'], run['minutes']), (5, 5000, 15, 5.0))

    def test_stop_rate_counts_finished_stage_runs(self):
        f = metrics(self.root)['feature']
        self.assertEqual((f['stageRuns'], f['finished']), (6, 5))
        self.assertEqual(f['statuses'], {'needs-human': 1, 'ready': 3, 'blocked': 1, 'killed': 1})
        self.assertAlmostEqual(f['stopRate'], 2 / 5)

    def test_big_feature_modes_and_review(self):
        b = metrics(self.root)['big-feature']
        self.assertEqual((b['runs'], b['executed']), (3, 2))
        self.assertEqual(b['modes'], {'executed': 1, 'blocked': 1, 'plan': 1})
        self.assertAlmostEqual(b['stopRate'], 1 / 2)
        self.assertEqual((b['review'], b['red'], b['rechecked'], b['fixed']), (2, 1, 2, 1))

    def test_markdown_output_names_both_workflows(self):
        p = subprocess.run([sys.executable, '-I', METRICS, '--glob', os.path.join(self.root, 'proj', '*', 'workflows', 'wf_*.json')], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('## feature', p.stdout)
        self.assertIn('## big-feature', p.stdout)
        self.assertIn('| /r x |', p.stdout)

    def merged(self, sub):
        repo = os.path.join(self.root, 'repo')
        os.makedirs(os.path.join(repo, sub))
        d = os.path.join(repo, sub) if sub else repo

        def put(name, text):
            with open(os.path.join(d, name), 'w') as f:
                f.write(text)
        git(repo, 'init', '-q', '-b', 'main')
        git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
        put('a.txt', '1\n')
        git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
        base = git(repo, 'rev-parse', 'HEAD')
        git(repo, 'checkout', '-qb', 'feature/x')
        put('a.txt', '1\n2\n')
        env = {**os.environ, 'GIT_COMMITTER_DATE': '@1000 +0000', 'GIT_AUTHOR_DATE': '@1000 +0000'}
        subprocess.run(['git', '-C', repo, 'commit', '-qam', 'run'], check=True, env=env)
        put('a.txt', '1\n2b\n3\n')
        put('b.txt', 'other\n')
        git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'human fix after the run')
        journal(self.root, 's5', 'm1', 'feature-stage', {'dir': d, 'slug': 'x', 'stage': 'build'},
                {'stage': 'build', 'status': 'ready', 'branch': 'feature/x', 'base': base, 'slices': [], 'findings': []}, start=1_000_000, ms=500_000)
        return metrics(self.root, '--merged', 'feature/x')['feature']['runs'][f'{d} x']['human']

    def test_merged_measures_the_human_lines_after_the_run(self):
        self.assertEqual(self.merged(''), {'files': 1, 'insertions': 2, 'deletions': 1})

    def test_merged_reads_root_relative_names_from_a_subdirectory(self):
        self.assertEqual(self.merged('pkg'), {'files': 1, 'insertions': 2, 'deletions': 1})


if __name__ == '__main__':
    unittest.main()
