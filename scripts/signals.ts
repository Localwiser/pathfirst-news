/**
 * Pathfirst demand & competition signals, batch 1 (TASK-signals-crawl.md, plan A).
 *
 * For each industry × market in signals/config/competitors-by-industry.json:
 *
 *   C3a  a competitor's public changelog — what it kept fixing in the last 12
 *        months, grouped into product areas and counted per release
 *   C3b  its App Store 1–2 star reviews (Apple's official review feed) —
 *        what users complain about, grouped and counted
 *
 * The model (Claude Haiku) only groups and counts; the sentence on the card is
 * built here from those counts. Nothing fetched is kept: no changelog text, no
 * review text, no user names — only category labels, counts, links and dates.
 *
 * Compliance, per source, before any request (config `terms`):
 *   - a changelog is read only if its site's terms were checked and do not
 *     forbid automated access (verdict "allowed"), and robots.txt allows the path
 *   - App Store reviews come from Apple's public RSS feed only
 *   - anything skipped is written to signals/log/latest.json with the reason
 *
 *   bun scripts/signals.ts            fetch, classify, write signals/
 *   bun scripts/signals.ts --dry-run  fetch only: what would be read, no model, no writes
 *   bun scripts/signals.ts --check    check every file in signals/ and exit
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ROOT = join(import.meta.dir, "..");
const CONFIG = join(ROOT, "signals/config/competitors-by-industry.json");
const OUT = join(ROOT, "signals");
const UA = "PathfirstSignalsBot/1.0 (+https://github.com/Localwiser/pathfirst-news)";
const TIMEOUT_MS = 20_000;
/** Haiku, as the news crawl plans for its classification (TASK-signals-crawl.md 运行). */
const MODEL = "claude-haiku-4-5";
const WINDOW_MONTHS = 12;
/** Enough of a changelog page for a year of entries; the model sees no more than this. */
const PAGE_CHARS = 60_000;
/** Apple's feed pages: 50 reviews each, 10 at most. */
const APP_PAGES = 10;
const REVIEW_CHARS = 600;
const MAX_REVIEWS = 200;
/** Apple throttles a burst of feed pages; wait between them, and give page 1 a few tries. */
const PAGE_PAUSE_MS = 1_200;
const FEED_ATTEMPTS = 3;
/**
 * Fewer 1–2 star reviews than this in the window and we say nothing: one unhappy
 * user is not a signal, the same floor U1 puts on user reports (3+ for one problem).
 */
const MIN_LOW_REVIEWS = 3;
/** Under this, a changelog held nothing dated in the window: skip, don't ask the model. */
const MIN_CHANGELOG_CHARS = 80;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- config ----------

type Terms = {
  url: string;
  verdict: "allowed" | "forbidden" | "unclear";
  checked_at: string;
  note?: string;
};
type Competitor = {
  name: string;
  url: string;
  /**
   * html: the page itself. zendesk: a public Help Center section, read through
   * Zendesk's public API (url = the section page; no login, no HTML parsing).
   */
  changelog: { url: string; kind?: "html" | "zendesk"; terms: Terms } | null;
  app_store: { id: number; country: string; app_name: string } | null;
  note?: string;
};
type Combination = {
  industry: string;
  market: string;
  track: string;
  /** industries.json pains for this industry — the reference categories. */
  reference_pains: string[];
  competitors: Competitor[];
};
type Config = { _meta: Record<string, unknown>; combinations: Combination[] };

export type SignalRecord = {
  signal_id: "C3a" | "C3b";
  industry: string;
  market: string;
  track: string;
  competitor: string;
  value: string;
  value_en: string;
  detail: string[];
  detail_en: string[];
  source: string;
  source_urls: string[];
  date: string;
  sample_size: number;
  confidence: "high" | "medium" | "low";
  verified_by: string;
};

type Skip = { industry: string; market: string; competitor: string; source: string; reason: string };

