import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import { reconcile } from "./custom-css-injector";

/**
 * Property 10: CSS 注入 DOM 不变量（核心）
 *
 * Validates: Requirements 4.3, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.6, 6.7, 7.2, 7.3, 7.4, 7.5
 *
 * 用 fast-check 生成 arbHeadState（含 0..5 个预先存在的标记节点 + 0..3 个其他
 * <style> + 0..3 个 <link rel="stylesheet">，并随机交错顺序）和
 * arbTarget（{ css: string | null }，覆盖 null / '' / 任意非空字符串），
 * 在每次 iteration 之前重建 <head>，调用 reconcile 后断言以下不变量：
 *
 * 1. 节点数 ∈ {0, 1}（Req 6.1）。
 * 2. 当 shouldInject(target)（即 css !== null && css !== ''）为真时：
 *    - 唯一节点 textContent === css（Req 6.4–6.5）；
 *    - 节点是 <head> 中所有 <style> / <link rel="stylesheet"> 中 DOM 顺序最后的一个
 *      （Req 6.2，让自定义 CSS 在层叠中胜出）；
 *    - 节点是 head.lastElementChild（位置定锚，Req 6.2 的更强形式）。
 * 3. 幂等：连续两次 reconcile 后 head.innerHTML 与节点数完全一致（Req 6.6 的语义基础）。
 * 4. 节点 identity：css 非空时连续两次 reconcile 之间唯一节点 Node 引用保持相同
 *    （Req 6.6 节点复用，避免不必要的重建/闪烁）。
 *
 * numRuns 选 200：design.md 第 8 节将本属性标记为「核心」；200 runs 在
 * {0..5 markers × 0..3 styles × 0..3 links × 排列} × {3 类 css} 笛卡尔积上提供更密
 * 采样，与 spec 中本任务 (5.4) 的 ≥ 200 runs 要求一致。
 */

const ATTR = "data-renewlet-custom-theme";
const MARKER_SELECTOR = `style[${ATTR}]`;
const STYLESHEET_SELECTOR = `style, link[rel="stylesheet"]`;

type HeadEntry =
  | { kind: "marker"; text: string }
  | { kind: "style"; text: string }
  | { kind: "link"; href: string };

/**
 * 构造任意 head 状态：
 * - markers：0..5 个 `<style data-renewlet-custom-theme>`（模拟启动 IIFE 已注入
 *   的标记节点，或之前 reconcile 留下的节点；可能不止一个，验证去重路径）；
 * - styles：0..3 个不带标记的 `<style>`（模拟其它注入器/Vite HMR 等产生的节点）；
 * - links：0..3 个 `<link rel="stylesheet">`（模拟外部样式表 link）；
 * - 三类节点在 head 中以随机顺序交错插入。
 */
const arbHeadState: fc.Arbitrary<HeadEntry[]> = fc
  .tuple(
    fc.array(fc.string({ maxLength: 32 }), { minLength: 0, maxLength: 5 }),
    fc.array(fc.string({ maxLength: 32 }), { minLength: 0, maxLength: 3 }),
    fc.array(fc.string({ minLength: 1, maxLength: 16 }), {
      minLength: 0,
      maxLength: 3,
    }),
  )
  .chain(([markerTexts, styleTexts, linkHrefs]) => {
    const entries: HeadEntry[] = [
      ...markerTexts.map((text) => ({ kind: "marker" as const, text })),
      ...styleTexts.map((text) => ({ kind: "style" as const, text })),
      ...linkHrefs.map((href) => ({ kind: "link" as const, href })),
    ];
    if (entries.length === 0) {
      return fc.constant<HeadEntry[]>([]);
    }
    // 通过 shuffledSubarray（取全长）得到任意排列，覆盖三类节点的相对顺序。
    return fc.shuffledSubarray(entries, {
      minLength: entries.length,
      maxLength: entries.length,
    });
  });

/**
 * 任意 target.css：null / '' / 任意非空字符串三类同等重要——前两类对应不注入分支，
 * 后者对应注入分支，权重略偏注入分支以让正向断言（textContent / 位置 / identity）
 * 获得更多采样。
 */
const arbTarget = fc.record<{ css: string | null }>({
  css: fc.oneof(
    { weight: 1, arbitrary: fc.constant<string | null>(null) },
    { weight: 1, arbitrary: fc.constant<string | null>("") },
    {
      weight: 4,
      arbitrary: fc.string({ minLength: 1, maxLength: 256 }),
    },
  ),
});

