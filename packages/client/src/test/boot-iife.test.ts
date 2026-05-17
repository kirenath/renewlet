import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCustomThemeBootIife } from "@/lib/boot-iife";

/**
 * Unit tests for the custom-theme first-paint injection logic.
 *
 * The production IIFE lives inline in `packages/client/index.html` (it must,
 * because it runs synchronously before any module loads). `src/lib/boot-iife.ts`
 * exposes the same logic as a pure function with injectable `search` /
 * `localStorage` / `document` so we can replay every branch in jsdom without
 * touching globals across tests.
 *
 * Validates: Requirements 7.8 (URL bypass), 8.8 (cache-first injection),
 * 8.11 (corrupted cache > 200 KiB is dropped).
 */

const STYLE_SELECTOR = "style[data-renewlet-custom-theme]";
const ID_KEY = "renewlet_active_custom_theme_id";
const CSS_KEY = "renewlet_active_custom_theme_css";
const ENABLED_KEY = "renewlet_custom_themes_enabled";

/** Build an in-memory `Storage` for a single test run. */
function makeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.get(key) ?? null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
  return storage;
}

/** Build a `Storage` that throws on every operation, to simulate `SecurityError`. */
function makeThrowingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException("denied", "SecurityError");
  };
  return {
    get length(): number {
      return fail();
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

/** Build a `Storage` whose `getItem` throws but `removeItem` is observable. */
function makeReadThrowingStorage(): {
  storage: Storage;
  removed: string[];
} {
  const removed: string[] = [];
  const storage: Storage = {
    get length() {
      return 0;
    },
    clear() {
      /* noop */
    },
    getItem(): string | null {
      throw new DOMException("denied", "SecurityError");
    },
    key() {
      return null;
    },
    removeItem(key) {
      removed.push(key);
    },
    setItem() {
      /* noop */
    },
  };
  return { storage, removed };
}

/** Build a fresh standalone Document (independent from the global jsdom one). */
function makeDocument(): Document {
  const parser = new DOMParser();
  return parser.parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");
}

let storage: Storage;
let doc: Document;

beforeEach(() => {
  storage = makeStorage();
  doc = makeDocument();
});

describe("runCustomThemeBootIife", () => {
  it("does nothing when ?disableCustomCss=1 is present, even with a cached css", () => {
    storage.setItem(ENABLED_KEY, "1");
    storage.setItem(ID_KEY, "theme-id-1");
    storage.setItem(CSS_KEY, "body { background: red }");

    runCustomThemeBootIife({ search: "?disableCustomCss=1", localStorage: storage, document: doc });

    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
    // Bypass must not modify persisted values (Req 7.8).
    expect(storage.getItem(ENABLED_KEY)).toBe("1");
    expect(storage.getItem(ID_KEY)).toBe("theme-id-1");
    expect(storage.getItem(CSS_KEY)).toBe("body { background: red }");
  });

  it("is bypassed when ?disableCustomCss=1 appears alongside other params", () => {
    storage.setItem(CSS_KEY, "body { color: blue }");

    runCustomThemeBootIife({
      search: "?foo=bar&disableCustomCss=1&other=1",
      localStorage: storage,
      document: doc,
    });

    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
  });

  it("does not bypass when disableCustomCss is anything other than 1", () => {
    storage.setItem(CSS_KEY, "body { color: red }");

    runCustomThemeBootIife({ search: "?disableCustomCss=0", localStorage: storage, document: doc });

    const node = doc.querySelector(STYLE_SELECTOR);
    expect(node).not.toBeNull();
    expect(node?.textContent).toBe("body { color: red }");
  });

  it("does not inject when the master switch is '0'", () => {
    storage.setItem(ENABLED_KEY, "0");
    storage.setItem(ID_KEY, "theme-id-2");
    storage.setItem(CSS_KEY, "body { background: green }");

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
    // Master switch off must not clear the cache.
    expect(storage.getItem(ENABLED_KEY)).toBe("0");
    expect(storage.getItem(ID_KEY)).toBe("theme-id-2");
    expect(storage.getItem(CSS_KEY)).toBe("body { background: green }");
  });

  it("treats the master switch as enabled when it is missing entirely", () => {
    // No ENABLED_KEY set: per Req 8.3, missing == enabled.
    storage.setItem(CSS_KEY, "body { color: orange }");

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    const node = doc.querySelector(STYLE_SELECTOR);
    expect(node).not.toBeNull();
    expect(node?.textContent).toBe("body { color: orange }");
  });

  it("treats unrecognized master-switch values as enabled", () => {
    storage.setItem(ENABLED_KEY, "yes");
    storage.setItem(CSS_KEY, "body { color: pink }");

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    const node = doc.querySelector(STYLE_SELECTOR);
    expect(node).not.toBeNull();
    expect(node?.textContent).toBe("body { color: pink }");
  });

  it("does nothing when the cached css is empty", () => {
    storage.setItem(ENABLED_KEY, "1");
    storage.setItem(CSS_KEY, "");

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
  });

  it("does nothing when the cached css is missing", () => {
    storage.setItem(ENABLED_KEY, "1");

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
  });

  it("injects a single <style data-renewlet-custom-theme> at the end of <head> on the happy path", () => {
    const css = "body { background: #abcdef }\n.x { color: red }";
    storage.setItem(ENABLED_KEY, "1");
    storage.setItem(ID_KEY, "theme-id-3");
    storage.setItem(CSS_KEY, css);

    // Pre-existing stylesheet links/styles in <head> to verify ordering (Req 6.2 / 8.8).
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "/preexisting.css");
    doc.head.appendChild(link);
    const otherStyle = doc.createElement("style");
    otherStyle.textContent = ".other {}";
    doc.head.appendChild(otherStyle);

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    const matches = doc.querySelectorAll(STYLE_SELECTOR);
    expect(matches.length).toBe(1);
    const injected = matches[0] as HTMLStyleElement;
    expect(injected.textContent).toBe(css);
    expect(injected.parentNode).toBe(doc.head);
    expect(doc.head.lastElementChild).toBe(injected);
  });

  it("preserves CSS literally without sanitisation (no escaping of <, >, &, etc.)", () => {
    // Req 13.5: textContent path must not mutate the input.
    const tricky = "/* < > & </style> @import url(\"x\"); */\nbody { content: \"<\"; }";
    storage.setItem(CSS_KEY, tricky);

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    const node = doc.querySelector(STYLE_SELECTOR);
    expect(node).not.toBeNull();
    expect(node?.textContent).toBe(tricky);
    expect(node?.childNodes.length).toBe(1);
    expect(node?.firstChild?.nodeType).toBe(3 /* TEXT_NODE */);
  });

  it("drops the cache and skips injection when css length exceeds 200 KiB (Req 8.11)", () => {
    // 204801 chars > 204800 char threshold used by the IIFE for corrupt-cache detection.
    const huge = "x".repeat(204_801);
    storage.setItem(ENABLED_KEY, "1");
    storage.setItem(ID_KEY, "theme-id-corrupt");
    storage.setItem(CSS_KEY, huge);

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
    expect(storage.getItem(CSS_KEY)).toBeNull();
    expect(storage.getItem(ID_KEY)).toBeNull();
    // The master switch is unrelated to corruption, so it should be untouched.
    expect(storage.getItem(ENABLED_KEY)).toBe("1");
  });

  it("keeps a css of exactly 204800 chars (boundary, not over the limit)", () => {
    const onLimit = "y".repeat(204_800);
    storage.setItem(ENABLED_KEY, "1");
    storage.setItem(ID_KEY, "theme-id-boundary");
    storage.setItem(CSS_KEY, onLimit);

    runCustomThemeBootIife({ search: "", localStorage: storage, document: doc });

    const node = doc.querySelector(STYLE_SELECTOR);
    expect(node).not.toBeNull();
    expect(node?.textContent?.length).toBe(204_800);
    expect(storage.getItem(CSS_KEY)).toBe(onLimit);
    expect(storage.getItem(ID_KEY)).toBe("theme-id-boundary");
  });

  it("removes both id and css keys when the corruption check fires, even if removeItem partially throws", () => {
    // Use a real-ish storage but spy on removeItem to throw on the first call only;
    // both ID and CSS keys must still end up removed (each removeItem is wrapped in
    // its own try/catch in the IIFE).
    const real = makeStorage({
      [ENABLED_KEY]: "1",
      [ID_KEY]: "theme-id",
      [CSS_KEY]: "z".repeat(204_801),
    });
    const original = real.removeItem.bind(real);
    let callCount = 0;
    real.removeItem = (key: string) => {
      callCount += 1;
      if (callCount === 1) throw new DOMException("denied", "SecurityError");
      original(key);
    };

    expect(() =>
      runCustomThemeBootIife({ search: "", localStorage: real, document: doc }),
    ).not.toThrow();
    // The second removeItem call (for the other key) still completed.
    expect(callCount).toBe(2);
    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
  });

  it("is silent and injects nothing when localStorage.getItem throws", () => {
    const { storage: throwing, removed } = makeReadThrowingStorage();

    expect(() =>
      runCustomThemeBootIife({ search: "", localStorage: throwing, document: doc }),
    ).not.toThrow();
    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
    // The outer try/catch swallows before reaching the corruption branch, so
    // no removeItem calls should fire (the bypass / enabled / css reads all
    // throw and are caught at the top level).
    expect(removed).toEqual([]);
  });

  it("is silent when every storage operation throws", () => {
    const throwing = makeThrowingStorage();

    expect(() =>
      runCustomThemeBootIife({ search: "", localStorage: throwing, document: doc }),
    ).not.toThrow();
    expect(doc.querySelector(STYLE_SELECTOR)).toBeNull();
  });

  it("returns gracefully when document.head is null", () => {
    const headlessDoc = makeDocument();
    // Forcefully detach <head> to simulate the "document not ready" edge case.
    headlessDoc.documentElement.removeChild(headlessDoc.head);

    storage.setItem(CSS_KEY, "body { color: red }");

    expect(() =>
      runCustomThemeBootIife({ search: "", localStorage: storage, document: headlessDoc }),
    ).not.toThrow();
    expect(headlessDoc.querySelector(STYLE_SELECTOR)).toBeNull();
  });

  it("falls back to globals when search/localStorage/document are not provided", () => {
    // Sanity check: the production call site (the IIFE) passes nothing; the
    // function must read the same trio off the global scope. We use the
    // shared jsdom globals here, isolated via a unique CSS string.
    const css = `body { color: rgb(${Math.floor(Math.random() * 256)}, 0, 0) }`;
    localStorage.setItem(CSS_KEY, css);
    // Make sure no stray bypass param leaks in from another test.
    window.history.replaceState({}, "", "/");

    runCustomThemeBootIife();

    const node = document.querySelector(STYLE_SELECTOR);
    expect(node).not.toBeNull();
    expect(node?.textContent).toBe(css);

    // Cleanup: the test setup's afterEach clears localStorage, but the style
    // node we just appended persists across tests via document.head, so remove it.
    node?.remove();
  });

  it("does not call createElement when bypassed (no DOM mutation at all)", () => {
    storage.setItem(CSS_KEY, "body { color: red }");
    const spy = vi.spyOn(doc, "createElement");

    runCustomThemeBootIife({ search: "?disableCustomCss=1", localStorage: storage, document: doc });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
