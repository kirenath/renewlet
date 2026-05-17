import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_SETTINGS,
  NOTIFICATION_CHANNELS,
  type AppSettings,
  type CustomCssTheme,
} from "@/types/subscription";
import { THEME_MODES, THEME_VARIANTS } from "@/types/theme";
import { SUPPORTED_LOCALES } from "@/i18n/locales";
import type { LocalTime } from "@/lib/time/local-time";

import { normalizeSettings } from "./use-settings";

/**
 * Property 3: 设置合并保留所有未触及字段
 *
 * Validates: Requirements 1.13, 9.2
 *
 * 用 fast-check 生成合法 `current: AppSettings` 与任意 `Partial<AppSettings>`
 * `patch`（其中已提供字段一律为合法值），断言
 * `normalizeSettings({ ...current, ...patch })`：
 *
 *   (a) 对 patch 中显式提供（非 undefined）的每个 key k：result[k] === patch[k]
 *   (b) 对 patch 中缺失或 undefined 的每个 key k：result[k] === current[k]
 *
 * Why 200 runs：与 design.md Property 3 + 项目内其它 PBT（schema/normalize/
 * theme-storage）维度对齐，确保 38 个字段交叉的"包含/缺失"组合被密集采样。
 *
 * 关键约束（不与 use-settings.ts 当前实现冲突的前提下，把测试可重复跑通）：
 *
 *  - 待合并对象必须通过 `settingsUpdateBodySchema`，否则 `normalizeSettings`
 *    整体退回 DEFAULT_SETTINGS，性质 (a)/(b) 都不成立。本测试的 current 与
 *    patch 各字段均使用按 schema 收紧后的 generator，保证合并后整体合法。
 *
 *  - 自定义主题三字段（customThemes / activeCustomThemeId /
 *    customThemesEnabled）受 `superRefine` 引用完整性约束。本测试把它们当作
 *    一个不可分割三元组：要么 patch 同时提供三者（且 activeId 一致），要么
 *    三者均不出现在 patch 中——避免误把 current 的 activeId 与 patch 的新
 *    themes 拼接出悬空指针。
 *
 *  - 受 schema `.trim()` 转换的字符串字段（adminUsername、telegram*、smtp*
 *    等）只生成"无前后空白"的 ASCII 字符串，确保 schema parse 不会改写值，
 *    从而 (a) `result[k] === patch[k]` 严格成立。
 *
 *  - `webhookHeaders` / `webhookPayload` 受 `clearLegacyWebhookExample` 后
 *    处理（碰到旧示例占位符会被改写为 ""）。本属性测试**不**覆盖这两个字段；
 *    它们的占位符替换由 use-settings.test.ts 的示例测试单独验证。current /
 *    patch 都不显式提供这两个字段，所以最终值始终等于 DEFAULT_SETTINGS 中
 *    的 ""，性质 (b) 平凡成立。
 */

// ---------- 字符 / 时间 / 颜色 等基础 generator ----------

const ALNUM_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";

/** 仅由字母数字与少量符号构成的字符串；length ∈ [0, max]。无前后空白。 */
const arbAlnum = (max: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...ALNUM_CHARS.split("")), { maxLength: max })
    .map((arr) => arr.join(""));

/** 同上但保证非空（length ∈ [1, max]）。 */
const arbAlnumNonEmpty = (max: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...ALNUM_CHARS.split("")), { minLength: 1, maxLength: max })
    .map((arr) => arr.join(""));

const arbHHmm: fc.Arbitrary<LocalTime> = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(
    ([h, m]) =>
      `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` as LocalTime,
  );

const arbColor = fc.record({
  h: fc.integer({ min: 0, max: 360 }),
  s: fc.integer({ min: 0, max: 100 }),
  l: fc.integer({ min: 0, max: 100 }),
});

