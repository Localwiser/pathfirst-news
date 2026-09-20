import { describe, expect, test } from "bun:test";

import { fileProblems, nonEmpty, pageText, robotsAllows, type SignalRecord } from "./signals";

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

/**
 * signals.json _meta.crawl_rules.empty_is_not_zero. The rule that matters most
 * here: a source answering 200 with nothing must never become "nobody
 * complained". It applies to every source, not only Apple's feed.
 */
describe("空结果只能记「未取到数据」", () => {
  test("重试三次；中途拿到东西就用那一次", async () => {
    let calls = 0;
    const flaky = async () => (++calls < 3 ? [] : ["a", "b"]);
    expect(await nonEmpty(flaky, (v) => v.length, 0)).toEqual(["a", "b"]);
    expect(calls).toBe(3);
  });

  test("三次都空就返回 null —— 不是空数组，调用方没法把它当成结论", async () => {
    let calls = 0;
    const throttled = async () => {
      calls++;
      return [] as string[];
    };
    expect(await nonEmpty(throttled, (v) => v.length, 0)).toBeNull();
    expect(calls).toBe(3);
  });

  test("第一次就有数据的不重试，也不等待", async () => {
    let calls = 0;
    const fine = async () => {
      calls++;
      return [1, 2, 3];
    };
    const started = Date.now();
    expect(await nonEmpty(fine, (v) => v.length, 0)).toEqual([1, 2, 3]);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("「空」由来源自己定义：渲染不出内容的页面和没返回的页面一样空", async () => {
    // A changelog page that came back as a few characters of chrome.
    const stub = async () => ({ text: "菜单 登录", articles: 1 });
    const enough = (s: { text: string }) => (s.text.length >= 80 ? s.text.length : 0);
    expect(await nonEmpty(stub, enough, 0)).toBeNull();
  });
});
