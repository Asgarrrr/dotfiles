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

## First run — task `retry`, Opus 5, 2026-09-07

Five runs: R0 three times, R1 and N1 once each. Baseline `tasks/fetch-user.ts`.

| Condition | loc | excess_distance |
|-----------|-----|-----------------|
| R0 | 12 | 0.654 |
| R0 (replicate) | 11 | 0.462 |
| R0 (replicate) | 12 | 0.654 |
| R1 | 12 | 0.577 |
| N1 | 10 | 0.346 |

**Noise floor: 0.192.** That is the spread of R0 against itself, with the rule
held constant. It is the number that makes the rest readable:

- **R1 moves 0.077 — below the floor.** Anthropic's over-engineering prompt is
  indistinguishable from no rule here. Not refuted, unresolved: the effect, if
  any, is smaller than this bench can see at n=3.
- **N1 moves 0.308 — above the floor**, and N1 is the rule I predicted inert.
  Prediction missed. It is n=1 and needs replication before it means anything.

The finding is the floor itself. Run each condition once, as the obvious protocol
would, and this task reports "Anthropic's rule improves faithfulness 12%" — an
artifact of a bench whose own variance is 2.5× the effect being claimed. Any
future result here is noise until it clears 0.192.

Caveat on the numbers: the baseline files carry a header comment, which every
condition copied forward. That inflates `comment_lines` by 3-4 uniformly and
makes the comment metrics unusable on this task. Strip the headers before
reading comment results.

**Next**: replicate N1 three times. If it holds above the floor, a rule measured
inert in the literature is doing something on Opus 5, and the literature does not
transfer. If it collapses toward R0, the bench needs n>3 per condition before it
can answer anything.

## Experiment 2 — does an explicit verification instruction cost anything?

Anthropic's Opus 5 page makes a falsifiable claim about this repo's own
`rules/verification.md`:

> "Claude Opus 5 verifies its own work without being told to. If your prompt
> contains explicit verification instructions […] remove them: instructions like
> these cause over-verification on Claude Opus 5, and **removing them reduces
> wasted tokens with no loss in quality**."

Two measurable halves — cost, and quality. Both are available here.

**Design.** Same `retry` task. Every run inherits this repo's CLAUDE.md, held
constant, so this measures the *marginal* effect of adding explicit verification
instruction on top of the existing setup — which is what Anthropic says to remove.

- **V-off** — the R0 runs above, reused. Cost: 46786 / 46864 / 46784 tokens, 2 tool
  calls each.
- **V-on** — identical prompt plus Anthropic's own examples of the instruction to
  remove: "include a final verification step for any non-trivial task" and "use a
  subagent to verify".

**Metrics.** Cost is `subagent_tokens` and `tool_uses`. Quality is `loc` and
`excess_distance` from `metrics.py`. Anthropic's claim is directional on both:
cost up, quality flat.

**Registered predictions**, before running:

| | Prediction | What refutes it |
|---|---|---|
| Cost | V-on spends more tokens and more tool calls than V-off | No separation beyond V-off's own spread |
| Quality | No improvement — flat within the 0.192 noise floor | V-on improves `excess_distance` past the floor, which would mean the tokens buy something and Anthropic's "no loss in quality" understates the trade |

The cost half is the safer bet: more instruction reliably produces more work. The
quality half is the one worth running — if verification instructions do buy
quality on this repo's setup, the guidance does not transfer here and
`verification.md` earns its cost.

Also replicating N1 ×3, since Experiment 1 left it at n=1 above the noise floor.

### Results — Opus 5, 2026-09-07, n=3 per condition

**Cost.** Both predictions held, and the separation is not marginal.

| | tokens | tool calls | wall clock |
|---|---|---|---|
| V-off | 46784 / 46864 / 46786 | 2, 2, 2 | 8.1 / 8.8 / 9.2 s |
| V-on | 48639 / 49020 / 49771 | 4, 4, 5 | 67 / 68 / 70 s |

V-off's own token spread is **80**. V-on sits ~2000 above it — a 22× separation,
so this is not noise. Tool calls double. Wall clock goes **8×**, and that is the
number that actually costs you something: 9 seconds became 68 for identical work.

**Quality.** No gain.

| Group | n | loc (median) | excess_distance (median) | range |
|---|---|---|---|---|
| V-off | 3 | 12 | 0.654 | 0.462 – 0.654 |
| V-on | 3 | 12 | 0.577 | 0.346 – 0.577 |
| N1 | 3 | 10 | 0.346 | 0.346 – 0.654 |
| R1 | 1 | 12 | 0.577 | — |

V-on improves `excess_distance` by 0.077 — **below the 0.192 noise floor**, and
identical to R1's non-result. Anthropic's claim holds on both halves here: the
instruction buys tokens, tool calls, and 8× latency, and buys no measurable
quality.

**N1 collapsed on replication, and that is the harness working.** At n=1 it
scored 0.346 and looked like the best condition in Experiment 1 — a missed
prediction. At n=3 its range is 0.346–0.654, overlapping V-off's 0.462–0.654
almost entirely. The persona rule is inert, exactly as the literature reports
(p>0.01) and exactly as predicted. The Experiment 1 "miss" was the noise floor
being read as a result, which is the specific error the negative control exists
to catch. It caught it — one experiment late.

**Scope of this result.** One task, one model, n=3, and every run inherits this
repo's CLAUDE.md. It measures the marginal cost of *adding* explicit verification
instruction to an already-verification-heavy setup. It does not measure what
happens if you remove the existing rules, which is a different experiment and the
one that would actually justify editing `rules/verification.md`.

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