const arbCurrency = fc.constantFrom(
  "CNY",
  "USD",
  "EUR",
  "JPY",
  "GBP",
  "HKD",
  "AUD",
  "CAD",
  "SGD",
  "CHF",
);

// 一组 IANA timezone，确保在所有运行时（包括 CI 上的 jsdom + Node）都被识别。
const arbTimezone = fc.constantFrom(
  "UTC",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Pacific/Auckland",
);

// CSS 内容用 ASCII，长度 ≤ 256 字节，远低于 CSS_SIZE_LIMIT；createdAt /
// updatedAt 写常量，不影响"合并保留"语义。
const arbValidTheme: fc.Arbitrary<CustomCssTheme> = fc.record({
  id: fc.uuid(),
  name: arbAlnumNonEmpty(40),
  css: arbAlnum(256),
  createdAt: fc.constant("2024-01-01T00:00:00.000Z"),
  updatedAt: fc.constant("2024-06-15T12:34:56.789Z"),
});

// ---------- Custom theme 三字段三元组（一致性已自洽） ----------

interface CustomTriplet {
  customThemes: CustomCssTheme[];
  activeCustomThemeId: string | null;
  customThemesEnabled: boolean;
}

const arbCustomTriplet: fc.Arbitrary<CustomTriplet> = fc
  .tuple(
    fc.array(arbValidTheme, { maxLength: 3 }),
    fc.boolean(),
    fc.boolean(),
  )
  .map(([themes, activate, enabled]) => ({
    customThemes: themes,
    activeCustomThemeId: activate && themes.length > 0 ? themes[0]!.id : null,
    customThemesEnabled: enabled,
  }));

// ---------- 字段 metadata：每个字段独立 generator ----------
//
// 排除：
//  - customThemes / activeCustomThemeId / customThemesEnabled：用上面 triplet
//  - webhookHeaders / webhookPayload：受 clearLegacyWebhookExample 后处理

interface FieldSpec {
  key: keyof AppSettings;
  arb: fc.Arbitrary<unknown>;
}

const SCALAR_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: "adminUsername", arb: arbAlnumNonEmpty(80) },
  { key: "themeMode", arb: fc.constantFrom(...THEME_MODES) },
  { key: "themeVariant", arb: fc.constantFrom(...THEME_VARIANTS) },
  { key: "themeCustomColor", arb: arbColor },
  { key: "locale", arb: fc.constantFrom(...SUPPORTED_LOCALES) },
  { key: "showExpired", arb: fc.boolean() },
  { key: "defaultCurrency", arb: arbCurrency },
  { key: "exchangeRateProvider", arb: fc.constantFrom("frankfurter", "floatrates") },
  {
    key: "monthlyBudget",
    arb: fc
      .double({ min: 0, max: 1_000_000, noNaN: true })
      .filter((n) => Number.isFinite(n)),
  },
  { key: "timezone", arb: arbTimezone },
  { key: "notificationTimeLocal", arb: arbHHmm },
  { key: "enabledChannels", arb: fc.subarray([...NOTIFICATION_CHANNELS]) },
  { key: "testPhone", arb: arbAlnum(80) },
  { key: "telegramBotToken", arb: arbAlnum(120) },
  { key: "telegramChatId", arb: arbAlnum(80) },
  { key: "notifyxApiKey", arb: arbAlnum(120) },
  {
    key: "webhookUrl",
    arb: fc.constantFrom(
      "",
      "https://example.com/hook",
      "https://hook.test/abc",
    ),
  },
  { key: "webhookMethod", arb: fc.constantFrom("GET", "POST") },
  {
    key: "wechatWebhookUrl",
    arb: fc.constantFrom(
      "",
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
      "https://qy.test/hook",
    ),
  },
  { key: "wechatMessageType", arb: fc.constantFrom("text", "markdown") },
  { key: "wechatAddModeTag", arb: fc.boolean() },
  { key: "wechatAtPhones", arb: arbAlnum(80) },
  { key: "wechatAtAll", arb: fc.boolean() },
  { key: "smtpHost", arb: arbAlnum(80) },
  { key: "smtpPort", arb: fc.constantFrom("", "25", "465", "587", "2525") },
  { key: "smtpSecure", arb: fc.boolean() },
  { key: "smtpUser", arb: arbAlnum(80) },
  { key: "smtpPassword", arb: arbAlnum(80) },
  { key: "smtpFrom", arb: arbAlnum(80) },
  { key: "smtpReplyTo", arb: arbAlnum(80) },
  { key: "notifyMultipleAddresses", arb: fc.boolean() },
  {
    key: "recipientEmail",
    arb: fc.constantFrom("", "a@example.com", "x@y.test", "u@v.example"),
  },
  {
    key: "barkServerUrl",
    arb: fc.constantFrom("", "https://api.day.app", "https://example.com"),
  },
  { key: "barkDeviceKey", arb: arbAlnum(80) },
  { key: "barkSilentPush", arb: fc.boolean() },
];

