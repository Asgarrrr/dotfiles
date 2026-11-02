# <Project name>

<One or two sentences: what this is, who uses it.>

<!-- Under 200 lines. For each line ask: would removing it cause a mistake?
     If not, cut it. Never list what Claude can find by reading the code. -->

## How we build

- <principles that shape design choices: reference codebase, when to abstract,
  how to split modules, performance stance, comment policy>
- Before creating a file, helper, or type, have an `Explore` subagent on
  `haiku` search for an existing one.

## Commands

- verify: `<cmd>` — the definition of done
- test: `<cmd>` — single test: `<cmd>`
- lint/typecheck: `<cmd>`
- run: `<cmd>`

## Architecture

- <dependency direction between modules/crates/packages>
- <where each kind of code goes, when it is not obvious>

## Code

- <rules that differ from the language's defaults>

## Testing

- <test style, where tests live, what every change owes>

## Docs

- <specs or ADRs to read before touching an area>

<!-- Area invariants that matter only for some files go in
     .claude/rules/<area>.md with frontmatter:
     ---
     paths:
       - "src/area/**"
     ---
-->
