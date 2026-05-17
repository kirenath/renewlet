/**
 * Custom CSS Injector（自定义 CSS 注入器）。
 *
 * 本文件最终会默认导出 `<CustomCssInjector />` React 组件，由 providers
 * 在 `AppearanceSync` 之后挂载，把 Settings_Store 中激活的自定义 CSS 主题
 * 同步到 `<head>` 内的单例 `<style data-renewlet-custom-theme>` 节点。
 *
 * 当前任务仅实现底层的纯 DOM 助手 `reconcile`：保证 `<head>` 中匹配
 * `style[data-renewlet-custom-theme]` 的节点数恒为 0 或 1，且当节点存在时
 * 通过 `document.head.appendChild` 把它放在 `<head>` 的最后位置（`lastElementChild`），
 * 确保自定义 CSS 在层叠中胜出。
 *
 * Requirements: 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 7.2, 13.5
 */

const CUSTOM_THEME_ATTR = "data-renewlet-custom-theme";
const CUSTOM_THEME_SELECTOR = `style[${CUSTOM_THEME_ATTR}]`;

/**
 * 调谐 `<head>` 中的 `<style data-renewlet-custom-theme>` 节点状态，使其与
 * `target.css` 保持一致。
 *
 * 行为：
 * 1. 收齐 `<head>` 中所有匹配 `style[data-renewlet-custom-theme]` 的节点，
 *    保留首个并移除其余（去重）。
 * 2. 当 `target.css` 为空 / null / undefined 时移除剩余节点并返回（Req 6.7）。
 * 3. 否则若无现有节点则 `document.createElement('style') + setAttribute`
 *    创建一个新的标记节点（Req 13.5：用 textContent，绝不通过 innerHTML 注入）。
 * 4. 仅当当前 `textContent` 与 `target.css` 不同才赋值（Req 6.4–6.6：节点
 *    identity 复用，避免不必要的重建）。
 * 5. 通过 `document.head.appendChild(node)` 把节点放到 `<head>` 末尾，使它成为
 *    `document.head.lastElementChild`（Req 6.2）。`appendChild` 已含「先 detach
 *    再 append」语义，因此对已经在 head 中的节点会被「移到末尾」而不会重复插入。
 *
 * 函数同步执行，纯 DOM 操作，且幂等：连续两次以相同 `target` 调用产生相同结果。
 * 当 `document.head` 不存在（例如在极端环境下被外部脚本移除）时直接返回，
 * 不抛错也不创建节点。
 */
export function reconcile(target: { css: string | null }): void {
  if (typeof document === "undefined" || document.head === null) {
    return;
  }
  const head = document.head;

  // 1) 去重：保留首个节点，移除其余。
  const all = document.querySelectorAll<HTMLStyleElement>(
    CUSTOM_THEME_SELECTOR,
  );
  for (let i = 1; i < all.length; i++) {
    const extra = all[i];
    if (extra) extra.remove();
  }
  let node: HTMLStyleElement | undefined = all[0];

  const css = target.css;

  // 2) 目标为空：移除剩余节点。
  if (css === null || css === undefined || css === "") {
    if (node) node.remove();
    return;
  }

  // 3) 创建（仅当无既有节点时）。
  if (!node) {
    node = document.createElement("style");
    node.setAttribute(CUSTOM_THEME_ATTR, "");
  }

  // 4) 仅当不同才更新内容（保证节点 identity 复用）。
  if (node.textContent !== css) {
    node.textContent = css;
  }

  // 5) 确保节点位于 <head> 末尾。appendChild 内置「先移除再追加」的语义，
  // 因此对已经在 head 中但不是末尾的节点会被移到末尾，不会出现重复。
  if (node.parentNode !== head || node !== head.lastElementChild) {
    head.appendChild(node);
  }
}

import { useEffect, useMemo } from "react";
import { useSettings } from "@/hooks/use-settings";
import {
  computeEffectiveEnabled,
  reconcileStorageWithSettings,
} from "@/modules/settings/domain/custom-theme";
import {
  readActiveCustomThemeCssFromStorage,
  readActiveCustomThemeIdFromStorage,
  readCustomThemesEnabledFromStorage,
} from "@/lib/theme-storage";
import { CSS_SIZE_LIMIT } from "@/types/subscription";

