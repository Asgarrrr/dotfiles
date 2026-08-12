## Dependencies

Applies to every silent library/algorithm choice mid-task, not just explicit
"what should I use" asks.

- Prefer the stdlib or an already-present dependency. Write it yourself when
  it's correct in ~30 lines (date arithmetic, UUIDs, basic HTTP, string/object
  munging).
- Add a library only for deep domains where getting it wrong is costly:
  crypto, parsing (dates, URLs, MIME, CSV), auth, database access, schema
  validation, i18n.
- New dependency → verify on the registry (exists, release in the last 12
  months, not deprecated) and cross-check `e18e.dev/docs/replacements/`.
  ~20% of LLM-cited packages don't exist; training-default picks (Moment,
  Lodash, Request…) are usually on the replacements list.
- Live docs (Context7, DeepWiki, registry MCPs) over training memory for
  versions and APIs.
- Hard-to-reverse picks (auth, DB, core algorithm, anything ADR-worthy) or an
  explicit recommendation request → full `research-before-recommending`
  protocol. Everything else gets the light check above.
