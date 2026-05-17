import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { CSS_SIZE_LIMIT, THEME_COUNT_LIMIT, THEME_NAME_LIMIT } from "@/types/subscription";

import { byteLength, validateThemeInput } from "./custom-theme";

/**
 * Property 5: 输入校验函数与约束等价
 *
 * Validates: Requirements 2.5, 2.6, 2.7, 2.8, 3.5
 *
 * 用 fast-check 生成 (rawName, css, currentCount) 任意输入，断言：
 * - 返回 `ok` ⇔ rawName.trim().length ∈ [1, THEME_NAME_LIMIT] ∧
 *   byteLength(css) ≤ CSS_SIZE_LIMIT ∧ currentCount < THEME_COUNT_LIMIT
 * - 返回 `err` 时错误码精确对应**第一条**违反的约束（按 name → css → count 顺序）
 *
 * 生成器覆盖面（按 task 3.2 要求）：
 * - rawName：纯空白、空串、单字符、`THEME_NAME_LIMIT` 字符、超 `THEME_NAME_LIMIT` 字符；
 *   并附加完全任意字符串（含多字节字符）作为兜底分布。
 * - css：通过 `"a".repeat(n)` 把 UTF-8 字节数精确控制在 `[0, CSS_SIZE_LIMIT * 1.5]`，
 *   贴住 102400 这条边界（含略小、等于、略大、远超）；并附加任意短字符串覆盖
 *   多字节路径。
 * - currentCount：`[0, 30]`，贴住 `THEME_COUNT_LIMIT = 20` 边界。
 *
 * numRuns 选 200：约束维度 = name 5 类 × css 4 类 × count 3 类 = 60 组合，加上
 * fast-check 默认的边界采样，200 次足以覆盖每个分支与「第一条违反约束」的全部排列。
 */

// 把 ASCII space 重复 N 次，生成纯空白字符串（trim() 后长度 = 0）。
const arbWhitespace = fc.integer({ min: 0, max: 5 }).map((n) => " ".repeat(n));

// 单字符：保证 trim() 后非空。`unit: "binary-ascii"` 让 length 精确等于 1 而不会
// 被 surrogate pair 误判。
const arbSingleChar = fc.string({ minLength: 1, maxLength: 1, unit: "binary-ascii" });

// 恰好 THEME_NAME_LIMIT 个字符：trim() 后 length === 80 命中“合法上限”分支。
const arbExactLimitName = fc.string({
  minLength: THEME_NAME_LIMIT,
  maxLength: THEME_NAME_LIMIT,
  unit: "binary-ascii",
});

// 超过 THEME_NAME_LIMIT：触发 NAME_TOO_LONG 分支。
const arbOverLimitName = fc.string({
  minLength: THEME_NAME_LIMIT + 1,
  maxLength: THEME_NAME_LIMIT + 50,
  unit: "binary-ascii",
});

// 完全任意字符串：覆盖多字节字符、随机长度、奇异 Unicode 边界。
const arbAnyString = fc.string({ minLength: 0, maxLength: THEME_NAME_LIMIT * 3 });

const arbRawName = fc.oneof(
  arbWhitespace,
  fc.constant(""),
  arbSingleChar,
  arbExactLimitName,
  arbOverLimitName,
  arbAnyString,
);

// css 主分布：通过整数 → "a".repeat(n) 精确控制 UTF-8 字节数（ASCII 字节 = 字符）。
// 范围覆盖 [0, CSS_SIZE_LIMIT * 1.5]，囊括 0 / 边界 / 远超 三个区段。
const arbCssBySize = fc
  .integer({ min: 0, max: Math.floor(CSS_SIZE_LIMIT * 1.5) })
  .map((n) => "a".repeat(n));

// css 多字节兜底：短字符串但可能含多字节字符，验证 byteLength 在非 ASCII 路径
// 上仍按 UTF-8 字节数判定。
const arbCssMultiByte = fc.string({ minLength: 0, maxLength: 256 });

const arbCss = fc.oneof(arbCssBySize, arbCssMultiByte);

// currentCount：贴住 THEME_COUNT_LIMIT = 20 边界。
const arbCurrentCount = fc.integer({ min: 0, max: 30 });

describe("validateThemeInput", () => {
  it("Property 5：返回 ok ⇔ 全部约束满足；返回 err 时错误码 = 第一条违反约束（name → css → count）", () => {
    fc.assert(
      fc.property(arbRawName, arbCss, arbCurrentCount, (rawName, css, currentCount) => {
        const result = validateThemeInput(rawName, css, currentCount);

        const trimmedLength = rawName.trim().length;
        const cssBytes = byteLength(css);

        const nameEmpty = trimmedLength === 0;
        const nameTooLong = trimmedLength > THEME_NAME_LIMIT;
        const cssTooLarge = cssBytes > CSS_SIZE_LIMIT;
        const countLimit = currentCount >= THEME_COUNT_LIMIT;

        const expectedOk = !nameEmpty && !nameTooLong && !cssTooLarge && !countLimit;

        if (expectedOk) {
          expect(result).toEqual({ ok: true });
          return;
        }

        // 第一条违反的约束（顺序固定：name → css → count）
        let expectedCode: "NAME_EMPTY" | "NAME_TOO_LONG" | "CSS_TOO_LARGE" | "COUNT_LIMIT";
        if (nameEmpty) {
          expectedCode = "NAME_EMPTY";
        } else if (nameTooLong) {
          expectedCode = "NAME_TOO_LONG";
        } else if (cssTooLarge) {
          expectedCode = "CSS_TOO_LARGE";
        } else {
          expectedCode = "COUNT_LIMIT";
        }

        expect(result).toEqual({ ok: false, code: expectedCode });
      }),
      { numRuns: 200 },
    );
  });
});
