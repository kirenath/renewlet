/**
 * 自定义 CSS 主题首屏注入逻辑（Requirements 7.8 / 8.8 / 8.11）。
 *
 * 这份文件与 `packages/client/index.html` 第二段 `<script>` IIFE **必须保持同步**：
 *
 * - `index.html` 内联脚本在 React 之前同步执行，因此**不能**通过 `import` 引入本文件
 *   （`<head>` 中的非 module `<script>` 不参与模块图，Vite 也不会把它打包进来）。
 * - 因此 `index.html` 内联脚本是“真相之源”：本文件**逐行**复刻同样的逻辑，
 *   作为一个可注入测试依赖（search / localStorage / document）的纯函数版本，
 *   让单元测试无需用 `eval` / `new Function` 即可重放整段行为。
 *
 * 任何对 IIFE 的修改都必须同时更新本文件并跑 `boot-iife.test.ts`，反之亦然。
 *
 * 行为说明（与 IIFE 完全一致）：
 *
 * 1. URL 旁路 `?disableCustomCss=1`（含夹在其它参数之间的形式）→ 直接返回，
 *    不读 storage、不操作 DOM、不修改任何持久化值（Req 7.8）。
 * 2. 总闸 `renewlet_custom_themes_enabled` 严格等于 `'0'` → 直接返回；
 *    其它值（缺失 / 空字符串 / `'1'` / 任何字符串）一律视为启用（Req 8.3）。
 * 3. 激活 CSS 文本 `renewlet_active_custom_theme_css` 缺失或为空字符串 → 返回（Req 8.2）。
 * 4. 损坏检测：`css.length > 204800`（CSS_Size_Limit × 2 字符近似 UTF-8 字节上限）
 *    → 同步 `removeItem` 掉 CSS + ID 两个 key，不注入（Req 8.11）。
 * 5. 正常路径：创建 `<style data-renewlet-custom-theme>`，`textContent = css`，
 *    `appendChild` 到 `<head>` 末尾（Req 6.2 / 8.8）。
 * 6. 全部分支整段包 `try/catch` 静默吞错（包括 storage 抛 `SecurityError`、
 *    `document.head` 为 null 等），保证启动脚本永不阻断其它代码。
 */

const ENABLED_KEY = "renewlet_custom_themes_enabled";
const CSS_KEY = "renewlet_active_custom_theme_css";
const ID_KEY = "renewlet_active_custom_theme_id";

/** `css.length > CSS_LENGTH_LIMIT` 即视为损坏；与 IIFE 中的 `204800` 字符常量保持一致。 */
const CSS_LENGTH_LIMIT = 204_800;

/** `(^|[?&])disableCustomCss=1(&|$)` —— 与 IIFE 中的字面量完全相同，用于匹配 URL 旁路。 */
const BYPASS_REGEX = /(^|[?&])disableCustomCss=1(&|$)/;

/**
 * 显式注入用的依赖。所有字段都是可选：缺省时会回退到 `window.location.search`
 * / 全局 `localStorage` / 全局 `document`，与 `index.html` 内联脚本的运行环境
 * 保持等价。测试通过传入这三个字段实现完全隔离的环境替换。
 */
export interface RunCustomThemeBootIifeArgs {
  /** 形如 `?foo=1&disableCustomCss=1` 的查询字符串；默认读 `window.location.search`。 */
  search?: string;
  /** localStorage 实例；默认为全局 `localStorage`。 */
  localStorage?: Storage;
  /** Document 实例；默认为全局 `document`。 */
  document?: Document;
}

/**
 * 重放 `index.html` 中自定义 CSS 主题首屏注入 IIFE 的同步逻辑。
 *
 * 此函数的存在**仅**为了让单元测试用依赖注入替换 search / storage / document
 * 来逐场景验证 IIFE 行为；生产环境的真正注入仍由 `index.html` 中的内联
 * `<script>` 在 React 加载前同步执行（不要在应用代码里调用本函数）。
 */
export function runCustomThemeBootIife(args: RunCustomThemeBootIifeArgs = {}): void {
  // 默认值在函数体内解析，避免在模块顶层访问 `window` / `localStorage` / `document`
  // 时触发 SSR / Node 环境下的 ReferenceError（虽然客户端目前不走 SSR，但保留韧性）。
  const search = args.search ?? (typeof window !== "undefined" ? window.location.search : "");
  const storage = args.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  const doc = args.document ?? (typeof document !== "undefined" ? document : undefined);

  // 没有 storage 或 document 就直接返回（Node 单元测试在没有 jsdom 时会落到这里）。
  if (!storage || !doc) return;

  try {
    // 1) URL 旁路（Req 7.8）：命中后直接返回，不修改 storage、不操作 DOM。
    if (BYPASS_REGEX.test(search ?? "")) return;

    // 2) 总闸（Req 8.3）：严格 '0' 视为禁用，其它一律启用。
    const enabledRaw = storage.getItem(ENABLED_KEY);
    if (enabledRaw === "0") return;

    // 3) 激活 CSS 文本（Req 8.2）：空 / 缺失 → 不注入。
    const css = storage.getItem(CSS_KEY);
    if (!css) return;

    // 4) 损坏检测（Req 8.11）：超长视为脏数据，同步清掉 CSS + ID，分别 try/catch。
    if (css.length > CSS_LENGTH_LIMIT) {
      try {
        storage.removeItem(CSS_KEY);
      } catch {
        /* ignore */
      }
      try {
        storage.removeItem(ID_KEY);
      } catch {
        /* ignore */
      }
      return;
    }

    // 5) 注入路径（Req 6.2 / 8.8）：唯一 `<style data-renewlet-custom-theme>` 在 `<head>` 末尾。
    // `doc.head` 在极端情形下可能为 null（解析尚未到 `<head>` / 空 document），
    // 这种情况下 IIFE 会在 `appendChild` 处抛错并被外层 catch 吞掉；
    // 这里显式检查可以避免抛错路径，行为等价（都不注入、都不抛）。
    const head = doc.head;
    if (!head) return;

    const style = doc.createElement("style");
    style.setAttribute("data-renewlet-custom-theme", "");
    style.textContent = css;
    head.appendChild(style);
  } catch {
    /* ignore —— 与 IIFE 一致：Storage 抛 SecurityError / document 损坏等都静默吞掉 */
  }
}
