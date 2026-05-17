import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { DEFAULT_SETTINGS } from "@/types/subscription";
import {
  appSettingsSchema,
  settingsUpdateBodySchema,
} from "@/lib/api/schemas/settings";

import { normalizeSettings } from "./use-settings";

/**
 * Property 2: normalizeSettings 总是产生合法 AppSettings
 *
 * Validates: Requirements 1.9, 1.10, 1.11, 1.12
 *
 * 用 fast-check 生成任意 JSON 值（含 `null`、原始类型、缺失字段、字段类型错
 * 误）以及聚焦于本特性 3 个字段的 targeted record（合法/非法 / undefined 混
 * 合），断言两条性质：
 *
 *   (a) `normalizeSettings(input)` 输出始终通过 `appSettingsSchema.parse`。
 *
 *   (b) 字段级 default-collapse：与当前 `normalizeSettings` 的实现路径对齐
 *       —— 内部使用 `settingsUpdateBodySchema.safeParse(input)` 决定回退粒度：
 *
 *         - 若 partial parse 失败 → 整体退回 DEFAULT_SETTINGS，三个字段都
 *           等于 DEFAULT_SETTINGS 中对应值（Req 1.12 的整体回退路径）。
 *         - 若 partial parse 成功 → 仅对 `partial.data[k] === undefined`
 *           的字段使用默认值；显式提供的字段透传，但 `activeCustomThemeId`
 *           会在归一化时做悬空指针修正：当它指向不存在于最终 customThemes
 *           中的 id 时收敛为 null（Req 5.7 / 9.7 的引用完整性保证，确保输出
 *           始终通过完整 appSettingsSchema 校验，不会因 partial schema 的
 *           "仅在两字段都被提供时校验"宽容策略产生非法状态）。
 *
 * Why 200 runs: 与 design.md Property 2 + 项目内其它 PBT (schema /
 * theme-storage / merge) 维度对齐，覆盖三字段独立 + 任意 JSON 值的高维空间。
 */

// ---------- Generators ----------

/**
 * 单个字段的 targeted generator：覆盖
 *   - undefined（缺失）
 *   - null
 *   - 字符串（含空串、空白串、长串）
 *   - 数字 / 布尔（错误类型）
 *   - 数组 / 对象（错误结构）
 *   - 任意 JSON 值（兜底覆盖）
 *
 * `customThemes` 字段额外注入：合法主题数组，便于偶尔走通 (b) 的"提供合法值"
 * 透传分支。
 */
const arbAnyJson = fc.jsonValue();

const arbStringy = fc.oneof(
  fc.constant(""),
  fc.constant(" "),
  fc.constant("   "),
  fc.string({ minLength: 1, maxLength: 64 }),
  fc.string({ minLength: 65, maxLength: 200 }),
);

const arbValidThemeArr = fc.array(
  fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 40 }),
    css: fc.string({ minLength: 0, maxLength: 256 }),
    createdAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
    updatedAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  }),
  { maxLength: 3 },
);

const arbFieldValue = fc.oneof(
  { weight: 3, arbitrary: fc.constant(undefined) },
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 3, arbitrary: arbStringy },
  { weight: 1, arbitrary: fc.integer() },
  { weight: 1, arbitrary: fc.boolean() },
  { weight: 1, arbitrary: fc.array(fc.jsonValue(), { maxLength: 3 }) },
  { weight: 2, arbitrary: arbValidThemeArr },
  { weight: 2, arbitrary: arbAnyJson },
);

/**
 * Targeted object generator：每个字段独立选择是否出现 / 出现时取何值，从而
 * 覆盖以下情形：
 *
 *   - 完全缺失（{}）
 *   - 仅一个字段（如 `{ activeCustomThemeId: " " }` —— 即任务里点名的反例）
 *   - 三字段任意混合（含合法 + 非法 + null 三种 activeId 形态 × 合法 / 非法
 *     themes × 合法 / 非法 enabled）
 *   - 同时混入若干无关字段（确保 schema 不会因 `.strict()` 误拒）
 */
const arbTargetedObject = fc
  .tuple(
    fc.option(arbFieldValue, { nil: undefined }),
    fc.option(arbFieldValue, { nil: undefined }),
    fc.option(arbFieldValue, { nil: undefined }),
    fc.dictionary(fc.string(), arbAnyJson, { maxKeys: 3 }),
  )
  .map(([themesRaw, activeIdRaw, enabledRaw, extras]) => {
    const out: Record<string, unknown> = { ...extras };
    if (themesRaw !== undefined) out["customThemes"] = themesRaw;
    if (activeIdRaw !== undefined) out["activeCustomThemeId"] = activeIdRaw;
    if (enabledRaw !== undefined) out["customThemesEnabled"] = enabledRaw;
    return out;
  });

const arbInput = fc.oneof(
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: arbAnyJson },
  { weight: 6, arbitrary: arbTargetedObject },
);

// ---------- Property ----------

describe("Property 2: normalizeSettings 总是产生合法 AppSettings (Validates: Requirements 1.9, 1.10, 1.11, 1.12)", () => {
  it("(a) 输出始终通过 appSettingsSchema.parse；(b) 缺失/非法字段使用 DEFAULT_SETTINGS 中对应值，已显式提供且通过 partial 的字段透传", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const result = normalizeSettings(input);

        // (a) 输出始终是合法 AppSettings
        expect(appSettingsSchema.safeParse(result).success).toBe(true);

        // (b) 字段级 default-collapse：跟随 normalizeSettings 的两条路径
        const partial = settingsUpdateBodySchema.safeParse(input);
        if (!partial.success) {
          // 整体回退 DEFAULT_SETTINGS
          expect(result.customThemes).toEqual(DEFAULT_SETTINGS.customThemes);
          expect(result.activeCustomThemeId).toEqual(
            DEFAULT_SETTINGS.activeCustomThemeId,
          );
          expect(result.customThemesEnabled).toEqual(
            DEFAULT_SETTINGS.customThemesEnabled,
          );
        } else {
          // 仅 undefined 字段使用默认值；显式提供（含 null）的字段透传
          if (partial.data.customThemes === undefined) {
            expect(result.customThemes).toEqual(DEFAULT_SETTINGS.customThemes);
          } else {
            expect(result.customThemes).toEqual(partial.data.customThemes);
          }
          if (partial.data.activeCustomThemeId === undefined) {
            expect(result.activeCustomThemeId).toEqual(
              DEFAULT_SETTINGS.activeCustomThemeId,
            );
          } else {
            // 悬空指针修正：当 partial 提供的 activeCustomThemeId 不在最终
            // customThemes 中时，normalizeSettings 会把它收敛为 null
            // （否则输出无法通过完整 schema 校验）。
            const finalThemes = result.customThemes;
            const finalIds = new Set(finalThemes.map((theme) => theme.id));
            const provided = partial.data.activeCustomThemeId;
            if (provided === null || finalIds.has(provided)) {
              expect(result.activeCustomThemeId).toEqual(provided);
            } else {
              expect(result.activeCustomThemeId).toBeNull();
            }
          }
          if (partial.data.customThemesEnabled === undefined) {
            expect(result.customThemesEnabled).toEqual(
              DEFAULT_SETTINGS.customThemesEnabled,
            );
          } else {
            expect(result.customThemesEnabled).toEqual(
              partial.data.customThemesEnabled,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
