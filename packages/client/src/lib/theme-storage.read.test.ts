import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { CSS_SIZE_LIMIT } from "@/types/subscription";

import {
  ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY,
  ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY,
  CUSTOM_THEMES_ENABLED_STORAGE_KEY,
  readActiveCustomThemeCssFromStorage,
  readActiveCustomThemeIdFromStorage,
  readCustomThemesEnabledFromStorage,
} from "./theme-storage";

/**
 * Property 14: Theme_Storage 读取映射
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.9, 8.11
 *
 * 用 fast-check 生成 storage 三个 key 的任意值（含 null、''、随机字符串、超过
 * CSS_SIZE_LIMIT * 2 字节的字符串）以及一个会随机抛 DOMException 的 mock storage，
 * 断言三个 read 函数的返回值与 design.md Property 14 中规则完全一致：
 *
 * - readActiveCustomThemeIdFromStorage：null / '' / getItem 抛错 → null；否则原样
 * - readCustomThemesEnabledFromStorage：'0' → false；其它（含 null / '' / 任意字符串 / 抛错）→ true
 * - readActiveCustomThemeCssFromStorage(maxBytes)：
 *     null / '' / getItem 抛错 → null；
 *     UTF-8 字节长度 > maxBytes → null 且 ID + CSS 两个 key 在调用后被 removeItem；
 *     否则原样
 *
 * 每次 iteration 通过 Object.defineProperty(globalThis, 'localStorage', ...) 即时
 * 装入 mock storage，断言后再恢复原 localStorage，避免污染其它测试。
 *
 * numRuns 选 200：fast-check 默认 100 已能覆盖三类 read × {null / '' / 字符串 /
 * 抛错} × {单/双 removeItem 抛错} 的笛卡尔积；提到 200 是为 css 路径上的
 * "byteLength 临界值 ↔ removeItem 抛错索引" 留更密的采样，与 write 侧 Property 15
 * 同 numRuns 维度对齐。
 */

// 各种可能从 storage 抛出的异常形态：标准 DOMException 子类、Error 子类、自定义
// Error，以及非 Error 值（throw 接受任意值）。
const arbThrown = fc.oneof(
  fc.constant(() => new DOMException("quota exceeded", "QuotaExceededError")),
  fc.constant(() => new DOMException("security", "SecurityError")),
  fc.constant(() => new DOMException("invalid state", "InvalidStateError")),
  fc.constant(() => new DOMException("generic")),
  fc.constant(() => new Error("custom error")),
  fc.constant(() => new TypeError("type error")),
  fc.constant(() => new RangeError("range error")),
);

interface MockStorageOptions {
  /** 各 key 在 mock 中的初始值；缺失键返回 null。 */
  store?: Record<string, string>;
  /** 调用 getItem(key) 时是否抛错。 */
  throwOnGetItem?: Set<string>;
  /** 调用 removeItem(key) 时是否抛错。 */
  throwOnRemoveItem?: Set<string>;
  /** 抛错时要抛的值。 */
  thrown?: () => unknown;
}

interface MockStorageRecord {
  storage: Storage;
  /** 观测到的 getItem 调用顺序（key 序列）。 */
  getCalls: string[];
  /** 观测到的 removeItem 调用顺序（key 序列）。 */
  removeCalls: string[];
  /** 观测到的 setItem 调用顺序（[key, value] 序列）。 */
  setCalls: Array<[string, string]>;
}

function buildMockStorage(opts: MockStorageOptions): MockStorageRecord {
  const { store = {}, throwOnGetItem, throwOnRemoveItem, thrown } = opts;
  const internal = new Map<string, string>(Object.entries(store));
  const getCalls: string[] = [];
  const removeCalls: string[] = [];
  const setCalls: Array<[string, string]> = [];

  const storage: Storage = {
    get length() {
      return internal.size;
    },
    clear: () => {
      internal.clear();
    },
    getItem: (key: string) => {
      getCalls.push(key);
      if (throwOnGetItem?.has(key)) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw thrown ? thrown() : new DOMException("getItem failed");
      }
      return internal.get(key) ?? null;
    },
    key: (index: number) => Array.from(internal.keys())[index] ?? null,
    removeItem: (key: string) => {
      removeCalls.push(key);
      if (throwOnRemoveItem?.has(key)) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw thrown ? thrown() : new DOMException("removeItem failed");
      }
      internal.delete(key);
    },
    setItem: (key: string, value: string) => {
      setCalls.push([key, value]);
      internal.set(key, value);
    },
  };

  return { storage, getCalls, removeCalls, setCalls };
}