// ---------- fetching ----------

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/json;q=0.9,*/*;q=0.5" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** robots.txt, the * group and ours: is this path allowed? Longest match wins; ties allow. */
export function robotsAllows(robots: string, path: string, agent = "PathfirstSignalsBot"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: field === "allow", path: value });
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap(
    (g) => g.rules,
  );
  const matches = (pattern: string) => {
    const re = new RegExp(
      "^" +
        pattern
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")
          .replace(/\\\$$/, "$"),
    );
    return re.test(path);
  };
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules)
    if (matches(r.path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)))
      best = { allow: r.allow, len: r.path.length };
  return best ? best.allow : true;
}

async function robotsOk(url: string): Promise<boolean> {
  const u = new URL(url);
  try {
    const robots = await get(`${u.origin}/robots.txt`);
    return robotsAllows(robots, u.pathname + u.search);
  } catch {
    // No robots.txt (or it failed): nothing is disallowed.
    return true;
  }
}

/** A page as plain text: scripts, styles and tags out, entities decoded, whitespace collapsed. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|li|h\d|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, PAGE_CHARS);
}

/**
 * A public Zendesk Help Center section as dated plain text, via the Help
 * Center API: https://{host}/hc/{locale}/sections/{id} →
 * /api/v2/help_center/{locale}/sections/{id}/articles.json.
 */
async function zendeskSection(sectionUrl: string, since: string): Promise<string> {
  const m = /^(https:\/\/[^/]+)\/hc\/([^/]+)\/sections\/(\d+)/.exec(sectionUrl);
  if (!m) throw new Error("not a Zendesk section URL");
  const [, origin, locale, id] = m;
  let next: string | null =
    `${origin}/api/v2/help_center/${locale}/sections/${id}/articles.json?per_page=100&sort_by=created_at&sort_order=desc`;
  const parts: string[] = [];
  for (let page = 0; next && page < 5; page++) {
    const body = JSON.parse(await get(next)) as {
      articles: { created_at: string; title: string; body: string | null }[];
      next_page: string | null;
    };
    for (const a of body.articles)
      if (a.created_at.slice(0, 10) >= since)
        parts.push(`${a.created_at.slice(0, 10)} ${a.title}\n${pageText(a.body ?? "")}`);
    next = body.next_page;
  }
  return parts.join("\n\n").slice(0, PAGE_CHARS);
}

type Review = { rating: number; updated: string; text: string };

/** One page of Apple's review feed, or null if it could not be read. */
async function reviewPage(url: string): Promise<Review[] | null> {
  let body: { feed?: { entry?: unknown } };
  try {
    body = JSON.parse(await get(url));
  } catch {
    return null;
  }
  const raw = body.feed?.entry;
  const entries = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<
    string,
    { label?: string } | undefined
  >[];
  // The first entry of page 1 is the app itself (no rating).
  return entries
    .filter((e) => e["im:rating"]?.label)
    .map((e) => ({
      rating: Number(e["im:rating"]!.label),
      updated: e["updated"]?.label ?? "",
      text: `${e["title"]?.label ?? ""}\n${e["content"]?.label ?? ""}`.slice(0, REVIEW_CHARS),
    }));
}

/**
 * Apple's public customer-review feed for one app in one storefront, newest first.
 *
 * Apple throttles pages fetched back to back, and a throttled page does not fail
 * — it answers 200 with the app entry and no reviews, which reads exactly like an
 * app nobody complained about. Misoca returned 223 reviews on one run and 0 on the
 * next for that reason. So page 1 is tried several times with growing pauses, and
 * an empty result is returned as empty rather than as a finding: the caller says
 * "the feed gave nothing" in the log, never "no one complained".
 */
async function appReviews(id: number, country: string): Promise<Review[]> {
  const page = (n: number) =>
    `https://itunes.apple.com/${country}/rss/customerreviews/page=${n}/id=${id}/sortby=mostrecent/json`;
  let first: Review[] = [];
  for (let attempt = 0; attempt < FEED_ATTEMPTS && !first.length; attempt++) {
    if (attempt) await pause(PAGE_PAUSE_MS * (attempt + 1));
    first = (await reviewPage(page(1))) ?? [];
  }
  if (!first.length) return [];
  const out = [...first];
  for (let n = 2; n <= APP_PAGES; n++) {
    await pause(PAGE_PAUSE_MS);
    const more = (await reviewPage(page(n))) ?? [];
    if (!more.length) break;
    out.push(...more);
  }
  return out;
}

