import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY,
  ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY,
  CUSTOM_THEMES_ENABLED_STORAGE_KEY,
  clearActiveCustomThemeFromStorage,
  writeActiveCustomThemeToStorage,
  writeCustomThemesEnabledToStorage,
} from "./theme-storage";

/**
 * Property 15: Theme_Storage 写入顺序与原子异常吞掉
 *
 * Validates: Requirements 8.4, 8.5, 8.6, 8.7
 *
 * 用 fast-check 生成 (id, css) 与“在第几次 setItem/removeItem 抛错”的索引：
 * - 写入函数始终同步返回 undefined（无异步切换点）
 * - 无错误时，writeActiveCustomThemeToStorage 观测到的 setItem 调用序列严格等于
 *   [(ID_KEY, id), (CSS_KEY, css)]
 * - clearActiveCustomThemeFromStorage 内两次 removeItem 各自独立 try/catch，
 *   即使第一次抛错也照常调用第二次
 * - 三个写入函数在 setItem/removeItem 任意调用抛出任意异常（DOMException、
 *   Error 子类、字符串、数字 ……）时不重抛、不抛新异常
 */

const arbId = fc.string({ minLength: 1, maxLength: 64 });
const arbCss = fc.string({ minLength: 0, maxLength: 1024 });

// 各种可能从 storage 抛出的异常形态：标准 DOMException 子类、Error 子类、
// 自定义 Error，以及非 Error 值（throw 接受任意值）。
const arbThrown = fc.oneof(
  fc.constant(() => new DOMException("quota exceeded", "QuotaExceededError")),
  fc.constant(() => new DOMException("security", "SecurityError")),
  fc.constant(() => new DOMException("invalid state", "InvalidStateError")),
  fc.constant(() => new DOMException("generic")),
  fc.constant(() => new Error("custom error")),
  fc.constant(() => new TypeError("type error")),
  fc.constant(() => new RangeError("range error")),
  fc.constant(() => "string thrown"),
  fc.constant(() => 42),
  fc.constant(() => null),
);

/**
 * 安装一个可观测、可控抛错的 localStorage 替身。
 *
 * - `setItemBehavior`：`(callIndex, key, value) => undefined | () => unknown`
 *   返回函数则在内部 throw 该函数返回的值（允许构造任意 throwable）。
 * - `removeItemBehavior`：同上。
 *
 * 通过 `vi.stubGlobal('localStorage', ...)` 替换全局，使 `localStorage.setItem`
 * 调用会真正命中本替身，便于观测与控制抛错。`afterEach` 中 `vi.unstubAllGlobals`
 * 已被默认还原，不会污染其它测试。
 */
type ThrowFactory = () => unknown;
type CallBehavior = (
  callIndex: number,
  key: string,
  value: string | undefined,
) => ThrowFactory | undefined;

interface InstalledMock {
  setItemCalls: Array<[string, string]>;
  removeItemCalls: string[];
}

