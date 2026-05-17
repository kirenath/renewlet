/**
 * 主题设置的 localStorage 缓存（用于首屏快速恢复外观，减少“等待网络导致的闪动”）。
 *
 * 说明：
 * - 数据库是“最终真相”（落库后的跨设备一致性）
 * - localStorage 是“首屏缓存”（不依赖网络即可先恢复上次外观）
 *
 * 状态关系：
 * ```
 * 用户即时预览 -> localStorage + pending=1
 * 保存设置成功 -> pending 清除 -> 数据库成为跨设备来源
 * ```
 *
 * Caveat: 所有读取函数都必须容错，localStorage 可能不可用或被用户手动写入脏数据。
 */

import {
  DEFAULT_CUSTOM_THEME_COLOR,
  THEME_VARIANTS,
  type CustomThemeColor,
  type ThemeVariant,
} from "@/types/theme";

/** 主题风格缓存 key。 */
export const THEME_VARIANT_STORAGE_KEY = "renewlet_theme_variant";
/** 自定义主题色缓存 key。 */
export const CUSTOM_COLOR_STORAGE_KEY = "renewlet_custom_theme_color";
/** 外观存在未保存改动的标记 key。 */
export const APPEARANCE_PENDING_STORAGE_KEY = "renewlet_appearance_pending";

/** 判断未知值是否为受支持主题风格。 */
export function isThemeVariant(value: unknown): value is ThemeVariant {
  return typeof value === "string" && (THEME_VARIANTS as readonly string[]).includes(value);
}

/** 判断未知值是否为合法 HSL 自定义主题色。 */
export function isCustomThemeColor(value: unknown): value is CustomThemeColor {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const h = record["h"];
  const s = record["s"];
  const l = record["l"];
  return (
    typeof h === "number" &&
    typeof s === "number" &&
    typeof l === "number" &&
    h >= 0 &&
    h <= 360 &&
    s >= 0 &&
    s <= 100 &&
    l >= 0 &&
    l <= 100
  );
}

