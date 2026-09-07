#!/usr/bin/env python3
"""Resolve every import against its registry. The one exact oracle here.

Package hallucination is the only pathology in this harness with a ground truth
you can query: a name is on the registry or it is not. Constrained decoding
against the registry namespace reports driving hallucination to zero
(arXiv:2602.20717), and the same check as a gate is exact for nonexistent names.

What it cannot do, stated plainly: a slopsquatted package is a real registry
entry, so it resolves 200 and passes. This catches fabrication, not malice.
Registry membership is necessary, never sufficient.

usage:
  check_imports.py FILE...            # extract imports, resolve each
  check_imports.py --names p-retry x  # resolve names directly
exit 1 if any name fails to resolve, so it works as a CI gate.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from metrics import score  # noqa: E402

REGISTRIES = {
    "npm": "https://registry.npmjs.org/{}",
    "pypi": "https://pypi.org/pypi/{}/json",
}


def is_local(name):
    return name.startswith((".", "/")) or name.startswith("node:")


def resolve(name, timeout=10):
    """Return (verdict, detail). Never raises, never guesses."""
    if is_local(name):
        return "local", "relative or builtin, not a registry name"

    # Scoped npm names must be URL-escaped: @scope/pkg -> @scope%2Fpkg
    npm_name = name.replace("/", "%2F") if name.startswith("@") else name.split("/")[0]

    for registry, url in REGISTRIES.items():
        target = npm_name if registry == "npm" else name.split(".")[0]
        try:
            req = urllib.request.Request(
                url.format(target), headers={"User-Agent": "rule-tests/1.0"}
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if r.status == 200:
                    return "resolved", f"{registry} 200"
        except urllib.error.HTTPError as e:
            if e.code != 404:
                return "error", f"{registry} HTTP {e.code}"
        except Exception as e:  # network down, DNS, timeout
            return "error", f"{registry} unreachable: {type(e).__name__}"

    return "UNRESOLVED", "404 on every registry queried"


def main(argv):
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2

    if argv[0] == "--names":
        names = argv[1:]
    else:
        names = sorted({n for p in argv for n in score(Path(p).read_text())["imports"]})

    results = {}
    failed = False
    for n in names:
        verdict, detail = resolve(n)
        results[n] = {"verdict": verdict, "detail": detail}
        if verdict == "UNRESOLVED":
            failed = True

    print(json.dumps(results, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
