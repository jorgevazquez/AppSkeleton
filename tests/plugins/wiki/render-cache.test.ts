/**
 * Unit tests for feature #101 ("Wiki rendered-page caching with
 * invalidation on edit"), `src/plugins/wiki/src/render-cache.ts`. Pure
 * in-memory behavior — no I/O, no capability broker, no database — mirroring
 * `tests/plugins/html-renderer/template-cache.test.ts`'s own "exercise the
 * cache module directly" style for its sibling caching layer.
 */
import { describe, expect, it } from "vitest";
import { createWikiRenderCache } from "../../../src/plugins/wiki/src/render-cache.js";

describe("createWikiRenderCache: basic caching", () => {
  it("misses on a page id that has never been set", () => {
    const cache = createWikiRenderCache();

    expect(cache.currentRevisionId(1)).toBe(0);
    expect(cache.get(1, 0)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("hits on the exact revision id it was set under", () => {
    const cache = createWikiRenderCache();
    const revisionId = cache.currentRevisionId(42);

    cache.set(42, revisionId, "<p>hello</p>");

    expect(cache.get(42, revisionId)).toBe("<p>hello</p>");
    expect(cache.size()).toBe(1);
  });

  it("tracks distinct page ids as separate entries", () => {
    const cache = createWikiRenderCache();

    cache.set(1, cache.currentRevisionId(1), "<p>one</p>");
    cache.set(2, cache.currentRevisionId(2), "<p>two</p>");

    expect(cache.get(1, 0)).toBe("<p>one</p>");
    expect(cache.get(2, 0)).toBe("<p>two</p>");
    expect(cache.size()).toBe(2);
  });

  it("clear() drops every entry and resets every revision counter back to 0", () => {
    const cache = createWikiRenderCache();
    cache.set(1, cache.currentRevisionId(1), "<p>one</p>");
    cache.invalidate(1);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.currentRevisionId(1)).toBe(0);
  });
});

describe("createWikiRenderCache: invalidation on edit (feature #101 step 2/3)", () => {
  it("a stale cached render is never served after invalidate() — the old revision id no longer hits", () => {
    const cache = createWikiRenderCache();
    const pageId = 7;

    // Simulate a render: cache the page's rendered HTML under its current revision id.
    const originalRevisionId = cache.currentRevisionId(pageId);
    cache.set(pageId, originalRevisionId, "<p>Original content</p>");
    expect(cache.get(pageId, originalRevisionId)).toBe("<p>Original content</p>");

    // Simulate an edit: the page's content changed, so the route handler invalidates immediately.
    cache.invalidate(pageId);

    // The old revision id must never hit again, even though its entry briefly existed.
    expect(cache.get(pageId, originalRevisionId)).toBeUndefined();

    // A fresh render for the new revision id is cached and served — proving normal
    // operation resumes, it's specifically the *stale* render that's gone.
    const newRevisionId = cache.currentRevisionId(pageId);
    expect(newRevisionId).not.toBe(originalRevisionId);
    cache.set(pageId, newRevisionId, "<p>Updated content</p>");
    expect(cache.get(pageId, newRevisionId)).toBe("<p>Updated content</p>");
  });

  it("invalidate() is safe to call for a page id that was never cached", () => {
    const cache = createWikiRenderCache();

    expect(() => cache.invalidate(999)).not.toThrow();
    expect(cache.currentRevisionId(999)).toBe(1);
    expect(cache.get(999, 1)).toBeUndefined();
  });

  it("invalidating one page id never affects another page id's cached render", () => {
    const cache = createWikiRenderCache();
    cache.set(1, cache.currentRevisionId(1), "<p>page one</p>");
    cache.set(2, cache.currentRevisionId(2), "<p>page two</p>");

    cache.invalidate(1);

    expect(cache.get(1, 0)).toBeUndefined();
    expect(cache.get(2, 0)).toBe("<p>page two</p>");
  });

  it("repeated edits keep bumping the revision id, each invalidating the previous render", () => {
    const cache = createWikiRenderCache();
    const pageId = 3;

    const r0 = cache.currentRevisionId(pageId);
    cache.set(pageId, r0, "<p>v1</p>");

    cache.invalidate(pageId);
    const r1 = cache.currentRevisionId(pageId);
    cache.set(pageId, r1, "<p>v2</p>");

    cache.invalidate(pageId);
    const r2 = cache.currentRevisionId(pageId);

    expect([r0, r1, r2].every((value, index, all) => all.indexOf(value) === index)).toBe(true);
    expect(cache.get(pageId, r0)).toBeUndefined();
    expect(cache.get(pageId, r1)).toBeUndefined();
    expect(cache.get(pageId, r2)).toBeUndefined();
  });
});
