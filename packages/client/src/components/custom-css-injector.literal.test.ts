import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import { reconcile } from "./custom-css-injector";

/**
 * Property 11: CSS 文本字面量保留（无消毒）
 *
 * Validates: Requirements 6.4, 6.5, 13.1, 13.5
 *
 * 用 fast-check 生成任意非空字符串 `s`（覆盖 `<`、`>`、`&`、`</style>`、
 * `@import url("...")`、HTML 实体、emoji、surrogate pairs、lone surrogate、
 * RTL/LTR 控制字符、null 字符、纯任意 UTF-16 binary 单元等），调用
 * `reconcile({ css: s })` 后断言：
 *
 * - `<head>` 中恰好一个 `style[data-renewlet-custom-theme]` 节点；
 * - `node.textContent === s`（精确字面相等，证明未做任何转义 / 消毒 / `@import` 剥离）；
 * - `node.childNodes.length === 1` 且 `node.firstChild.nodeType === Node.TEXT_NODE`
 *   （证明通过 textContent 赋值而非 innerHTML 解析，从而 `</style>` / `<script>` 之类
 *   的字面量不会被 HTML 解析器解释为新的元素节点 / 注释节点等其它节点类型）。
 *
 * `numRuns` 选 200：本属性是 Property 10 之外另一条核心 DOM 不变量，提到 200 次
 * 与 Theme_Storage 读侧测试维度对齐，给棘手字符串与 binary 单元留充分采样。
 *
 * 排除空串：reconcile 对 `css === ''` 的语义是“不注入并移除既有节点”
 * （Req 6.7），与本属性关心的“注入分支”不同，因此用 `minLength: 1` 与
 * `constantFrom` 中也不放空串。
 */

const CUSTOM_THEME_SELECTOR = "style[data-renewlet-custom-theme]";

/**
 * 必含的棘手字面量，确保每一类被设计文档显式点名的边界都至少被一次完整覆盖。
 * fast-check 的 shrinker 会优先在这些常量上回放失败用例，便于诊断。
 */
const trickyCssLiterals: readonly string[] = [
  // —— `</style>` 闭合在 textContent 中应作为字面量保留，绝不被 HTML 解析器消化。
  "</style>",
  "</STYLE>",
  "</style >",
  "</style\n>",
  "</style\t\t>",
  // —— `<script>` 类标签：textContent 写入路径不应触发任何脚本解析。
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<!-- comment --><![CDATA[x]]>",
  // —— `@import` / `url(...)`：Req 13.1 显式声明不剥离 / 不改写。
  "@import url(\"https://evil.example.com/x.css\");",
  "@import url('relative.css');",
  "@import \"naked.css\";",
  "@import url(no-quote.css) screen and (max-width: 600px);",
  "background: url('a.png');",
  "background: url(\"data:image/png;base64,AAAA\");",
  // —— HTML 实体：textContent 写入应保留为字面量（不解码为对应字符）。
  "&amp; &lt; &gt; &quot; &apos; &nbsp;",
  "&#65; &#x41; &#x1F600;",
  "&unknown_entity_should_stay_literal;",
  // —— 多字节 / 复杂 Unicode：emoji、ZWJ 序列、surrogate pair。
  "🎨🌈🎉",
  "👨\u200D👩\u200D👧\u200D👦", // 家庭 emoji（多 ZWJ 组合）
  "\uD83D\uDE00", // 完整 surrogate pair（U+1F600 GRINNING FACE）
  // —— 单独 surrogate（lone surrogate）：浏览器与 jsdom 应保留为 16-bit 码元。
  "\uD800",
  "\uDC00",
  "lead\uD800tail",
  // —— RTL/LTR 控制字符与方向覆盖。
  "\u200E\u200F\u202A\u202B\u202C\u202D\u202E",
  ".rtl { content: \"שלום\"; direction: rtl; }",
  "/* العربية */",
  // —— 控制字符 / NUL / 换行 / 制表符。
  "\u0000",
  "line1\nline2\r\nline3\tindented",
  "\u0007\u001B[31mansi\u001B[0m",
  // —— 复合污染：在合法 CSS 中嵌入 `</style>` 字面量（最经典的“消毒”诱因）。
  "body { content: \"</style><script>x</script>\"; }",
  "/* <!-- </style> --> */",
  ".x::before { content: \"</style>\"; }",
  // —— BOM / 编码声明 / 转义反斜杠。
  "\uFEFF@charset \"UTF-8\";",
  "html { --x: \"a\\\\b\\\"c\"; }",
  // —— 单字符与极短串。
  " ",
  "\n",
  "a",
];

/**
 * 棘手常量 ∪ 任意 grapheme 字符串 ∪ 任意 UTF-16 binary 字符串。
 *
 * - `unit: "grapheme"`：覆盖完整 Unicode（含 emoji / 复合字形）正常采样路径；
 * - `unit: "binary"`：放开到任意 16-bit 码元，包含 lone surrogate、控制字符等
 *   `node.textContent = s` 路径下应当字面保留的极端值。
 */
const arbCss = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...trickyCssLiterals) },
  {
    weight: 3,
    arbitrary: fc.string({ minLength: 1, maxLength: 512, unit: "grapheme" }),
  },
  {
    weight: 3,
    arbitrary: fc.string({ minLength: 1, maxLength: 512, unit: "binary" }),
  },
);

describe("reconcile（Property 11：CSS 文本字面量保留 / 无消毒）", () => {
  afterEach(() => {
    document
      .querySelectorAll(CUSTOM_THEME_SELECTOR)
      .forEach((n) => n.remove());
  });

  it("任意非空 css 经 reconcile 后逐字保留为单一 TEXT_NODE", () => {
    fc.assert(
      fc.property(arbCss, (s) => {
        // 每次 iteration 之前清场，避免上一轮残留的标记节点干扰 querySelector。
        document
          .querySelectorAll(CUSTOM_THEME_SELECTOR)
          .forEach((n) => n.remove());

        reconcile({ css: s });

        const nodes = document.querySelectorAll<HTMLStyleElement>(
          CUSTOM_THEME_SELECTOR,
        );
        // 注入后恒为 1 个标记节点（Req 6.1 / 6.2，兜底而非主断言）。
        expect(nodes.length).toBe(1);

        const node = nodes[0]!;

        // 主断言 1：textContent 与输入 s 精确字面相等（无消毒 / 无转义 / 无 url 改写 / 无 @import 剥离）。
        expect(node.textContent).toBe(s);

        // 主断言 2：节点下恰好一个子节点，且类型为 Text（证明走的是 textContent 路径，
        // 而非 innerHTML 解析；后者会把 `</style>` 解释为闭合 + 后续元素 / 注释节点）。
        expect(node.childNodes.length).toBe(1);
        expect(node.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      }),
      { numRuns: 200 },
    );
  });
});
