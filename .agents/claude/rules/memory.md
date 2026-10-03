## Memory

- Durable cross-project lessons → `~/.claude/lessons/`, one file per lesson,
  one-line summary on top (format in `lessons/README.md`). Record corrections
  and confirmed approaches alike; update rather than duplicate; delete notes
  that turn out wrong. Check the directory at the start of non-trivial tasks.
- Project facts live in that project's CLAUDE.md (bootstrap from
  `~/.claude/templates/project-claude.md`) or, when they only matter for some
  files, in a path-scoped `.claude/rules/*.md`. When a session surfaces
  something future sessions will need — an architecture fact, a convention, a
  gotcha — write it there in the same change, not just in chat. Keep each
  entry to what would cause a mistake if missing.