// ---------- classification (the model groups and counts; it writes no signal) ----------

const Category = z.object({
  label_zh: z.string().describe("中文，16 字以内，概括这一类，不引用原文"),
  label_en: z.string().describe("English, at most 8 words, a paraphrase, never a quote"),
  count: z.number().int().describe("how many entries fall in this category"),
});
const ChangelogResult = z.object({
  entries_in_window: z.number().int().describe("dated release entries inside the window"),
  latest_date: z.string().describe("YYYY-MM-DD of the newest entry in the window, or empty"),
  categories: z.array(Category),
});
const ReviewResult = z.object({ categories: z.array(Category) });

const SYSTEM = `You group and count; you never quote. Everything you return is a short
paraphrased label and a number. Never copy sentences, names or user details from the
input. Labels are about the product problem ("班表变更没有通知员工"), not about the
company. Prefer the reference categories when one fits; add a new one when none does.`;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

async function classifyChangelog(
  text: string,
  c: Combination,
  competitor: string,
  since: string,
): Promise<z.infer<typeof ChangelogResult> | null> {
  const res = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(ChangelogResult) },
    messages: [
      {
        role: "user",
        content: `This is the public changelog / release notes page of ${competitor}, a tool used in ${c.industry} (${c.market}).

Consider only dated release entries on or after ${since}. Group what those entries change into product areas — what the team kept working on. count = the number of release entries that touch that area (one entry can touch several). Leave out entries that are only bug fixes with no area, and marketing news.

Reference categories (the industry's known problems; use when they fit):
${c.reference_pains.map((p) => `- ${p}`).join("\n")}

Page text:
<page>
${text}
</page>`,
      },
    ],
  });
  if (res.stop_reason === "refusal") return null;
  return res.parsed_output ?? null;
}

async function classifyReviews(
  reviews: Review[],
  c: Combination,
  competitor: string,
): Promise<z.infer<typeof ReviewResult> | null> {
  const res = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(ReviewResult) },
    messages: [
      {
        role: "user",
        content: `These are 1–2 star App Store reviews of ${competitor} (${c.industry}, ${c.market}). Group the complaints into problems and count how many reviews raise each (one review can raise several). Skip reviews with no usable complaint.

Reference categories:
${c.reference_pains.map((p) => `- ${p}`).join("\n")}

${reviews.map((r, i) => `<review n="${i + 1}">${r.text}</review>`).join("\n")}`,
      },
    ],
  });
  if (res.stop_reason === "refusal") return null;
  return res.parsed_output ?? null;
}

// ---------- records (the sentence is built here, from counts) ----------

const clip = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n).join("") : s);
const top = <T extends { count: number }>(xs: T[]) =>
  [...xs].filter((x) => x.count > 0).sort((a, b) => b.count - a.count);

function changelogRecord(
  c: Combination,
  comp: Competitor,
  r: z.infer<typeof ChangelogResult>,
  today: string,
): SignalRecord | null {
  const cats = top(r.categories).slice(0, 5);
  const lead = cats[0];
  if (!lead || r.entries_in_window <= 0) return null;
  return {
    signal_id: "C3a",
    industry: c.industry,
    market: c.market,
    track: c.track,
    competitor: comp.name,
    value: `${comp.name} 最近 ${WINDOW_MONTHS} 个月有 ${lead.count} 个版本在改「${clip(lead.label_zh, 16)}」`,
    value_en: `${comp.name}: ${lead.count} releases in the last ${WINDOW_MONTHS} months worked on "${clip(lead.label_en, 60)}"`,
    detail: cats.map((x) => `${clip(x.label_zh, 16)} (${x.count})`),
    detail_en: cats.map((x) => `${clip(x.label_en, 60)} (${x.count})`),
    source: "changelog",
    source_urls: [comp.changelog!.url],
    date: today,
    sample_size: r.entries_in_window,
    confidence: r.entries_in_window >= 6 ? "high" : r.entries_in_window >= 3 ? "medium" : "low",
    verified_by: "抓取 + LLM 归类",
  };
}

