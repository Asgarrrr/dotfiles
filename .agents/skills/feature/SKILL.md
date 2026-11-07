---
name: feature
description: Drive the feature workflow one stage at a time — launch a stage, relay its questions to the user, record the answers in the run dir, launch the next stage. Use when the user says "/feature", or asks for the best-designed implementation of a task and accepts that it takes long. Stages so far — intent, design, contract.
argument-hint: "<task> | resume <slug>"
---

# /feature

You are the relay between the user and `feature-stage`, a workflow that runs one
stage per launch. A workflow cannot talk to the user mid-run, so every question
comes back to you. You ask it, write the answer into the run dir, and launch the
next stage.

Do no analysis yourself. Do not read the code, judge a design, or answer a
question for the user. The run dir holds the state; the digest is all you need.

## Start

1. Fix the arguments:
   - `task`: the user's words, verbatim.
   - `dir`: the absolute path of the repo, default the current working directory.
   - `slug`: kebab-case, 2-5 words from the task. The stage refuses a slug whose
     run dir already exists; pick another one.
   - `today`: the output of `date +%F`.
2. Launch `Workflow({name: "feature-stage", args: {stage: "intent", task, dir, slug, today}})`.
3. Wait for the completion notification. Do not poll.

## Read the result

Every stage returns `status`, `warnings`, `digest`, `questions`, and `next`, and
writes the same object to `<runDir>/<stage>.json`.

- `needs-human`: the stage judged the task ill-posed. Show `reason` and `evidence`
  verbatim, and stop. The user reformulates; a new task is a new slug.
  From `contract`, `needs-human` means the contract still relies on false claims
  about the code after one revision: the task is not at fault. Show the evidence
  and stop; the user decides whether to edit the design or restart with a new slug.
- `blocked`: a precondition or a check failed. Show `reason` and `evidence`
  verbatim, and stop. Do not fix the cause yourself.
- `questions`: go to "Ask".
- `ready`: show the digest and `next`.

Show warnings at the top of your message, before the digest. Show the baseline
when it is not `pass, pass`: a flaky or red baseline changes how later failures read.

## Ask

For each question:

1. In your message, show the question's `recommendation.option`, `why`, and
   `wouldChangeIf` — apart from the options.
2. Call AskUserQuestion with the `header`, `question`, and options in the order
   given. Keep each `label` and `description` as returned. Do not add
   "(Recommended)" and do not reorder.
3. Append the answer to `<runDir>/task.md` under `## Answers`, one line per
   question: `- <id>: <chosen label> — <the user's notes, if any>`. Create the
   heading if it is missing.

Batch up to four questions per AskUserQuestion call.

## Resume

`/feature resume <slug>`: in `<dir>/.claude/runs/<slug>/`, the latest `<stage>.json`
says which stage ran last and holds its questions verbatim. `task.md` holds the
recorded answers. Ask the questions that have no answer, then continue. If the
context is above ~100k tokens, offer a fresh session first; the run dir carries
the state.

## Stages

| Stage | Args beyond dir, slug, today | Writes |
| --- | --- | --- |
| `intent` | `task` | `explore/`, `task.md` |
| `design` | none | `research.md`, `designs/<n>.md` |
| `contract` | `gpt` (optional) | branch `feature/<slug>`, `premortem.md`, `contract/` |

After `intent` and its answers, launch `design` with the same `dir` and `slug`.
Run `date +%F` again for `today`: research stamps the registry reads with it.

After `design` and its answers, write `<runDir>/decisions.md` yourself. Copy facts
only; add no judgement of your own:

- `Chosen design: designs/<n>.md` — the design the user picked on
  `design-choice`, or the `leader` when no such question was asked.
- One line per answer of this stage: `- <id>: <chosen label> — <notes>`.
- `Judges: agree` or `Judges: split`, with each pass's winner from `judge.passes`.

After `decisions.md`, launch `contract` with a fresh `today`. It needs a clean
working tree in `dir`: if `git status` shows changes, ask the user to commit them
first. It creates the branch `feature/<slug>` and commits the stubs and tests there.

`gpt` picks the one critique call: omit it for `gpt-6-astra` at xhigh, pass `"sol"`
for `gpt-6-sol` at high, or `false` for no critique. Pass it only when the user asks.
A warning that starts with `GPT quota exhausted` means this run had no critique.

After `contract` and its answers, append to `decisions.md` a `## Critique` heading
and one line per answer: `- <id>: <chosen label> — <notes>`. On `Keep contract`,
write `declined` in the notes. On `Redesign`, stop: the user restarts at `intent`
with a new slug and the point in the task.

A `contract` run that stops after it creates `feature/<slug>` leaves the repo on
that branch, and a rerun with the same slug is blocked. Tell the user, with the
branch the run started from: `from` in the result (empty on a detached HEAD, then
use `base`). Before a new slug or a rerun, the user runs `git switch <from>`, then
deletes `feature/<slug>` or keeps it. Never switch or delete yourself.

The build stage is not built yet. After `contract`, report the digest, the branch,
and `<runDir>/contract/ledger.md`, then stop.
