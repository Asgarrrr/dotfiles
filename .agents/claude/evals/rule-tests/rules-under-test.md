# Rules under test

## The axis everything sorts on

Across every measured result I could find, the wins and losses split on one line:

| | Shape | Result |
|---|---|---|
| **Wins** | External oracle — registry membership, a test suite, a reference diff | TRIM 17.9–32.9% slop removed; constrained decoding → 0% package hallucination |
| **Wins** | One clause, checked against a reference | "keep as much of the original code as possible": excess distance 0.195 → 0.131, complexity −26.6%, Pass@1 **+2.3 pp** |
| **Losses** | Model grades or cleans its own output, no oracle | Self-minimization: 2.1–13.4% removed vs TRIM's 17.9–32.9%, and the attempt **fails 3.8–44.9%** of the time — inflating the patch or reintroducing the bug |
| **Losses** | More prompt, more detail, more persona | Few-shot *increased* Long Method (11→13, 5→8); requirement specificity p>0.8; persona p>0.01 |

This is why the harness scores mechanically and never asks a model to judge. A
scorer built on an LLM judge would sit on the losing side of its own finding.

It also means **more rule text is not a free lever**. Two of the four loss rows
are interventions that added instructions and made things worse.

## Registered predictions

Written before the first run. A prediction recorded afterwards is a story.

| ID | Rule | Evidence behind it | Prediction |
|----|------|--------------------|------------|
| **R0** | No rule. Control. | — | Baseline. Everything is measured as a delta from this. |
| **R1** | Anthropic's over-engineering prompt, verbatim (scope / documentation / defensive coding / abstractions) | [Documented by Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) for exactly this failure. **No published effect size.** | loc ↓, branch_density ↓. `comment_ratio` ↓ via its Documentation bullet — the only comment intervention anywhere with an official source, still unmeasured. |
| **R2** | Append: *"…but keep as much of the original code as possible"* | [arXiv:2609.04061](https://arxiv.org/abs/2609.04061), measured across ~50 model settings | excess_distance ↓ **but small here**. Opus 4.7 barely moved — already faithful. Predicting a weak effect on Opus 5, which is the honest read, not the flattering one. |
| **N1** | Persona: *"You are a senior engineer who writes clean, minimal code."* | [arXiv:2605.13280](https://arxiv.org/abs/2605.13280): persona p>0.01, **measured inert** | **No significant change.** If the harness reports N1 working, the harness is wrong. |
| **N2** | Few-shot: role + output spec + two worked examples | [arXiv:2605.02741](https://arxiv.org/html/2605.02741v1): few-shot *increased* Long Method | loc ↑ or flat. Predicting a rule makes things **worse**, and that is falsifiable. |

N1 and N2 are negative controls, and they are the point. R1 and R2 only measure
recall — any harness that rewards adding rule text will score them well. N1 and
N2 measure whether the harness can register *nothing* and *worse*. A harness that
cannot do that will confirm whatever rule you feed it.

## Method

1. Pick a task from `tasks.json`. Each names a reference file, which is R2's
   baseline and the `--baseline` argument for `excess_distance`.
2. Run it once per condition, each in a **fresh session**. Carrying context
   between conditions leaks the previous rule into the next result.
3. Save output to `runs/<task>-<rule>.<ext>`.
4. Score: `python3 metrics.py --baseline <ref> runs/<task>-*.ts`
5. Gate: `python3 check_imports.py runs/<task>-*.ts`
6. Compare against the registered prediction above. Record misses. **A missed
   prediction is the finding** — it means the evidence does not transfer to this
   model, this repo, or this task shape.

## What this harness cannot tell you

- **n is small.** Published studies run 328–400 problems. A handful of tasks
  gives direction, never significance. Do not report a percentage from five runs.
- **Results are model-version-scoped.** Self-repair flipped from useless
  (GPT-3.5/4, [arXiv:2306.09896](https://arxiv.org/abs/2306.09896)) to
  +4.9–17.1 pp on 2025 models. Every number here expires with the model.
- **`echo_comments` is unvalidated.** My heuristic, no human-agreement study
  behind it. Worse: no published intervention is known to move redundant
  comments at all. Report the number, do not tune against it.
- **Nothing here measures correctness.** A rule that cuts loc 40% by producing
  broken code scores beautifully. Read the output.
