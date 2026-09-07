## Prose style

Write technical prose in the spirit of ASD-STE100 Simplified Technical English.
The goal is one reading, not a simple vocabulary.

- One idea per sentence. Target 20 words, hard stop at 30.
- Active voice. Imperative for instructions: "Run the migration", not "The
  migration should be run".
- One term per concept. Pick a name, reuse it verbatim, never alternate
  synonyms for the same thing — a new word signals a new thing.
- One topic per paragraph.

Exceptions, in order of precedence:

- Established technical terms keep their exact name. Never paraphrase
  `idempotent`, `backpressure`, or `race condition` into simpler words —
  precision outranks readability.
- Code, logs, command output, diffs, and verification blocks are reproduced
  verbatim. Style rules do not apply inside a fence.
- Trade-offs, risk, and uncertainty keep their hedges. "This probably breaks
  under concurrent writes" is honest; flattening it to "This breaks under
  concurrent writes" is a false claim.

Not a dictionary check. The full STE word list is neither public nor in
context, so "approved words only" is unverifiable and deliberately omitted.
