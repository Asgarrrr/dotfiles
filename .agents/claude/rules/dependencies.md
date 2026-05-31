## Dependencies

Before reaching for a library, answer two questions: *"Can I write this correctly in under ~30 lines?"* and *"Is this a solved, well-maintained problem domain?"*

- **Don't add a library** for things the language or runtime already handles well: date arithmetic, simple string manipulation, UUID generation, basic HTTP, shallow object merging. One focused function beats one new `package.json` entry.
- **Do add a library** when the problem domain is deep and getting it wrong is costly: crypto, parsing (dates, URLs, MIME, CSV), auth, database access, schema validation, i18n. Reinventing these is a reliability and security risk, not a win.
- A library that does one small thing you could write yourself is a dependency tax forever (supply chain, upgrades, breakage). Pay it only when the alternative is worse.
- When in doubt: check if the standard library or an already-present dependency already covers the case before installing anything new.
- **Verify new libraries exist, are fresh, and are not deprecated.** When
  introducing a dependency not already in the project: confirm it on the registry
  (`bun pm view` / `npm view` / equivalent), confirm a release in the last 12
  months, and cross-check against
  [`e18e.dev/docs/replacements/`](https://e18e.dev/docs/replacements/).
  ~20% of libraries cited by LLMs do not exist (slopsquatting). If your
  training-distribution default is on the replacements list (Moment, Lodash,
  Request, Mongoose, Mulberry32, Express-without-a-second-thought…), the
  replacement is the new default.
- **Live-data MCPs > training memory.** Use Context7, DeepWiki, or registry
  MCPs when available rather than recalling versions or APIs from training —
  versions move, APIs are renamed, libraries get deprecated.