function reviewRecord(
  c: Combination,
  comp: Competitor,
  r: z.infer<typeof ReviewResult>,
  sample: number,
  today: string,
): SignalRecord | null {
  const cats = top(r.categories).slice(0, 5);
  const lead = cats[0];
  if (!lead) return null;
  const app = comp.app_store!;
  return {
    signal_id: "C3b",
    industry: c.industry,
    market: c.market,
    track: c.track,
    competitor: comp.name,
    value: `${comp.name} 的 App 1–2 星评价里「${clip(lead.label_zh, 16)}」出现 ${lead.count} 次`,
    value_en: `"${clip(lead.label_en, 60)}" comes up ${lead.count} times in ${comp.name}'s 1–2 star App Store reviews`,
    detail: cats.map((x) => `${clip(x.label_zh, 16)} (${x.count})`),
    detail_en: cats.map((x) => `${clip(x.label_en, 60)} (${x.count})`),
    source: `App Store (${app.country.toUpperCase()}) 评价`,
    source_urls: [`https://apps.apple.com/${app.country}/app/id${app.id}`],
    date: today,
    sample_size: sample,
    confidence: sample >= 30 ? "high" : sample >= 10 ? "medium" : "low",
    verified_by: "抓取 + LLM 归类",
  };
}

// ---------- the run ----------

const beijingDate = (at = new Date()) =>
  new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

function windowStart(today: string) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - WINDOW_MONTHS);
  return d.toISOString().slice(0, 10);
}

async function run(dry: boolean) {
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as Config;
  const today = beijingDate();
  const since = windowStart(today);
  const skipped: Skip[] = [];
  const out: Record<string, SignalRecord[]> = {};
  const push = (r: SignalRecord | null) => {
    if (!r) return;
    (out[`${r.signal_id}/${r.industry}-${r.market}`] ??= []).push(r);
  };

  for (const c of config.combinations)
    for (const comp of c.competitors) {
      const skip = (source: string, reason: string) => {
        skipped.push({ industry: c.industry, market: c.market, competitor: comp.name, source, reason });
        console.log(`  · skip ${c.industry}-${c.market} ${comp.name} ${source}: ${reason}`);
      };

      // C3a: the changelog, only where the terms were read and do not forbid it.
      if (!comp.changelog) skip("changelog", "no public changelog");
      else if (comp.changelog.terms.verdict !== "allowed")
        skip("changelog", `terms ${comp.changelog.terms.verdict}: ${comp.changelog.terms.note ?? ""}`);
      else if (!(await robotsOk(comp.changelog.url))) skip("changelog", "robots.txt disallows");
      else
        try {
          const text =
            comp.changelog.kind === "zendesk"
              ? await zendeskSection(comp.changelog.url, since)
              : pageText(await get(comp.changelog.url));
          if (text.length < MIN_CHANGELOG_CHARS)
            skip("changelog", `no dated entries since ${since} (${text.length} chars)`);
          else {
            console.log(`  ✓ ${c.industry}-${c.market} ${comp.name} changelog: ${text.length} chars`);
            if (!dry) {
              const r = await classifyChangelog(text, c, comp.name, since);
              if (r) push(changelogRecord(c, comp, r, today));
              else skip("changelog", "model declined");
            }
          }
        } catch (e) {
          skip("changelog", `fetch failed: ${(e as Error).message}`);
        }

      // C3b: 1–2 star reviews from Apple's feed, inside the window.
      if (!comp.app_store) continue;
      try {
        const all = await appReviews(comp.app_store.id, comp.app_store.country);
        const low = all
          .filter((r) => r.rating <= 2 && r.updated.slice(0, 10) >= since)
          .slice(0, MAX_REVIEWS);
        console.log(
          `  ✓ ${c.industry}-${c.market} ${comp.name} App Store: ${all.length} reviews, ${low.length} at 1–2 stars in window`,
        );
        // An empty feed is not a finding: Apple may simply have given us nothing.
        if (!all.length) skip("app_store", "评价 feed 返回 0 条（限流或该地区无评价），不作结论");
        else if (low.length < MIN_LOW_REVIEWS)
          skip("app_store", `1–2 星评价只有 ${low.length} 条，少于 ${MIN_LOW_REVIEWS}，不作结论`);
        else if (!dry) {
          const r = await classifyReviews(low, c, comp.name);
          if (r) push(reviewRecord(c, comp, r, low.length, today));
          else skip("app_store", "model declined");
        }
      } catch (e) {
        skip("app_store", `fetch failed: ${(e as Error).message}`);
      }
    }

  if (dry) {
    console.log(`\ndry run: ${skipped.length} sources skipped, nothing written`);
    return;
  }

  const files: { path: string; count: number }[] = [];
  for (const [key, records] of Object.entries(out)) {
    const [id, name] = key.split("/") as [string, string];
    mkdirSync(join(OUT, id), { recursive: true });
    const file = { _meta: { generated: today, window_start: since, model: MODEL }, signals: records };
    const errs = fileProblems(file);
    if (errs.length) {
      console.error(`✗ ${key}: ${errs.join("; ")}`);
      process.exitCode = 1;
      continue;
    }
    writeFileSync(join(OUT, id, `${name}.json`), `${JSON.stringify(file, null, 2)}\n`);
    files.push({ path: `${id}/${name}.json`, count: records.length });
  }
  mkdirSync(join(OUT, "log"), { recursive: true });
  writeFileSync(join(OUT, "log/latest.json"), `${JSON.stringify({ date: today, skipped }, null, 2)}\n`);
  writeFileSync(
    join(OUT, "index.json"),
    `${JSON.stringify({ generated: today, files: files.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`,
  );
  console.log(`\n✓ ${files.length} signal files, ${skipped.length} sources skipped`);
}

