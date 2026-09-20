import { describe, expect, test } from "bun:test";

import { fileProblems, pageText, robotsAllows, type SignalRecord } from "./signals";

describe("robots.txt", () => {
  const robots = `User-agent: *\nDisallow: /admin/\nAllow: /admin/news\n\nUser-agent: BadBot\nDisallow: /`;
  test("the * group applies to us; longest match wins", () => {
    expect(robotsAllows(robots, "/release-notes")).toBe(true);
    expect(robotsAllows(robots, "/admin/x")).toBe(false);
    expect(robotsAllows(robots, "/admin/news")).toBe(true);
  });
  test("a group naming us replaces *", () => {
    const ours = `User-agent: *\nDisallow:\n\nUser-agent: PathfirstSignalsBot\nDisallow: /`;
    expect(robotsAllows(ours, "/anything")).toBe(false);
  });
  test("wildcards and $", () => {
    expect(robotsAllows(`User-agent: *\nDisallow: /*?lastmod=*`, "/news?lastmod=1")).toBe(false);
    expect(robotsAllows(`User-agent: *\nDisallow: /*.pdf$`, "/a.pdf")).toBe(false);
    expect(robotsAllows(`User-agent: *\nDisallow: /*.pdf$`, "/a.pdf?x")).toBe(true);
  });
});

test("page text drops scripts, styles and tags", () => {
  const t = pageText(`<style>x{}</style><h2>2026-05-01</h2><p>Shift&nbsp;swap</p><script>1</script>`);
  expect(t).toBe("2026-05-01\nShift swap");
});

describe("stored files hold no original text", () => {
  const ok: SignalRecord = {
    signal_id: "C3a",
    industry: "local_life",
    market: "DE",
    track: "micro_saas",
    competitor: "X",
    value: "X 最近 12 个月有 4 个版本在改「排班通知」",
    value_en: 'X: 4 releases in the last 12 months worked on "shift notifications"',
    detail: ["排班通知 (4)"],
    detail_en: ["Shift notifications (4)"],
    source: "changelog",
    source_urls: ["https://example.com/changelog"],
    date: "2026-09-20",
    sample_size: 9,
    confidence: "high",
    verified_by: "抓取 + LLM 归类",
  };
  test("a clean record passes", () => expect(fileProblems({ signals: [ok] })).toEqual([]));
  test("an extra field (review text, author) fails", () => {
    const bad = { ...ok, text: "the original review" } as unknown as SignalRecord;
    expect(fileProblems({ signals: [bad] }).join()).toContain('"text"');
  });
  test("a detail long enough to be a quote fails", () => {
    expect(fileProblems({ signals: [{ ...ok, detail: ["这是一整句从评价里直接抄过来的原文内容不应该出现在这里"] }] })).not.toEqual([]);
  });
});