/** 把 globalThis.localStorage 临时换成 mock，运行 fn 后恢复，无论是否抛错。 */
function withMockStorage<T>(mock: Storage, fn: () => T): T {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 任意字符串值（含含特殊字符 / Unicode），用于 storage value 生成。 */
const arbAnyString = fc.string({ minLength: 0, maxLength: 1024 });

/** storage value 形态：null / 空串 / 任意字符串。 */
const arbStorageValue = fc.oneof(
  fc.constant<null>(null),
  fc.constant<string>(""),
  arbAnyString,
);

afterEach(() => {
  // 双保险：万一 withMockStorage finally 之外的路径漏了恢复，setup.ts 的 afterEach
  // 也会再 ensureStorage；这里显式 vi.unstubAllGlobals 保持环境干净。
  vi.unstubAllGlobals();
});

describe("Property 14: theme-storage 读取映射 (Validates: Requirements 8.1, 8.2, 8.3, 8.9, 8.11)", () => {
  it("readActiveCustomThemeIdFromStorage：null / '' / getItem 抛错 → null；否则原样返回字符串", () => {
    fc.assert(
      fc.property(arbStorageValue, fc.boolean(), arbThrown, (raw, shouldThrow, makeThrown) => {
        const store: Record<string, string> = {};
        if (raw !== null) store[ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY] = raw;

        const mock = buildMockStorage({
          store,
          throwOnGetItem: shouldThrow
            ? new Set([ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY])
            : undefined,
          thrown: makeThrown,
        });

        const result = withMockStorage(mock.storage, () =>
          readActiveCustomThemeIdFromStorage(),
        );

        // 期望：抛错 → null；null / '' → null；否则原样
        const expected = shouldThrow || raw === null || raw === "" ? null : raw;
        expect(result).toBe(expected);

        // 不应进行任何写入或删除（id 读取路径）
        expect(mock.setCalls).toEqual([]);
        expect(mock.removeCalls).toEqual([]);
        // getItem 至少被调用一次，且只针对 ID_KEY
        expect(mock.getCalls).toEqual([ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY]);
      }),
      { numRuns: 200 },
    );
  });

  it("readCustomThemesEnabledFromStorage：'0' → false；其它（含 null / '' / 任意字符串 / 抛错）→ true", () => {
    // enabled 读取的 raw 值需要覆盖 '0' 的特定字符串以及空串、任意其它字符串
    const arbEnabledRaw = fc.oneof(
      fc.constant<null>(null),
      fc.constant<string>(""),
      fc.constant<string>("0"),
      fc.constant<string>("1"),
      // 任意字符串（包含可能误命中 '0' 的形态，由 fast-check 自由探索）
      arbAnyString,
    );

    fc.assert(
      fc.property(arbEnabledRaw, fc.boolean(), arbThrown, (raw, shouldThrow, makeThrown) => {
        const store: Record<string, string> = {};
        if (raw !== null) store[CUSTOM_THEMES_ENABLED_STORAGE_KEY] = raw;

        const mock = buildMockStorage({
          store,
          throwOnGetItem: shouldThrow
            ? new Set([CUSTOM_THEMES_ENABLED_STORAGE_KEY])
            : undefined,
          thrown: makeThrown,
        });

        const result = withMockStorage(mock.storage, () =>
          readCustomThemesEnabledFromStorage(),
        );

        // 期望：抛错 → true（容错）；raw === '0' → false；其它（含 null / '' / 任何非 '0' 字符串）→ true
        const expected = shouldThrow ? true : raw !== "0";
        expect(result).toBe(expected);

        expect(mock.setCalls).toEqual([]);
        expect(mock.removeCalls).toEqual([]);
        expect(mock.getCalls).toEqual([CUSTOM_THEMES_ENABLED_STORAGE_KEY]);
      }),
      { numRuns: 200 },
    );
  });

  it("readActiveCustomThemeCssFromStorage(maxBytes)：null / '' / 抛错 → null；体积超限 → null + 删除两个 key；否则原样", () => {
    // 用较小的 maxBytes 区间，让 fast-check 容易在小字符串上触发 byteLength 超限分支。
    // 真实场景中调用方传 CSS_SIZE_LIMIT * 2 = 204800 字节；该常数边界由下一个 it 单独覆盖。
    const arbMaxBytes = fc.integer({ min: 0, max: 64 });

    // css value：null / 空 / 任意短串 / 含多字节字符 / 接近边界长度
    const arbCssRaw = fc.oneof(
      fc.constant<null>(null),
      fc.constant<string>(""),
      fc.string({ minLength: 0, maxLength: 256 }),
      // ASCII 字节序，可精准控制 byteLength 与 maxBytes 的相对位置
      fc.string({ minLength: 0, maxLength: 256, unit: "binary-ascii" }),
    );

    fc.assert(
      fc.property(
        arbCssRaw,
        arbMaxBytes,
        fc.boolean(),
        // 是否在 ID removeItem 上抛错
        fc.boolean(),
        // 是否在 CSS removeItem 上抛错
        fc.boolean(),
        arbThrown,
        (raw, maxBytes, shouldThrowOnGet, throwOnRemoveId, throwOnRemoveCss, makeThrown) => {
          const store: Record<string, string> = {};
          if (raw !== null) store[ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY] = raw;

          const throwOnRemoveItem = new Set<string>();
          if (throwOnRemoveId) throwOnRemoveItem.add(ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY);
          if (throwOnRemoveCss) throwOnRemoveItem.add(ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY);

          const mock = buildMockStorage({
            store,
            throwOnGetItem: shouldThrowOnGet
              ? new Set([ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY])
              : undefined,
            throwOnRemoveItem: throwOnRemoveItem.size > 0 ? throwOnRemoveItem : undefined,
            thrown: makeThrown,
          });

          const result = withMockStorage(mock.storage, () =>
            readActiveCustomThemeCssFromStorage(maxBytes),
          );

          if (shouldThrowOnGet) {
            // 抛错 → null，且不应进行任何 removeItem
            expect(result).toBeNull();
            expect(mock.removeCalls).toEqual([]);
          } else if (raw === null || raw === "") {
            // null / '' → null，不应进行任何 removeItem
            expect(result).toBeNull();
            expect(mock.removeCalls).toEqual([]);
          } else if (utf8ByteLength(raw) > maxBytes) {
            // 体积超限 → null + 调用顺序为 [ID_KEY, CSS_KEY]
            expect(result).toBeNull();
            expect(mock.removeCalls).toEqual([
              ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY,
              ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY,
            ]);
          } else {
            // 体积合法 → 原样返回，不应触发 removeItem
            expect(result).toBe(raw);
            expect(mock.removeCalls).toEqual([]);
          }

          // 该函数从不写入
          expect(mock.setCalls).toEqual([]);
          // 始终先且仅一次 getItem(CSS_KEY)
          expect(mock.getCalls).toEqual([ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("readActiveCustomThemeCssFromStorage(CSS_SIZE_LIMIT * 2)：在真实边界字节阈值上同样满足 Req 8.11", () => {
    const maxBytes = CSS_SIZE_LIMIT * 2; // 204800

    // 边界 1：恰好 maxBytes 个字节 → 合法，原样返回
    const onLimit = "a".repeat(maxBytes);
    {
      const mock = buildMockStorage({
        store: { [ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY]: onLimit },
      });
      const result = withMockStorage(mock.storage, () =>
        readActiveCustomThemeCssFromStorage(maxBytes),
      );
      expect(result).toBe(onLimit);
      expect(mock.removeCalls).toEqual([]);
    }

    // 边界 2：maxBytes + 1 个字节 → 视为损坏，返回 null 并清掉 ID + CSS 两个 key
    const overLimit = "a".repeat(maxBytes + 1);
    {
      const mock = buildMockStorage({
        store: { [ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY]: overLimit },
      });
      const result = withMockStorage(mock.storage, () =>
        readActiveCustomThemeCssFromStorage(maxBytes),
      );
      expect(result).toBeNull();
      expect(mock.removeCalls).toEqual([
        ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY,
        ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY,
      ]);
    }

    // 边界 3：远超 maxBytes，且 removeItem 在两个 key 上都抛错 → 仍返回 null，不重抛
    const overLimitFar = "a".repeat(maxBytes + 4096);
    {
      const mock = buildMockStorage({
        store: { [ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY]: overLimitFar },
        throwOnRemoveItem: new Set([
          ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY,
          ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY,
        ]),
        thrown: () => new DOMException("removeItem failed", "InvalidStateError"),
      });
      const result = withMockStorage(mock.storage, () =>
        readActiveCustomThemeCssFromStorage(maxBytes),
      );
      expect(result).toBeNull();
      // 即使第一次 removeItem 抛错，第二次仍被调用
      expect(mock.removeCalls).toEqual([
        ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY,
        ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY,
      ]);
    }
  });
});