// ---------- checks (also run in CI) ----------

/** No original text may be stored: short labels, counts, links and dates only. */
export function fileProblems(file: { signals?: SignalRecord[] }): string[] {
  const errs: string[] = [];
  const allowed = new Set([
    "signal_id", "industry", "market", "track", "competitor", "value", "value_en", "detail",
    "detail_en", "source", "source_urls", "date", "sample_size", "confidence", "verified_by",
  ]);
  for (const [i, r] of (file.signals ?? []).entries()) {
    const at = `signals[${i}]`;
    for (const k of Object.keys(r)) if (!allowed.has(k)) errs.push(`${at}: field "${k}" is not allowed`);
    if (!["C3a", "C3b"].includes(r.signal_id)) errs.push(`${at}: signal_id ${r.signal_id}`);
    if ([...r.value].length > 80) errs.push(`${at}: value longer than 80 characters`);
    if (r.value_en.length > 200) errs.push(`${at}: value_en longer than 200 characters`);
    for (const d of r.detail) if ([...d].length > 24) errs.push(`${at}: detail "${d}" too long`);
    for (const d of r.detail_en) if (d.length > 72) errs.push(`${at}: detail_en too long`);
    if (!r.source_urls.length || r.source_urls.some((u) => !/^https:\/\//.test(u)))
      errs.push(`${at}: source_urls must be https links`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errs.push(`${at}: date`);
    if (!(r.sample_size > 0)) errs.push(`${at}: sample_size`);
  }
  return errs;
}

function check() {
  const errs: string[] = [];
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as Config;
  for (const c of config.combinations)
    for (const comp of c.competitors)
      if (comp.changelog && !["allowed", "forbidden", "unclear"].includes(comp.changelog.terms.verdict))
        errs.push(`config ${comp.name}: terms verdict`);
  for (const id of ["C3a", "C3b"]) {
    const dir = join(OUT, id);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")))
      for (const e of fileProblems(JSON.parse(readFileSync(join(dir, f), "utf8"))))
        errs.push(`${id}/${f}: ${e}`);
  }
  if (errs.length) {
    console.error(`✗ ${errs.length} problem(s):\n  ${errs.join("\n  ")}`);
    process.exit(1);
  }
  console.log("✓ signals config and files are clean");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) check();
  else await run(args.includes("--dry-run"));
}