/** 读取主题风格（无值或非法则返回 null）。 */
export function readThemeVariantFromStorage(): ThemeVariant | null {
  try {
    const raw = localStorage.getItem(THEME_VARIANT_STORAGE_KEY);
    if (!raw) return null;
    return isThemeVariant(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 读取自定义主题色（无值或非法则回退到默认值）。 */
export function readCustomThemeColorFromStorage(): CustomThemeColor {
  try {
    const raw = localStorage.getItem(CUSTOM_COLOR_STORAGE_KEY);
    if (!raw) return DEFAULT_CUSTOM_THEME_COLOR;
    const parsed = JSON.parse(raw) as unknown;
    return isCustomThemeColor(parsed) ? parsed : DEFAULT_CUSTOM_THEME_COLOR;
  } catch {
    return DEFAULT_CUSTOM_THEME_COLOR;
  }
}

/**
 * 读取自定义主题色（无值或非法则返回 null）。
 *
 * 用途：
 * - 当需要“本地优先，但本地未设置时回退到数据库”的逻辑时，用该方法判断本地是否真的有值
 */
export function readCustomThemeColorFromStorageOrNull(): CustomThemeColor | null {
  try {
    const raw = localStorage.getItem(CUSTOM_COLOR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isCustomThemeColor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 写入主题风格缓存（失败则静默忽略）。 */
export function writeThemeVariantToStorage(variant: ThemeVariant): void {
  try {
    localStorage.setItem(THEME_VARIANT_STORAGE_KEY, variant);
  } catch {
    // ignore
  }
}

/** 写入自定义主题色缓存（失败则静默忽略）。 */
export function writeCustomThemeColorToStorage(color: CustomThemeColor): void {
  try {
    localStorage.setItem(CUSTOM_COLOR_STORAGE_KEY, JSON.stringify(color));
  } catch {
    // ignore
  }
}

/** 读取“外观是否有未保存改动”标记。 */
export function readAppearancePendingFromStorage(): boolean {
  try {
    return localStorage.getItem(APPEARANCE_PENDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 写入“外观是否有未保存改动”标记。
 *
 * 说明：
 * - 当用户在本地切换明暗/主题色但未点击“保存所有设置”时，标记为 pending
 * - pending=true：登录后不使用数据库覆盖本地外观（避免冲掉未保存改动）
 * - pending=false：登录后以数据库为准（用于跨设备同步已保存的外观）
 */
export function writeAppearancePendingToStorage(pending: boolean): void {
  try {
    if (pending) {
      localStorage.setItem(APPEARANCE_PENDING_STORAGE_KEY, "1");
      return;
    }
    localStorage.removeItem(APPEARANCE_PENDING_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ===== 自定义 CSS 主题缓存（首屏免闪烁） =====
//
// 三个独立 key：
// - id：当前激活主题 id（空串/缺失视为 null）
// - css：当前激活主题的 CSS 文本（空串/缺失视为 null）
// - enabled：自定义 CSS 总闸；'1'/缺失/空/任何非 '0' 字符串均视为启用，仅严格等于 '0' 视为禁用
//
// 写入路径全部静默吞错，避免 Storage 异常（QuotaExceededError、SecurityError 等）阻断主流程。

/** 当前激活的自定义主题 id 缓存 key。 */
export const ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY = "renewlet_active_custom_theme_id";
/** 当前激活的自定义主题 CSS 文本缓存 key。 */
export const ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY = "renewlet_active_custom_theme_css";
/** 自定义 CSS 总闸状态缓存 key。 */
export const CUSTOM_THEMES_ENABLED_STORAGE_KEY = "renewlet_custom_themes_enabled";

/**
 * 读取当前激活的自定义主题 id。
 *
 * - 空字符串视为 null（与 key 缺失等价）
 * - 任何抛错均返回 null
 */
export function readActiveCustomThemeIdFromStorage(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY);
    if (!raw) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * 读取当前激活的自定义主题 CSS 文本。
 *
 * - 空字符串视为 null（与 key 缺失等价）
 * - 任何抛错均返回 null
 * - 当 CSS 字节长度（UTF-8）超过 maxBytes 时视为损坏：同步清掉 ID 与 CSS 两个 key 后返回 null
 *
 * @param maxBytes UTF-8 字节长度上限；建议传 CSS_SIZE_LIMIT * 2
 */
export function readActiveCustomThemeCssFromStorage(maxBytes: number): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY);
    if (!raw) return null;
    const byteLength = new TextEncoder().encode(raw).length;
    if (byteLength > maxBytes) {
      // 损坏检测命中：同步清掉两个 key，分别 try/catch
      try {
        localStorage.removeItem(ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY);
      } catch {
        // ignore
      }
      try {
        localStorage.removeItem(ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY);
      } catch {
        // ignore
      }
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * 读取自定义 CSS 总闸状态。
 *
 * - 严格等于 '0' 才返回 false
 * - 缺失 / 空字符串 / 任何其它字符串 / 抛错 均返回 true
 */
export function readCustomThemesEnabledFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_ENABLED_STORAGE_KEY);
    return raw !== "0";
  } catch {
    return true;
  }
}

/**
 * 写入当前激活的自定义主题（id + css）。
 *
 * - 同步调用栈内按 id → css 顺序 setItem，中间不 await
 * - 整段 try/catch 静默吞错（QuotaExceededError、SecurityError 等）
 */
export function writeActiveCustomThemeToStorage(id: string, css: string): void {
  try {
    localStorage.setItem(ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY, id);
    localStorage.setItem(ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY, css);
  } catch {
    // ignore
  }
}

/**
 * 清除当前激活的自定义主题缓存（id + css）。
 *
 * - 先 removeItem(ID_KEY) 再 removeItem(CSS_KEY)，分别 try/catch 吞错
 * - 即使其中一次失败也不阻断另一次
 */
export function clearActiveCustomThemeFromStorage(): void {
  try {
    localStorage.removeItem(ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * 写入自定义 CSS 总闸状态。
 *
 * - true 写入 '1'，false 写入 '0'
 * - try/catch 静默吞错
 */
export function writeCustomThemesEnabledToStorage(enabled: boolean): void {
  try {
    localStorage.setItem(CUSTOM_THEMES_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore
  }
}

/**
 * 自定义 CSS 主题相关的三个 Theme_Storage key 的“原始”快照。
 *
 * 用途：`useCustomThemes` 在写入 Settings_Store 之前先快照 storage 三 key
 * 的当前值（含 key 缺失），以便写入失败时能精确回滚到本次写入前的状态
 * （Requirement 9.5）。
 *
 * 字段语义：`null` 表示 key 在 storage 中缺失或读取抛异常；非 null 字符串
 * 即为 `localStorage.getItem` 的原始返回值（含 `'0'` / `'1'` / 任意脏数据），
 * 由 `restoreStorageSnapshot` 原样还原，**不**进行任何归一化（避免回滚后
 * 与写入前不一致）。
 */
export interface CustomThemeStorageSnapshot {
  id: string | null;
  css: string | null;
  enabledRaw: string | null;
}

/**
 * 同步读取自定义 CSS 主题相关三个 storage key 的原始值，用作回滚锚点。
 *
 * 行为：
 * - 每个 key 独立 try/catch，确保单 key 抛错不影响其它 key 的读取。
 * - 不做长度 / 字节 / 合法性校验：直接保留 `localStorage.getItem` 的返回值。
 * - 任何抛错的 key 在快照中视为 `null`（即“缺失”），与读取成功但确实缺失
 *   的情形等价；这是为了让 `restoreStorageSnapshot` 路径只关心“非 null
 *   就写回，null 就 removeItem”的二态逻辑。
 */
export function readAllCustomThemeStorage(): CustomThemeStorageSnapshot {
  let id: string | null = null;
  let css: string | null = null;
  let enabledRaw: string | null = null;
  try {
    id = localStorage.getItem(ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    css = localStorage.getItem(ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    enabledRaw = localStorage.getItem(CUSTOM_THEMES_ENABLED_STORAGE_KEY);
  } catch {
    // ignore
  }
  return { id, css, enabledRaw };
}

/**
 * 用快照中的原始值覆写自定义 CSS 主题相关三个 storage key。
 *
 * 行为：
 * - `snap.id === null` → `removeItem(ID_KEY)`；否则 `setItem(ID_KEY, snap.id)`。
 *   `css` 与 `enabledRaw` 同理。
 * - 每个 key 独立 try/catch，单 key 失败不阻断其它 key 的还原。
 * - 不做归一化或校验，原样写回，确保回滚后 storage 与写入前严格相等。
 */
export function restoreStorageSnapshot(snap: CustomThemeStorageSnapshot): void {
  try {
    if (snap.id === null) {
      localStorage.removeItem(ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY);
    } else {
      localStorage.setItem(ACTIVE_CUSTOM_THEME_ID_STORAGE_KEY, snap.id);
    }
  } catch {
    // ignore
  }
  try {
    if (snap.css === null) {
      localStorage.removeItem(ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY);
    } else {
      localStorage.setItem(ACTIVE_CUSTOM_THEME_CSS_STORAGE_KEY, snap.css);
    }
  } catch {
    // ignore
  }
  try {
    if (snap.enabledRaw === null) {
      localStorage.removeItem(CUSTOM_THEMES_ENABLED_STORAGE_KEY);
    } else {
      localStorage.setItem(CUSTOM_THEMES_ENABLED_STORAGE_KEY, snap.enabledRaw);
    }
  } catch {
    // ignore
  }
}
