# pathfirst-news

Daily data for Pathfirst's 出海资讯站 (crawl v1). Public on purpose: the site
reads these files at runtime, so a new day never touches the app repository
and never triggers a rebuild there.

- `sources.json` — the only list of sources. The app's `workspace.json`
  (`shell.new_modules.news.crawl_v1`) refers here instead of repeating it.
- `scripts/crawl.ts` — fetches each source (15 s each, failures skipped and
  logged), keeps title / link / source / time / a plain-text summary of at most
  80 characters, and writes `data/{YYYY-MM-DD}.json` (Beijing date). Checks the
  day against the acceptance list before writing. Keeps 14 days.
- `data/index.json` — the days on disk, newest first; the site reads it first.
- `.github/workflows/crawl.yml` — 06:00 Beijing daily, or by hand; commits
  `news：{date} [skip ci]`.

Only titles, summaries, links, times and source names are stored — never full
text or images. No LLM in v1: sections come from the source, nothing is marked
as a product opportunity, industry and market tags stay empty.

```bash
bun install
bun run crawl:dry   # print, write nothing
bun run crawl       # write today's file and the index
bun run check       # check every day file
```