/**
 * `<CustomCssInjector />`：把 Settings_Store 中激活的自定义 CSS 主题同步到
 * `<head>` 内的单例 `<style data-renewlet-custom-theme>` 节点。
 *
 * 输入来源（按优先级）：
 * 1. URL 查询参数 `?disableCustomCss=1`（Req 7.8）：命中即视为强制禁用，
 *    不读 settings/storage、不修改任何持久化值。
 * 2. `useSettings()` 数据到达后：以 `customThemesEnabled` + `activeCustomThemeId` +
 *    `customThemes[i].css` 为准（Req 12.2 / 12.3 / 8.10）。
 * 3. 数据未到达时：从 Theme_Storage 取 `id` / `css` / `enabled` 作为首屏缓存
 *    （Req 8.10 / 6.6 / 6.7）。
 *
 * DOM 不变量由底层 `reconcile` 助手保证（详见上方），本组件只负责选择 target
 * 并把 React 生命周期与 reconcile 耦合：
 * - `useEffect` 依赖 `[bypass, enabled, activeId, activeCss]`，每次输入变化触发一次
 *   reconcile（Req 5.3 / 5.4 / 5.5 / 5.6 / 7.2 / 7.3 / 7.4 / 7.5）。
 * - cleanup 同步 `reconcile({ css: null })`，使组件卸载（含 HMR）后 `<head>` 不
 *   再保留任何 `<style data-renewlet-custom-theme>` 节点（Req 6.3）。
 * - 另一个 `useEffect` 监听 `settings`：数据到达后把 Theme_Storage 三个 key 收敛
 *   到与 settings 一致（Req 8.10 / 12.2 / 12.3）。
 *
 * 组件本身不渲染任何节点，返回 `null`。
 */
function CustomCssInjector(): null {
  const { data: settings } = useSettings();

  // 一次性读取 URL 旁路标志：依赖空数组 + SSR 守卫，避免在每次重渲染重复解析。
  const bypass = useMemo<boolean>(() => {
    if (typeof window === "undefined") return false;
    return (
      new URLSearchParams(window.location.search).get("disableCustomCss") ===
      "1"
    );
  }, []);

  // Theme_Storage 兜底值：仅当 settings 尚未到达时用于 active id/css；enabled 总是
  // 作为 computeEffectiveEnabled 的兜底输入。读取本身幂等且抛错走 false/null 路径。
  const storageEnabled = readCustomThemesEnabledFromStorage();
  const storageActiveId =
    settings === undefined ? readActiveCustomThemeIdFromStorage() : null;
  const storageActiveCss =
    settings === undefined
      ? readActiveCustomThemeCssFromStorage(CSS_SIZE_LIMIT * 2)
      : null;

  // 综合 URL 旁路 + Settings_Store + Theme_Storage 计算 enabled。
  const search =
    typeof window === "undefined" ? null : window.location.search;
  const settingsEnabled =
    settings !== undefined ? settings.customThemesEnabled : null;
  const { enabled } = computeEffectiveEnabled({
    search,
    settingsEnabled,
    storageEnabled,
  });

  // 选择当前激活主题（id + css）：bypass / 关闭 / 指针无效（含悬空）一律为 null。
  let activeId: string | null;
  let activeCss: string | null;
  if (bypass || !enabled) {
    activeId = null;
    activeCss = null;
  } else if (settings !== undefined) {
    const id = settings.activeCustomThemeId;
    if (id !== null) {
      const theme = settings.customThemes.find((t) => t.id === id);
      if (theme) {
        activeId = theme.id;
        activeCss = theme.css;
      } else {
        // 悬空指针视为未激活（Req 5.6），不抛错也不写持久化。
        activeId = null;
        activeCss = null;
      }
    } else {
      activeId = null;
      activeCss = null;
    }
  } else if (storageActiveId !== null && storageActiveCss !== null) {
    activeId = storageActiveId;
    activeCss = storageActiveCss;
  } else {
    activeId = null;
    activeCss = null;
  }

  // 把 target 同步到 DOM：cleanup 卸载时移除节点（Req 6.3）。
  useEffect(() => {
    reconcile({ css: activeCss });
    return () => {
      reconcile({ css: null });
    };
  }, [bypass, enabled, activeId, activeCss]);

  // settings 到达后把 Theme_Storage 三个 key 收敛到与 settings 一致；不发任何
  // PocketBase 写请求（Req 12.2）。
  useEffect(() => {
    if (settings !== undefined) {
      reconcileStorageWithSettings(settings);
    }
  }, [settings]);

  return null;
}

export default CustomCssInjector;