/** 在每次 iteration 之前清空 head 并按生成的 entries 重建之。 */
function rebuildHead(entries: HeadEntry[]): void {
  // 清空 head 中所有子节点（包括非元素节点），避免上一次 iteration 残留状态。
  while (document.head.firstChild) {
    document.head.removeChild(document.head.firstChild);
  }
  for (const entry of entries) {
    if (entry.kind === "marker") {
      const node = document.createElement("style");
      node.setAttribute(ATTR, "");
      node.textContent = entry.text;
      document.head.appendChild(node);
    } else if (entry.kind === "style") {
      const node = document.createElement("style");
      node.textContent = entry.text;
      document.head.appendChild(node);
    } else {
      const node = document.createElement("link");
      node.setAttribute("rel", "stylesheet");
      node.setAttribute("href", entry.href);
      document.head.appendChild(node);
    }
  }
}

/**
 * 给定一个不变量列表，遍历断言；任一失败时立即抛出，让 fast-check 捕获并 shrink。
 * 返回 true 让 property runner 视为通过。
 */
function assertInvariants(
  target: { css: string | null },
  preReconcileEntries: HeadEntry[],
): true {
  const shouldInject = target.css !== null && target.css !== "";

  // 1) 节点数 ∈ {0, 1}（用 document.querySelectorAll 与 reconcile 的实现选择一致）。
  const markersAfter = document.querySelectorAll(MARKER_SELECTOR);
  expect(markersAfter.length).toBeLessThanOrEqual(1);

  if (shouldInject) {
    // 2a) 注入路径：恰好 1 个；textContent === css。
    expect(markersAfter.length).toBe(1);
    const sole = markersAfter[0]!;
    expect(sole.textContent).toBe(target.css);

    // 2b) 节点是 head 中所有 stylesheet 节点的最后一个。
    const stylesheets = document.head.querySelectorAll(STYLESHEET_SELECTOR);
    expect(stylesheets.length).toBeGreaterThanOrEqual(1);
    expect(stylesheets[stylesheets.length - 1]).toBe(sole);

    // 2c) 节点是 head.lastElementChild。我们只往 head 中放 style/link，没有任何
    // 其它 element，所以最后一个 element child 必然是它。
    expect(document.head.lastElementChild).toBe(sole);
  } else {
    // 不注入路径：所有标记节点应当被清除（包括预先存在的多个 marker）。
    expect(markersAfter.length).toBe(0);
    // 任何最初存在的 marker 都不应再留在 head 中。
    const markersInHead = document.head.querySelectorAll(MARKER_SELECTOR);
    expect(markersInHead.length).toBe(0);
  }

  // 3) 幂等：再次 reconcile 不应改变 head 状态。
  const innerHtmlBefore = document.head.innerHTML;
  const childCountBefore = document.head.children.length;
  const refBefore = document.querySelector(MARKER_SELECTOR);
  reconcile(target);
  const innerHtmlAfter = document.head.innerHTML;
  const childCountAfter = document.head.children.length;
  const refAfter = document.querySelector(MARKER_SELECTOR);
  expect(innerHtmlAfter).toBe(innerHtmlBefore);
  expect(childCountAfter).toBe(childCountBefore);

  // 4) 节点 identity：css 非空时第一次与第二次 reconcile 之间引用必须保持同一。
  if (shouldInject) {
    expect(refBefore).not.toBeNull();
    expect(refAfter).toBe(refBefore);
  } else {
    expect(refBefore).toBeNull();
    expect(refAfter).toBeNull();
  }

  // 静默使用 preReconcileEntries 的形参，方便日后扩展更细的断言（例如对照
  // 初始 link href 是否仍然存在）。当前 numRuns 已足够覆盖这些 case 的反向证明。
  void preReconcileEntries;
  return true;
}

describe("reconcile DOM invariants (Property 10)", () => {
  afterEach(() => {
    // 清理 head，避免 property test 残留节点污染其它测试。
    while (document.head.firstChild) {
      document.head.removeChild(document.head.firstChild);
    }
  });

  it("满足节点数 ∈ {0,1} / 位置 / 幂等 / 节点 identity 复用", () => {
    fc.assert(
      fc.property(arbHeadState, arbTarget, (entries, target) => {
        rebuildHead(entries);
        reconcile(target);
        return assertInvariants(target, entries);
      }),
      { numRuns: 200 },
    );
  });
});
