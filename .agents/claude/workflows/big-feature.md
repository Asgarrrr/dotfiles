# big-feature

How `big-feature.js` runs, as of the current script. Read the script for exact
prompts and schemas; this file shows the shape.

## Arguments

| Arg | Default | Effect |
| --- | --- | --- |
| `task` | required | What to build. A plain string works as `args`. |
| `dir` | current working directory | Repo the agents work in. Pass an absolute path. |
| `go` | `false` | `false` stops after the plan. `true` implements. |
| `until` | all slices | Stop after this many slices, to read the diff between runs. |
| `slices` | none | An approved plan from an earlier run. Skips Explore, Vet and Plan. |
| `gpt` | `false` | Adds a GPT council seat through `codex exec` (`true`/`sol`, or `astra`). |
| `fable` | `false` | Adds a Fable council seat and plans on Fable instead of Opus. |

## Overview

```mermaid
flowchart TD
    start([args]) --> carried{slices given?}

    carried -- no --> explore
    carried -- yes --> impl

    subgraph explore [Explore]
        e1[reader: conventions]
        e2[reader: existing code]
        e3[reader: test surface]
    end

    explore --> vet

    subgraph vet [Vet]
        deps[vet:deps<br/>dependency check]
        opus[council:opus]
        fable[council:fable<br/>if fable]
        gpt[council:gpt<br/>if gpt]
        synth[council:synth + rebuttals<br/>only with 2+ seats]
        opus --> synth
        fable --> synth
        gpt --> synth
    end

    vet --> preflight[preflight<br/>git status + test baseline]
    preflight --> plan[plan<br/>walking skeleton, then slices]
    plan --> audit[plan:audit<br/>were constraints kept?<br/>only if Vet raised any]
    audit --> gate{go?}

    gate -- no --> planOut([return mode: plan<br/>slices + vetting + audit gaps])
    gate -- yes --> impl

    impl[[Implement: one slice at a time]] --> allDone{every slice done?}
    allDone -- no --> stopOut([return mode: blocked or paused])
    allDone -- yes --> review

    subgraph review [Review]
        rv[review<br/>full diff]
        red[red team<br/>high-risk slices only]
        fix[fix must-fix findings]
        recheck[recheck<br/>read tree + run tests]
        rv --> red --> fix --> recheck
    end

    review --> execOut([return mode: executed])
```

Explore, Vet and the council seats run in parallel. Everything from Plan on
runs in sequence.

## One slice

```mermaid
flowchart TD
    s([slice i]) --> pick{risk low<br/>and has contract?}
    pick -- yes --> sonnet[implement on sonnet]
    pick -- no --> opus[implement on opus]
    sonnet --> st{status done?}
    opus --> st
    st -- no --> blocked([blocked: stop the run])
    st -- yes --> peer1[peer review 1]
    peer1 -- pass --> next([next slice, or pause at until])
    peer1 -- fail --> retry[retry on opus<br/>with the review issues]
    retry --> peer2[peer review 2]
    peer2 -- pass --> next
    peer2 -- fail --> blocked
```

"done" is the implementer's own report. Neither the peer review nor the loop
re-runs the slice's verification command.

## Plan, then execute

```mermaid
sequenceDiagram
    actor You
    participant W as big-feature
    You->>W: task, go: false
    W-->>You: mode: plan, slices, next
    Note over You: read and approve the slices
    alt same session
        You->>W: resumeFromRunId, go: true
        Note over W: Explore, Vet, Plan replay from the resume cache
    else fresh session
        You->>W: slices: [...], go: true
        Note over W: no Explore, Vet, Plan or preflight
    end
    W-->>You: mode: executed, paused or blocked
```

## Known issues

From the audit of 2026-11-02. Each one needs a failing test before its fix.

- The codex heredoc terminator is indented, so the `PROMPT` heredoc never closes.
- Without `dir`, `codex exec -C` receives the text "the current working directory".
- When the council synthesis runs, `vet:deps` blocking findings never reach the planner.
- A carried plan (`slices` + `go`) skips preflight and restarts at slice 1, so it re-implements slices already in the tree.
- Same-session resume depends on the resume cache. Before Claude Code 2.1.305, `parallel()` fan-outs can rerun on resume, so the planner can run again and execute a plan you did not approve.
- The slice's `exitCode` is part of the result schema, but no step reads it.
- With `go: true`, plan-audit gaps only reach the log; execution continues.