// ---------- current / patch generators ----------

/**
 * 任意合法 AppSettings：DEFAULT_SETTINGS 基底上把每个 SCALAR_FIELDS 字段全部
 * 用 generator 覆盖，再叠加自洽的 customTriplet。
 */
const arbCurrent: fc.Arbitrary<AppSettings> = fc
  .tuple(
    ...(SCALAR_FIELDS.map((f) => f.arb) as fc.Arbitrary<unknown>[]),
    arbCustomTriplet,
  )
  .map((vals) => {
    const arr = vals as unknown[];
    const triplet = arr[arr.length - 1] as CustomTriplet;
    const overrides: Partial<AppSettings> = {};
    SCALAR_FIELDS.forEach((f, i) => {
      (overrides as Record<string, unknown>)[f.key] = arr[i];
    });
    Object.assign(overrides, triplet);
    return { ...DEFAULT_SETTINGS, ...overrides } as AppSettings;
  });

/**
 * 任意 `Partial<AppSettings>` patch：每个标量字段独立选"包含合法值"或"缺失"；
 * 三个 custom theme 字段作为不可分割三元组，either all-in or all-out（保证
 * 合并后 superRefine 引用完整性恒成立）。
 */
const arbPatch: fc.Arbitrary<Partial<AppSettings>> = fc
  .tuple(
    ...(SCALAR_FIELDS.map((f) => fc.option(f.arb, { nil: undefined })) as fc.Arbitrary<unknown>[]),
    fc.option(arbCustomTriplet, { nil: undefined }),
  )
  .map((vals) => {
    const arr = vals as unknown[];
    const triplet = arr[arr.length - 1] as CustomTriplet | undefined;
    const patch: Partial<AppSettings> = {};
    SCALAR_FIELDS.forEach((f, i) => {
      const v = arr[i];
      if (v !== undefined) (patch as Record<string, unknown>)[f.key] = v;
    });
    if (triplet !== undefined) Object.assign(patch, triplet);
    return patch;
  });

// ---------- The Property ----------

describe("Property 3: normalizeSettings 合并保留所有未触及字段 (Validates: Requirements 1.13, 9.2)", () => {
  it("patch 中显式提供的 key 覆盖 current；缺失或 undefined 的 key 维持 current 原值", () => {
    fc.assert(
      fc.property(arbCurrent, arbPatch, (current, patch) => {
        const merged = { ...current, ...patch };
        const result = normalizeSettings(merged);

        const allKeys = Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>;
        for (const k of allKeys) {
          const provided =
            Object.prototype.hasOwnProperty.call(patch, k) &&
            (patch as Record<string, unknown>)[k] !== undefined;
          const expected = provided
            ? (patch as Record<string, unknown>)[k]
            : (current as Record<string, unknown>)[k];
          expect(result[k]).toEqual(expected);
        }
      }),
      { numRuns: 200 },
    );
  });
});
