# slop-auditor evals

Five diffs with known ground truth. Four plant a specific pathology; one plants
nothing and exists to catch false positives.

| # | Fixture | Pathology | Passing result |
|---|---------|-----------|----------------|
| 1 | `01-buried-fix.diff` | Search residue around a real fix | ~85% removable, 3-line fix named |
| 2 | `02-comment-noise.diff` | Comments restating their own code | Comments flagged, logic kept, *why* comment kept |
| 3 | `03-unverified-symbols.diff` | Fake package, fake method on a real package | Three imports, three distinct verdicts, each with a lookup |
| 4 | `04-invented-logic.diff` | Behaviour outside the brief that passes tests | Normalization flagged, colliding input named |
| 5 | `05-clean-control.diff` | None | 0%, no findings |

## Running one

```
Use the slop-auditor agent on .agents/claude/evals/slop-auditor/fixtures/01-buried-fix.diff
```

Then score the reply against that id's `expectations` in `evals.json`.

Two rules make the scores mean something:

- **Do not paste the fixture header into the prompt.** Every fixture opens with a
  `Scenario:` and `Ground truth:` block for *your* reference. Handing it to the
  agent tests reading comprehension, not auditing.
- **Fixture 5 is the one that matters.** Cases 1–4 measure recall, and recall is
  cheap — an agent that flags everything scores well on all four. Only the control
  measures precision. An agent that finds a defect in fixture 5 is not a strict
  auditor, it is a broken one, regardless of how it scored elsewhere.

## Limits of this harness

The fixtures are diffs on disk, not a working tree. The agent's deletion test —
remove the hunk, re-run the suite, restore — cannot execute against them, so these
evals exercise its classification and its symbol verification, not its
verify-by-running discipline. That discipline is only observable on a real repo
with a green baseline.

Fixture 3 depends on the npm registry. `express-async-validator-pro` is expected to
stay unresolvable; if someone ever publishes that name, the fixture is burned and
needs a new one.

## Ground truth sources

The pathologies are drawn from measurement, not from taste:

- Removable fraction, 17.8–32.9% of agent patches — [TRIM, arXiv:2607.18161](https://arxiv.org/html/2607.18161)
- Redundant comments as the signature of generated code — [The Readability Spectrum, arXiv:2605.13280](https://arxiv.org/html/2605.13280v1)
- Package hallucination at 5–22%, and slopsquatting as its exploit path
