import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  CSS_SIZE_LIMIT,
  DEFAULT_SETTINGS,
  THEME_COUNT_LIMIT,
  THEME_NAME_LIMIT,
} from "@/types/subscription";

import { appSettingsSchema } from "./settings";

/**
 * Property 1: appSettingsSchema 接受当且仅当所有约束满足
 *
 * Validates: Requirements 1.2, 1.7, 1.8, 9.6, 9.7
 *
 * 用 fast-check 生成 (themes, activeId, enabled) 三元组，覆盖：
 *   - themes.length 在 [0, 30] 区间（横跨 THEME_COUNT_LIMIT=20 边界）
 *   - 每条 theme 的 name 字符长度 0..200（横跨 THEME_NAME_LIMIT=80 边界）
 *   - 每条 theme 的 css 含小串与若干"边界尺寸"（含 CSS_SIZE_LIMIT、+1、*1.5），
 *     既覆盖通过路径，也覆盖 .max() 字符粗筛与 .refine() UTF-8 字节精校的拒绝路径
 *   - 每条 theme 的 id 含空串与超过 64 字符的串
 *   - 每条 theme 的 createdAt / updatedAt 同时覆盖合法 ISO 8601 UTC 与不合法形态
 *   - activeId 在 null / 命中已有 ids / 不命中（含空串、随机串）之间随机
 *   - enabled 任意 boolean
 *
 * 用 DEFAULT_SETTINGS 作为合法基底（其他 30+ 字段已通过 schema），
 * 仅替换三个新字段，避免重复声明所有字段的合法约束。
 *
 * numRuns: 200，与 design.md Property 1 + 项目内其他 PBT（theme-storage.read /
 * theme-storage.write）的 numRuns 维度对齐。
 */

const ID_MAX_LEN = 64;

/** 合法 ISO 8601 UTC：以 Z 结尾且能被 Date.parse。 */
const arbValidIsoUtc = fc.date({ noInvalidDate: true }).map((d) => d.toISOString());

/** 不合法的时间字符串：缺 Z、非日期、空串等。 */
const arbInvalidTimestamp = fc.oneof(
  fc.constant("2024-01-01T00:00:00+00:00"),
  fc.constant("2024-01-01T00:00:00"),
  fc.constant("2024-01-01"),
  fc.constant("not-a-date"),
  fc.constant(""),
  fc.string({ minLength: 0, maxLength: 32 }),
);

const arbTimestamp = fc.oneof(
  { weight: 8, arbitrary: arbValidIsoUtc },
  { weight: 2, arbitrary: arbInvalidTimestamp },
);

/** id：空串 / 合法 1..64 / 超长 65..120，以 oneof 加权覆盖三类边界。 */
const arbId = fc.oneof(
  { weight: 1, arbitrary: fc.constant("") },
  { weight: 7, arbitrary: fc.string({ minLength: 1, maxLength: ID_MAX_LEN }) },
  { weight: 2, arbitrary: fc.string({ minLength: ID_MAX_LEN + 1, maxLength: 120 }) },
);

/** name：长度 0..200，覆盖 0、1、80、81、200 边界。 */
const arbName = fc.string({ minLength: 0, maxLength: 200 });

/**
 * css：以小串为主，叠加几个体积边界常量，以及一个多字节字符串。
 *
 * - 多字节边界：CSS_SIZE_LIMIT 个 "中" 字符（每个 UTF-8 3 字节）→ 约 307200 字节，
 *   字符长度 102400 ≤ CSS_SIZE_LIMIT * 4，能跨过 .max() 粗筛走到 refine() 拒绝路径。
 */
const arbCss = fc.oneof(
  { weight: 6, arbitrary: fc.string({ minLength: 0, maxLength: 200 }) },
  { weight: 1, arbitrary: fc.constant("") },
  { weight: 1, arbitrary: fc.constant("a".repeat(CSS_SIZE_LIMIT - 1)) },
  { weight: 1, arbitrary: fc.constant("a".repeat(CSS_SIZE_LIMIT)) },
  { weight: 1, arbitrary: fc.constant("a".repeat(CSS_SIZE_LIMIT + 1)) },
  { weight: 1, arbitrary: fc.constant("中".repeat(Math.floor(CSS_SIZE_LIMIT / 2))) },
);

