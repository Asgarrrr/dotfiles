# Rule tests

A bench for the question "does this rule change anything?" — answered by
arithmetic, not by asking a model whether it feels the rule helped.

## Why it is shaped this way

Every measured intervention I could find sorts onto one axis: **external oracle
wins, self-assessment loses**. Asking an agent to minimize its own patch removes
2–13% of the slop and corrupts the patch 3.8–44.9% of the time; an external
minimizer with a test oracle removes 17.9–32.9%. So nothing in this directory
lets a model grade the result. Full evidence table in `rules-under-test.md`.

## Files

| File | Role |
|------|------|
| `rules-under-test.md` | The candidate rules, the evidence behind each, and **predictions registered before running** |
| `tasks.json` | Three tasks chosen as bait for a specific pathology, plus the five rule texts |
| `tasks/*.ts` | Pre-edit files. Each is the `excess_distance` baseline for its task |
| `metrics.py` | Mechanical scorer. Deterministic, no network, no model |
| `check_imports.py` | Registry oracle. Exit 1 on an unresolvable import, so it works as a CI gate |

## Running one condition

```sh
cd .agents/claude/evals/rule-tests

# 1. Fresh session per condition. Prepend the rule text from tasks.json,
#    then the task prompt, against tasks/fetch-user.ts.
# 2. Save what comes back:
#    runs/retry-R0.ts, runs/retry-R1.ts, ...

python3 metrics.py --baseline tasks/fetch-user.ts runs/retry-*.ts
python3 check_imports.py runs/retry-*.ts
```

Then open `rules-under-test.md` and compare against the registered prediction.

**A missed prediction is the result worth having.** It means a published effect
did not transfer to this model, this repo, or this task shape — which is the only
thing you could not have learned by reading the papers.

## Read N1 and N2 first

Two of the five rules are negative controls: a persona prompt measured inert
(p>0.01), and a few-shot spec measured to make things *worse*. They exist because
R1 and R2 only test recall — a bench that rewards adding rule text will approve
any rule you feed it. If N1 shows a clean improvement, the bench is broken and
its verdict on R1 and R2 is worth nothing.

## Sanity check

The scorer is exercised against fixtures with known ground truth in
`../slop-auditor/fixtures/`:

```sh
python3 metrics.py ../slop-auditor/fixtures/*.diff
python3 check_imports.py ../slop-auditor/fixtures/03-unverified-symbols.diff  # exits 1
```

Expected: `02-comment-noise` scores ratio 0.7 with 8 echo comments;
`05-clean-control` scores 0 on both. The control matters more than the positive —
a scorer that flags the clean fixture is producing the same false positives the
whole harness exists to avoid.

## Honest limits

- **Small n.** The studies behind these rules run 328–400 problems. Three tasks
  give direction, never significance. Do not quote a percentage off five runs.
- **Results expire with the model.** Self-repair went from useless on GPT-3.5/4
  to +4.9–17.1 pp on 2025 models. Re-run on a model bump; do not inherit numbers.
- **`echo_comments` is unvalidated** — my heuristic, no human-agreement study.
  And no published intervention is known to move redundant comments at all, so
  treat any movement there as noise until it replicates.
- **Correctness is not measured.** A rule that cuts `loc` 40% by emitting broken
  code wins on every metric here. Read the output before believing the table.
