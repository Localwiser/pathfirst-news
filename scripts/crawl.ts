/**
 * 出海资讯站 crawl v1 (Pathfirst workspace.json shell.new_modules.news.crawl_v1).
 *
 * Zero accounts, zero cost, nothing running between runs: fetch each source in
 * sources.json (the only list of sources), keep title / link / source / time /
 * a short plain-text summary, and write data/{YYYY-MM-DD}.json in Pathfirst's
 * news item shape, plus data/index.json — the list of days the site fetches. No LLM —
 * the section comes from the source, is_opportunity is always false, industry
 * and market tags stay empty, English stays English (lang=en).
 *
 * A source that fails or takes longer than 15 seconds is skipped and logged;
 * it never fails the run. Only a run where no source answered exits non-zero,
 * so a broken network is noticed instead of committing an empty day.
 *
 *   bun scripts/crawl.ts            today (Beijing date)
 *   bun scripts/crawl.ts --dry-run  print, write nothing
 *   bun scripts/crawl.ts --check    check every file in data/ and exit
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import Parser from "rss-parser";

type Source = {
  id: string;
  name: string;
  type: "api" | "rss";
  url: string;
  item_url?: string;
  take?: number;
  section: string;
};

export type CrawledItem = {
  id: string;
  title: string;
  summary: string;
  source: { id: string; name: string };
  url: string;
  published: string;
  published_at: string;
  section: string;
  sections: string[];
  lang: "en" | "zh";
  industry_group: string;
  markets: string[];
  is_opportunity: false;
  ai_summary: false;
};

type SourceLog = {
  id: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
};

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "data");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8")) as {
  default_take: number;
  timeout_seconds: number;
  keep_days: number;
  hn_min_score: number;
  summary_max: number;
  sections: string[];
  sources: Source[];
};
const SOURCES = CONFIG.sources;

const TIMEOUT_MS = CONFIG.timeout_seconds * 1000;
/** Sources without `take` (their feeds can hold hundreds of old posts). */
const DEFAULT_TAKE = CONFIG.default_take;
const HN_MIN_SCORE = CONFIG.hn_min_score;
const SUMMARY_MAX = CONFIG.summary_max;
const KEEP_DAYS = CONFIG.keep_days;
const DRY = process.argv.includes("--dry-run");
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** The run is at 06:00 Beijing, so the day is Beijing's. */
export function beijingDate(at = new Date()): string {
  return new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** summary_rule: tags out, entities decoded, whitespace collapsed, at most 80 characters. */
export function plainSummary(html: string, max = SUMMARY_MAX): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

export const langOf = (text: string): "en" | "zh" =>
  /[一-鿿]/.test(text) ? "zh" : "en";

/** dedupe: one url once (fragment and trailing slash ignored). */
export const urlKey = (url: string) => {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
};

/** dedupe: the same title on the same day, ignoring case and punctuation. */
export const titleKey = (title: string) =>
  title.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");

const idOf = (source: string, url: string) =>
  `${source}-${createHash("sha1").update(urlKey(url)).digest("hex").slice(0, 10)}`;

function item(
  src: Source,
  title: string,
  url: string,
  when: string,
  summary: string,
): CrawledItem {
  const published = new Date(when).toISOString();
  return {
    id: idOf(src.id, url),
    title: title.trim(),
    summary,
    source: { id: src.id, name: src.name },
    url,
    published,
    published_at: published,
    section: src.section,
    sections: [src.section],
    lang: langOf(`${title} ${summary}`),
    // skip_in_v1: no industry or market tags, never an opportunity.
    industry_group: "",
    markets: [],
    is_opportunity: false,
    ai_summary: false,
  };
}

async function getText(url: string, signal: AbortSignal) {
  const res = await fetch(url, {
    signal,
    headers: {
      "user-agent": "PathfirstNewsBot/1.0 (+https://github.com/Localwiser)",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Hacker News: the top stories, only stories with a link and score ≥ 100. No summary, so the title. */
async function hackerNews(
  src: Source,
  signal: AbortSignal,
): Promise<CrawledItem[]> {
  const ids = (JSON.parse(await getText(src.url, signal)) as number[]).slice(
    0,
    src.take ?? 30,
  );
  const stories = await Promise.all(
    ids.map(async (id) => {
      try {
        const url = (src.item_url ?? "").replace("{id}", String(id));
        return JSON.parse(await getText(url, signal)) as {
          type?: string;
          url?: string;
          title?: string;
          score?: number;
          time?: number;
        } | null;
      } catch {
        return null;
      }
    }),
  );
  if (signal.aborted) throw new Error("timeout");
  return stories
    .filter(
      (s) =>
        s?.type === "story" &&
        s.url &&
        s.title &&
        (s.score ?? 0) >= HN_MIN_SCORE,
    )
    .map((s) =>
      item(
        src,
        s!.title!,
        s!.url!,
        new Date(s!.time! * 1000).toISOString(),
        plainSummary(s!.title!),
      ),
    );
}

const parser = new Parser();

async function rss(src: Source, signal: AbortSignal): Promise<CrawledItem[]> {
  const feed = await parser.parseString(await getText(src.url, signal));
  return feed.items
    .filter((e) => e.title && e.link)
    .sort(
      (a, b) =>
        Date.parse(b.isoDate ?? b.pubDate ?? "") -
        Date.parse(a.isoDate ?? a.pubDate ?? ""),
    )
    .slice(0, src.take ?? DEFAULT_TAKE)
    .map((e) => {
      const raw =
        e.contentSnippet ||
        e.summary ||
        e.content ||
        (e as { description?: string }).description ||
        "";
      const summary = plainSummary(raw) || plainSummary(e.title!);
      const when = e.isoDate ?? e.pubDate;
      return item(
        src,
        plainSummary(e.title!, 300),
        e.link!,
        when && !Number.isNaN(Date.parse(when))
          ? when
          : new Date().toISOString(),
        summary,
      );
    });
}

async function crawl(
  src: Source,
): Promise<{ items: CrawledItem[]; log: SourceLog }> {
  const started = Date.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const items = await Promise.race([
      src.type === "api" ? hackerNews(src, signal) : rss(src, signal),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () =>
          reject(new Error(`timeout after ${TIMEOUT_MS / 1000}s`)),
        ),
      ),
    ]);
    return {
      items,
      log: {
        id: src.id,
        ok: true,
        count: items.length,
        ms: Date.now() - started,
      },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      items: [],
      log: { id: src.id, ok: false, count: 0, ms: Date.now() - started, error },
    };
  }
}

/** Earlier items win: by url, then by same-day title. */
export function dedupe(items: CrawledItem[]): CrawledItem[] {
  const urls = new Set<string>();
  const titles = new Set<string>();
  return items.filter((i) => {
    const u = urlKey(i.url);
    const t = titleKey(i.title);
    if (urls.has(u) || (t && titles.has(t))) return false;
    urls.add(u);
    if (t) titles.add(t);
    return true;
  });
}

/**
 * crawl_v1.acceptance, per day file: title / url / source / published_at /
 * summary / section on every item; a plain-text summary within the limit; a
 * url once; no opportunity, industry or market tags in v1.
 */
export function dayProblems(
  name: string,
  day: { _meta?: { date?: string }; items?: Record<string, unknown>[] },
) {
  const errs: string[] = [];
  if (day._meta?.date !== name.slice(0, 10))
    errs.push(`${name}: _meta.date differs from the name`);
  const urls = new Set<string>();
  for (const [n, i] of (day.items ?? []).entries()) {
    const at = `${name} items.${n}`;
    for (const f of ["title", "url", "published_at", "summary", "section"])
      if (typeof i[f] !== "string" || !(i[f] as string).trim())
        errs.push(`${at}.${f}: missing`);
    const source = i["source"] as { id?: string; name?: string } | undefined;
    if (!source?.id || !source.name) errs.push(`${at}.source: missing`);
    const summary = String(i["summary"] ?? "");
    if ([...summary].length > SUMMARY_MAX)
      errs.push(`${at}.summary: over ${SUMMARY_MAX} characters`);
    if (/<[a-z/][^>]*>/i.test(summary))
      errs.push(`${at}.summary: contains HTML`);
    if (!CONFIG.sections.includes(String(i["section"])))
      errs.push(`${at}.section: unknown "${String(i["section"])}"`);
    if (Number.isNaN(Date.parse(String(i["published_at"]))))
      errs.push(`${at}.published_at: not a date`);
    const url = String(i["url"]);
    if (urls.has(url)) errs.push(`${at}.url: duplicate ${url}`);
    urls.add(url);
    if (i["is_opportunity"] !== false)
      errs.push(`${at}.is_opportunity: must be false in v1`);
    if (i["industry_group"] || (i["markets"] as unknown[] | undefined)?.length)
      errs.push(`${at}: industry and market tags stay empty in v1`);
  }
  return errs;
}

function checkAll() {
  const errs = existsSync(OUT_DIR)
    ? readdirSync(OUT_DIR)
        .filter((n) => DAY_FILE.test(n))
        .flatMap((n) =>
          dayProblems(n, JSON.parse(readFileSync(join(OUT_DIR, n), "utf8"))),
        )
    : [];
  for (const s of SOURCES)
    if (!CONFIG.sections.includes(s.section))
      errs.push(`sources.json ${s.id}: unknown section "${s.section}"`);
  return errs;
}

/** data/index.json: the days on disk, newest first — what the site reads before the day files. */
function writeIndex() {
  const days = readdirSync(OUT_DIR)
    .filter((n) => DAY_FILE.test(n))
    .sort()
    .reverse()
    .map((n) => {
      const d = JSON.parse(readFileSync(join(OUT_DIR, n), "utf8"));
      return {
        date: d._meta.date,
        fetched_at: d._meta.fetched_at,
        items: d.items.length,
        file: n,
      };
    });
  const index = { updated_at: days[0]?.fetched_at ?? null, days };
  writeFileSync(
    join(OUT_DIR, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
}

async function main() {
  if (process.argv.includes("--check")) {
    const errs = checkAll();
    console.log(
      errs.length
        ? `✗ ${errs.length} problem(s):\n  ${errs.join("\n  ")}`
        : "✓ data valid",
    );
    process.exit(errs.length ? 1 : 0);
  }
  const date = beijingDate();
  const results = await Promise.all(SOURCES.map(crawl));
  for (const { log } of results)
    console.log(
      `${log.ok ? "✓" : "✗"} ${log.id.padEnd(12)} ${String(log.count).padStart(3)} items  ${log.ms} ms${log.error ? `  — ${log.error}` : ""}`,
    );

  const file = join(OUT_DIR, `${date}.json`);
  // A second run on the same day adds to what the first one kept.
  let earlier: CrawledItem[] = [];
  try {
    earlier = JSON.parse(readFileSync(file, "utf8")).items ?? [];
  } catch {
    // First run today.
  }
  const fresh = results.flatMap((r) => r.items);
  const items = dedupe([...earlier, ...fresh]).sort((a, b) =>
    b.published.localeCompare(a.published),
  );
  const ok = results.filter((r) => r.log.ok).length;
  console.log(
    `${date}: ${ok}/${SOURCES.length} sources, ${items.length} items`,
  );

  if (DRY) {
    console.log(JSON.stringify(items.slice(0, 3), null, 2));
    return;
  }
  if (ok === 0) {
    console.error("No source answered; nothing written.");
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    _meta: {
      date,
      fetched_at: new Date().toISOString(),
      spec: "Pathfirst workspace.json shell.new_modules.news.crawl_v1",
      default_take: DEFAULT_TAKE,
      sources: results.map((r) => r.log),
    },
    items,
  };
  const problems = dayProblems(`${date}.json`, out);
  if (problems.length) {
    console.error(`✗ not written:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${file}`);

  // runner.keep: the last 14 days only.
  const oldest = beijingDate(
    new Date(
      Date.parse(`${date}T12:00:00+08:00`) - (KEEP_DAYS - 1) * 86_400_000,
    ),
  );
  for (const name of readdirSync(OUT_DIR)) {
    const day = name.match(DAY_FILE)?.[1];
    if (day && day < oldest) {
      rmSync(join(OUT_DIR, name));
      console.log(`removed ${name}`);
    }
  }
  writeIndex();
}

if (import.meta.main) await main();
