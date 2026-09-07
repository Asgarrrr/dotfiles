#!/usr/bin/env python3
"""Mechanical scorer for rule A/B tests. No LLM judges anything here.

The organising axis of this harness: measured wins come from external oracles,
measured losses come from asking a model to grade its own output. A scorer that
called an LLM would sit on the losing side of that axis, so this one is pure
arithmetic — same input, same number, every run.

Metrics and what backs them:
  excess_distance   Levenshtein over tokens, candidate vs baseline, normalised by
                    baseline length. Best human-validated slop metric found:
                    kappa 0.897 reviewability / 0.939 faithfulness, and a blinded
                    audit found genuinely unnecessary edits in 82.3% of
                    high-excess repairs (arXiv:2609.04061). ~18% false positives
                    at their threshold, so treat it as a ranking signal.
  comment_ratio     Comment lines over code lines. Redundant comments are the
                    statistical signature of LLM code (arXiv:2605.13280).
  branch_density    Branch keywords per code line. Complexity proxy.
  max_nesting       Deepest indentation. Complexity proxy.
  imports           Extracted for registry resolution by check_imports.py.

LIMITS, so nobody reads more into a number than it holds:
  - Line-based, not AST-based. A brace-heavy style inflates loc.
  - There is no redundant-comment metric here on purpose. The obvious one,
    comment-echoes-the-line-below, was built and measured: on a 167-file
    reference repo every single hit was a false positive, because a docblock
    above a function necessarily shares vocabulary with the function it
    documents. It punished good documentation. Removed rather than caveated.
  - excess_distance needs a meaningful baseline. Against an empty baseline it
    degenerates to "how long is this", which is a different question.
"""

import json
import re
import sys
from pathlib import Path

COMMENT_PREFIXES = ("//", "#", "*", "/*", "--")
BRANCH = re.compile(
    r"\b(if|else|elif|for|while|case|catch|switch|try|except|&&|\|\||\?\?)\b"
)
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
IMPORT = re.compile(
    r"""^\s*(?:import\s+.*?from\s+['"](?P<a>[^'"]+)['"]"""
    r"""|import\s+['"](?P<b>[^'"]+)['"]"""
    r"""|(?:const|let|var)\s+.*?=\s*require\(['"](?P<c>[^'"]+)['"]\)"""
    r"""|from\s+(?P<d>[\w.]+)\s+import\b"""
    r"""|import\s+(?P<e>[\w.]+)\s*$)""",
    re.X,
)

def added_lines(text):
    """Return payload lines. Unified diffs contribute only their added lines."""
    lines = text.splitlines()
    if any(l.startswith(("+++", "@@")) for l in lines):
        return [l[1:] for l in lines if l.startswith("+") and not l.startswith("+++")]
    return lines


def classify(line):
    s = line.strip()
    if not s:
        return "blank"
    if s.startswith(COMMENT_PREFIXES):
        return "comment"
    return "code"


def levenshtein(a, b):
    """Token-level edit distance. Iterative, two rows, O(len(b)) memory."""
    if a == b:
        return 0
    if not a:
        return len(b)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def tokens(lines):
    return [t for l in lines if classify(l) == "code" for t in IDENT.findall(l)]


def score(text, baseline=None):
    lines = added_lines(text)
    kinds = [classify(l) for l in lines]
    code = [l for l, k in zip(lines, kinds) if k == "code"]
    n_code = len(code)
    n_comment = kinds.count("comment")

    imports = []
    for l in code:
        m = IMPORT.match(l)
        if m:
            imports.append(next(g for g in m.groups() if g))

    out = {
        "loc": n_code,
        "comment_lines": n_comment,
        "comment_ratio": round(n_comment / n_code, 3) if n_code else 0.0,
        "branch_density": round(
            sum(len(BRANCH.findall(l)) for l in code) / n_code, 3
        ) if n_code else 0.0,
        "max_nesting": max(
            ((len(l) - len(l.lstrip())) // 2 for l in code), default=0
        ),
        "imports": sorted(set(imports)),
    }

    if baseline is not None:
        base = tokens(added_lines(baseline))
        cand = tokens(lines)
        out["excess_distance"] = (
            round(levenshtein(base, cand) / len(base), 3) if base else None
        )
    return out


def main(argv):
    baseline = None
    paths = []
    it = iter(argv)
    for arg in it:
        if arg == "--baseline":
            baseline = Path(next(it)).read_text()
        else:
            paths.append(arg)

    if not paths:
        print(__doc__.split("\n\n")[0])
        print("usage: metrics.py [--baseline REF] FILE...", file=sys.stderr)
        return 2

    results = {p: score(Path(p).read_text(), baseline) for p in paths}
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