function installMockStorage(opts: {
  setItemBehavior?: CallBehavior;
  removeItemBehavior?: CallBehavior;
} = {}): InstalledMock {
  const setItemCalls: Array<[string, string]> = [];
  const removeItemCalls: string[] = [];
  let setItemIndex = 0;
  let removeItemIndex = 0;

  const mock: Storage = {
    get length() {
      return 0;
    },
    clear: vi.fn(),
    getItem: vi.fn().mockReturnValue(null),
    key: vi.fn().mockReturnValue(null),
    setItem: (key: string, value: string) => {
      const here = setItemIndex++;
      setItemCalls.push([key, value]);
      const factory = opts.setItemBehavior?.(here, key, value);
      if (factory) {
        throw factory();
      }
    },
    removeItem: (key: string) => {
      const here = removeItemIndex++;
      removeItemCalls.push(key);
      const factory = opts.removeItemBehavior?.(here, key, undefined);
      if (factory) {
        throw factory();
      }
    },
  };

  vi.stubGlobal("localStorage", mock);
  return { setItemCalls, removeItemCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Property 15: theme-storage 写入顺序与原子异常吞掉 (Validates: Requirements 8.4, 8.5, 8.6, 8.7)", () => {
  it("writeActiveCustomThemeToStorage 无错误时按 [(ID_KEY, id), (CSS_KEY, css)] 同步顺序写入并返回 undefined", () => {
    fc.assert(
      fc.property(arbId, arbCss, (id, css) => {
        const { setItemCalls } = installMockStorage();
        try {
          const result = writeActiveCustomThemeToStorage(id, css);

          expect(result).toBeUndefined();
          expect(setItemCalls).toEqual([
            [ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY, id],
            [ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY, css],
          ]);
        } finally {
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: 200 },
    );
  });

  it("writeActiveCustomThemeToStorage 在 setItem 任一调用抛任意异常时同步返回 undefined 且不重抛", () => {
    fc.assert(
      fc.property(
        arbId,
        arbCss,
        // 抛错索引 ∈ {0,1}：在第 1 次（id）或第 2 次（css）setItem 抛错
        fc.integer({ min: 0, max: 1 }),
        arbThrown,
        (id, css, throwIndex, makeThrown) => {
          const { setItemCalls } = installMockStorage({
            setItemBehavior: (callIndex) =>
              callIndex === throwIndex ? makeThrown : undefined,
          });

          try {
            // 不重抛 + 不抛新异常：直接断言函数执行不抛
            const result = writeActiveCustomThemeToStorage(id, css);

            // 同步返回 undefined（无异步切换点）
            expect(result).toBeUndefined();

            // 实现把两次 setItem 包在同一个 try 块内：第 1 次抛错则第 2 次不再调用
            if (throwIndex === 0) {
              expect(setItemCalls).toEqual([[ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY, id]]);
            } else {
              expect(setItemCalls).toEqual([
                [ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY, id],
                [ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY, css],
              ]);
            }
          } finally {
            vi.unstubAllGlobals();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("clearActiveCustomThemeFromStorage 无错误时按 [ID_KEY, CSS_KEY] 顺序 removeItem 并返回 undefined", () => {
    const { removeItemCalls } = installMockStorage();
    try {
      const result = clearActiveCustomThemeFromStorage();

      expect(result).toBeUndefined();
      expect(removeItemCalls).toEqual([
        ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY,
        ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clearActiveCustomThemeFromStorage 在 removeItem 任一调用抛任意异常时仍返回 undefined 且第二次仍被调用", () => {
    fc.assert(
      fc.property(
        // 抛错索引 ∈ {0,1}：第 1 次（ID）或第 2 次（CSS）removeItem 抛错
        fc.integer({ min: 0, max: 1 }),
        arbThrown,
        (throwIndex, makeThrown) => {
          const { removeItemCalls } = installMockStorage({
            removeItemBehavior: (callIndex) =>
              callIndex === throwIndex ? makeThrown : undefined,
          });

          try {
            const result = clearActiveCustomThemeFromStorage();

            expect(result).toBeUndefined();
            // 实现按 ID → CSS 顺序，且每次独立 try/catch：即使首次抛错也必调用第二次
            expect(removeItemCalls).toEqual([
              ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY,
              ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY,
            ]);
          } finally {
            vi.unstubAllGlobals();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("writeCustomThemesEnabledToStorage 无错误时按 (KEY, '1' | '0') 写入并返回 undefined", () => {
    fc.assert(
      fc.property(fc.boolean(), (enabled) => {
        const { setItemCalls } = installMockStorage();
        try {
          const result = writeCustomThemesEnabledToStorage(enabled);

          expect(result).toBeUndefined();
          expect(setItemCalls).toEqual([
            [CUSTOM_THEMES_ENABLED_STORAGE_KEY, enabled ? "1" : "0"],
          ]);
        } finally {
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: 200 },
    );
  });

  it("writeCustomThemesEnabledToStorage 在 setItem 抛任意异常时同步返回 undefined 且不重抛", () => {
    fc.assert(
      fc.property(fc.boolean(), arbThrown, (enabled, makeThrown) => {
        const { setItemCalls } = installMockStorage({
          setItemBehavior: () => makeThrown,
        });

        try {
          const result = writeCustomThemesEnabledToStorage(enabled);

          expect(result).toBeUndefined();
          expect(setItemCalls).toEqual([
            [CUSTOM_THEMES_ENABLED_STORAGE_KEY, enabled ? "1" : "0"],
          ]);
        } finally {
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: 200 },
    );
  });
});