const arbThemeRaw = fc.record({
  id: arbId,
  name: arbName,
  css: arbCss,
  createdAt: arbTimestamp,
  updatedAt: arbTimestamp,
});

/** themes 数组长度 0..30，覆盖 THEME_COUNT_LIMIT=20 边界。 */
const arbThemes = fc.array(arbThemeRaw, { minLength: 0, maxLength: 30 });

/**
 * activeId 选择策略：null / 命中现有某条 id / 用任意串模拟"miss"；
 * 由生成的索引/串在执行时根据 themes 推断真实 activeId。
 */
type ActiveIdPicks =
  | { mode: "null" }
  | { mode: "hit"; hitIdx: number }
  | { mode: "miss"; missStr: string };

const arbActiveIdPicks: fc.Arbitrary<ActiveIdPicks> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ mode: fc.constant("null" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({ mode: fc.constant("hit" as const), hitIdx: fc.nat({ max: 100 }) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      mode: fc.constant("miss" as const),
      missStr: fc.oneof(
        fc.constant(""),
        fc.string({ minLength: 1, maxLength: 80 }),
      ),
    }),
  },
);

function resolveActiveId(
  themes: ReadonlyArray<{ id: string }>,
  picks: ActiveIdPicks,
): string | null {
  if (picks.mode === "null") return null;
  if (picks.mode === "hit") {
    if (themes.length === 0) return null;
    return themes[picks.hitIdx % themes.length]!.id;
  }
  return picks.missStr;
}

/**
 * 与 schema 等价的逐条约束判定函数（不调用 zod，仅按 design.md 中 Property 1
 * 描述的约束清单实现），用于和 appSettingsSchema.parse 的真实结果做⇔比对。
 *
 * Caveat：本函数必须与 settings.ts 中 customCssThemeSchema / appSettingsSchema /
 * superRefine 的字段级 + 顶层级约束一一对应，任何一处偏差都会让属性测试假阳/假阴。
 */
function expectedValid(
  themes: ReadonlyArray<{
    id: string;
    name: string;
    css: string;
    createdAt: string;
    updatedAt: string;
  }>,
  activeId: string | null,
  enabled: boolean,
): boolean {
  if (typeof enabled !== "boolean") return false;
  if (themes.length > THEME_COUNT_LIMIT) return false;

  const isValidIsoUtc = (value: string): boolean =>
    /T.*Z$/.test(value) && !Number.isNaN(Date.parse(value));

  for (const t of themes) {
    if (typeof t.id !== "string" || t.id.length < 1 || t.id.length > ID_MAX_LEN) return false;
    if (typeof t.name !== "string" || t.name.length < 1 || t.name.length > THEME_NAME_LIMIT) {
      return false;
    }
    if (typeof t.css !== "string") return false;
    if (t.css.length > CSS_SIZE_LIMIT * 4) return false;
    if (new TextEncoder().encode(t.css).length > CSS_SIZE_LIMIT) return false;
    if (typeof t.createdAt !== "string" || !isValidIsoUtc(t.createdAt)) return false;
    if (typeof t.updatedAt !== "string" || !isValidIsoUtc(t.updatedAt)) return false;
  }

  if (activeId !== null) {
    if (typeof activeId !== "string") return false;
    if (activeId.length < 1 || activeId.length > ID_MAX_LEN) return false;
    const ids = new Set(themes.map((t) => t.id));
    if (!ids.has(activeId)) return false;
  }

  return true;
}

describe("Property 1: appSettingsSchema 接受当且仅当所有约束满足 (Validates: Requirements 1.2, 1.7, 1.8, 9.6, 9.7)", () => {
  it("DEFAULT_SETTINGS 合法（保证 base 三元组以外 30+ 字段已经过 schema）", () => {
    expect(appSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it("appSettingsSchema.parse 成功 ⇔ 自定义主题三字段全部约束满足", () => {
    fc.assert(
      fc.property(arbThemes, arbActiveIdPicks, fc.boolean(), (themes, picks, enabled) => {
        const activeId = resolveActiveId(themes, picks);
        const candidate = {
          ...DEFAULT_SETTINGS,
          customThemes: themes,
          activeCustomThemeId: activeId,
          customThemesEnabled: enabled,
        };

        const expected = expectedValid(themes, activeId, enabled);
        const actual = appSettingsSchema.safeParse(candidate).success;

        expect(actual).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});
