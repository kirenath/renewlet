/**
 * Settings 领域规则：自定义 CSS 主题（Custom CSS Themes）。
 *
 * 架构位置：
 * - 纯函数 / 纯常量层，不依赖 React、PocketBase、localStorage、`window` 或任何 I/O。
 * - application 层（`use-custom-themes`）负责把这里的结果转换成 React Query mutation、
 *   Theme_Storage 写入与 UI 提示。
 * - presentation 层（编辑器对话框 / Theme_Section）只通过 application 层间接使用，
 *   不应直接 import `types/subscription.ts` 的限额常量；统一从这里 re-export。
 *
 * 当前已实现：
 * - `byteLength`：UTF-8 字节计数原语。
 * - `validateThemeInput`：按固定顺序返回**第一条**违反的约束。
 * - `createTheme`：生成符合 schema 的新主题对象（含 UUID、ISO 时间戳）。
 * - `THEME_NAME_LIMIT` / `CSS_SIZE_LIMIT` / `THEME_COUNT_LIMIT`：从 `types/subscription`
 *   re-export 的便捷常量，避免 presentation 层再额外 import 类型文件。
 *
 * 后续 task 会在此文件继续追加 `updateTheme` / `deleteTheme` / `activate` /
 * `buildPersistPayload` / `reconcileStorageWithSettings` / `computeEffectiveEnabled` /
 * `serializeExport` / `parseImport` / `applyImport` 等纯函数。
 */
import {
  CSS_SIZE_LIMIT,
  THEME_COUNT_LIMIT,
  THEME_EXPORT_VERSION,
  THEME_NAME_LIMIT,
  type AppSettings,
  type CustomCssTheme,
} from "@/types/subscription";
import {
  clearActiveCustomThemeFromStorage,
  writeActiveCustomThemeToStorage,
  writeCustomThemesEnabledToStorage,
} from "@/lib/theme-storage";

export {
  CSS_SIZE_LIMIT,
  THEME_COUNT_LIMIT,
  THEME_EXPORT_VERSION,
  THEME_NAME_LIMIT,
};

/**
 * 计算字符串按 UTF-8 编码后的字节长度。
 *
 * 用于 CSS 体积上限校验（CSS_SIZE_LIMIT，单位为字节）；与 Settings_Schema 中
 * `customCssThemeSchema.css` 的 refine 保持一致，避免 UI 与后端校验对“多大才算超限”
 * 出现分歧（Requirement 2.8 / 3.5）。
 *
 * 注意：`String.prototype.length` 是 UTF-16 code unit 数量，对非 BMP 字符（emoji、
 * 部分中日韩补充字符）会比 UTF-8 字节数小很多，因此**不能**直接用 `css.length` 替代。
 */
export function byteLength(css: string): number {
  return new TextEncoder().encode(css).length;
}

/**
 * `validateThemeInput` 在“非 ok”分支上返回的错误码集合。
 *
 * - `NAME_EMPTY`：`rawName.trim()` 长度为 0（包含纯空白）。
 * - `NAME_TOO_LONG`：`rawName.trim()` 长度超过 `THEME_NAME_LIMIT`。
 * - `CSS_TOO_LARGE`：`byteLength(css)` 超过 `CSS_SIZE_LIMIT`。
 * - `COUNT_LIMIT`：`currentCount` 已达 `THEME_COUNT_LIMIT`（用于“新建主题”路径）。
 */
export type ValidateThemeInputError =
  | "NAME_EMPTY"
  | "NAME_TOO_LONG"
  | "CSS_TOO_LARGE"
  | "COUNT_LIMIT";

export type ValidateThemeInputResult =
  | { ok: true }
  | { ok: false; code: ValidateThemeInputError };

/**
 * 校验“新建 / 编辑主题”表单提交时的输入是否满足全部约束。
 *
 * 校验顺序固定为：name 长度（空 → 超长） → css 大小 → 数量上限。
 * 多条约束同时被违反时，**只**返回顺序在前的那一条错误码（Requirement 2.6 / 2.7 /
 * 2.8 / 3.5），让 UI 在每次渲染只展示一个最直接的内联错误。
 *
 * 数量上限（`COUNT_LIMIT`）只在新建路径上有意义（`currentCount` 应为当前
 * Custom_Theme_Collection 长度）。编辑路径的调用方应传入 `THEME_COUNT_LIMIT - 1`
 * 等价值，或在 controller 层直接跳过该位的判断；本函数本身不区分新建 / 编辑。
 *
 * 函数纯：不读 storage、不发请求、不依赖 `Date.now()` 等全局状态。
 */
export function validateThemeInput(
  rawName: string,
  css: string,
  currentCount: number,
): ValidateThemeInputResult {
  const trimmedLength = rawName.trim().length;

  if (trimmedLength === 0) {
    return { ok: false, code: "NAME_EMPTY" };
  }

  if (trimmedLength > THEME_NAME_LIMIT) {
    return { ok: false, code: "NAME_TOO_LONG" };
  }

  if (byteLength(css) > CSS_SIZE_LIMIT) {
    return { ok: false, code: "CSS_TOO_LARGE" };
  }

  if (currentCount >= THEME_COUNT_LIMIT) {
    return { ok: false, code: "COUNT_LIMIT" };
  }

  return { ok: true };
}

/**
 * 用合法输入构造一条全新的 `CustomCssTheme` 记录。
 *
 * 行为契约（Requirement 2.2 / 2.3 / 2.4）：
 * - `id` 由 `crypto.randomUUID()` 生成，符合 RFC 4122 v4。
 * - `name` 存 `input.name.trim()`；`css` 原样存（不消毒、不改写，Requirement 13.1）。
 * - `createdAt` 与 `updatedAt` 取**同一个** `new Date().toISOString()` 调用结果，
 *   确保新建时两者严格相等且为 UTC ISO 8601（结尾 `Z`）字符串。
 *
 * 函数纯：不读 storage、不发请求、不依赖除 `Date` / `crypto` 之外的全局状态。
 * 调用方（controller）负责：
 * 1. 在调用前用 `validateThemeInput(input.name, input.css, currentCount)` 校验输入；
 * 2. 调用后把结果追加到 `customThemes` 数组并触发持久化。
 */
export function createTheme(input: {
  name: string;
  css: string;
}): CustomCssTheme {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    css: input.css,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 用合法 patch 覆盖 `themes` 数组中 `id` 等于 `targetId` 的条目并返回新数组。
 *
 * 行为契约（Requirement 3.1 / 3.2 / 3.3）：
 * - 不就地修改 `themes`，返回**新**数组并保留原顺序。
 * - 命中条目的 `id` / `createdAt` 不变；`name` 写 `patch.name.trim()`、`css` 原样写、
 *   `updatedAt` 写 `new Date().toISOString()`。
 * - 当 `targetId` 不在数组中时返回原 `themes` 引用（视为空操作，便于上层用 Object.is
 *   判断"是否真的发生了变化"以决定是否再触发持久化写入）。
 *
 * 不在此处校验 `patch`：调用方（controller）应在 mutate 之前用 `validateThemeInput`
 * 把关，避免把 schema 校验失败留到 PocketBase 层才暴露。
 */
export function updateTheme(
  themes: CustomCssTheme[],
  targetId: string,
  patch: { name: string; css: string },
): CustomCssTheme[] {
  let hit = false;
  const next = themes.map((theme) => {
    if (theme.id !== targetId) {
      return theme;
    }
    hit = true;
    return {
      ...theme,
      name: patch.name.trim(),
      css: patch.css,
      updatedAt: new Date().toISOString(),
    };
  });

  if (!hit) {
    return themes;
  }

  return next;
}

/**
 * 从主题集合 + 激活指针中删除一条主题，并在必要时把激活指针置为 `null`。
 *
 * 行为契约（Requirement 4.1 / 4.2 / 4.6）：
 * - 当 `targetId` 不在 `state.themes` 中时返回原 `state` 引用（视为空操作）；
 *   上层据此决定是否需要触发持久化写入。
 * - 命中时返回新对象：`themes` 用 `filter` 移除唯一一条匹配条目（其余条目相对顺序不变），
 *   `activeId` 仅在被删除的就是当前激活主题时降为 `null`，否则原样保留。
 */
export function deleteTheme(
  state: { themes: CustomCssTheme[]; activeId: string | null },
  targetId: string,
): { themes: CustomCssTheme[]; activeId: string | null } {
  const exists = state.themes.some((theme) => theme.id === targetId);
  if (!exists) {
    return state;
  }

  return {
    themes: state.themes.filter((theme) => theme.id !== targetId),
    activeId: state.activeId === targetId ? null : state.activeId,
  };
}

/**
 * 把激活指针切换为 `target`，幂等。
 *
 * 行为契约（Requirement 5.1 / 5.2）：
 * - 当 `target === state.activeId` 时返回原 `state` 引用，作为幂等空操作；
 *   上层据此跳过 `<style>` 重写与持久化写入。
 * - 否则返回新对象，仅更新 `activeId`，主题数组引用保持不变。
 * - 不校验 `target` 是否在 `state.themes` 内：悬空指针由 `buildPersistPayload`
 *   在持久化前统一修正为 `null`（Requirement 5.7），CSS_Injector 在运行时
 *   也会因为找不到对应主题而跳过注入（Requirement 5.6）。
 */
export function activate(
  state: { themes: CustomCssTheme[]; activeId: string | null },
  target: string | null,
): { themes: CustomCssTheme[]; activeId: string | null } {
  if (target === state.activeId) {
    return state;
  }

  return {
    themes: state.themes,
    activeId: target,
  };
}

/**
 * 为下一次 Settings_Store 写入构造 payload，并顺手修正悬空的激活指针。
 *
 * 行为契约（Requirement 5.7 / 12.1）：
 * - 若 `state.activeId` 非 `null` 但不属于 `state.themes` 的 id 集合，把
 *   `activeCustomThemeId` 重置为 `null`，确保不会把"指向已删除主题"的状态
 *   持久化到 Settings_Store；不为此修正单独发起额外写请求。
 * - 否则按原值穿透。
 * - 三个字段始终一并出现在结果对象上，使调用方可以一次性把它们 spread 进
 *   `{ ...current, ...buildPersistPayload(state) }` 完成单次写入。
 */
export function buildPersistPayload(state: {
  themes: CustomCssTheme[];
  activeId: string | null;
  enabled: boolean;
}): {
  customThemes: CustomCssTheme[];
  activeCustomThemeId: string | null;
  customThemesEnabled: boolean;
} {
  const ids = new Set(state.themes.map((theme) => theme.id));
  const activeCustomThemeId =
    state.activeId !== null && !ids.has(state.activeId) ? null : state.activeId;

  return {
    customThemes: state.themes,
    activeCustomThemeId,
    customThemesEnabled: state.enabled,
  };
}

/**
 * 把 Theme_Storage 三个 key 收敛到与 `settings` 一致。
 *
 * 行为契约（Requirement 8.10 / 12.2 / 12.3）：
 * - 总闸 key 始终按 `settings.customThemesEnabled` 写入（`true` → `'1'`、`false` → `'0'`）。
 * - 当 `settings.activeCustomThemeId === null` 或对应主题在 `settings.customThemes` 中不存在
 *   （含悬空指针）时，清掉 active id / css 两个 key。
 * - 否则把对应主题的 id 与 css 原样写入 storage（Requirement 8.4 的同步顺序由
 *   `writeActiveCustomThemeToStorage` 保证）。
 *
 * 函数纯（在"对 storage 副作用"的意义下）：仅同步本地 storage，不发起任何
 * PocketBase 网络请求（Requirement 12.2 明确反向写回路径不存在）。
 */
export function reconcileStorageWithSettings(settings: AppSettings): void {
  writeCustomThemesEnabledToStorage(settings.customThemesEnabled);

  const activeId = settings.activeCustomThemeId;
  if (activeId === null) {
    clearActiveCustomThemeFromStorage();
    return;
  }

  const active = settings.customThemes.find((theme) => theme.id === activeId);
  if (!active) {
    clearActiveCustomThemeFromStorage();
    return;
  }

  writeActiveCustomThemeToStorage(active.id, active.css);
}

/**
 * 综合 URL 旁路 + Settings_Store + Theme_Storage 计算"自定义 CSS 是否生效"。
 *
 * 行为契约（Requirement 7.8 / 8.8）：
 * - `bypass` 由 `args.search` 中查询参数 `disableCustomCss` 是否严格等于 `'1'` 决定：
 *   - `string` 输入按 `URLSearchParams(args.search)` 解析；
 *   - `URLSearchParams` 输入直接读取；
 *   - `null` 输入视为 `false`。
 * - 命中 `bypass` 时强制返回 `{ enabled: false, bypass: true }`，不读 settings/storage，
 *   也不修改任何持久化值。
 * - 否则 `enabled = settingsEnabled ?? storageEnabled`：在 settings 未到达时退回到
 *   storage 的缓存值，避免首屏从"无主题"切到"有主题"造成可见闪烁。
 *
 * 函数纯：参数显式传入，不读 `window.location`；调用方负责取 `window.location.search`。
 */
export function computeEffectiveEnabled(args: {
  search: string | URLSearchParams | null;
  settingsEnabled: boolean | null;
  storageEnabled: boolean;
}): { enabled: boolean; bypass: boolean } {
  let params: URLSearchParams | null;
  if (args.search === null) {
    params = null;
  } else if (typeof args.search === "string") {
    params = new URLSearchParams(args.search);
  } else {
    params = args.search;
  }

  const bypass = params !== null && params.get("disableCustomCss") === "1";
  if (bypass) {
    return { enabled: false, bypass: true };
  }

  return {
    enabled: args.settingsEnabled ?? args.storageEnabled,
    bypass: false,
  };
}

/**
 * 导入文件中单条主题的最小形态（仅 `name` + `css`）。
 *
 * 导出文档**不**包含 `id` / `createdAt` / `updatedAt`：导入时无论"追加"或"覆盖"
 * 都会重新生成 UUID 与时间戳（Requirement 10.3 / 10.4），跨账号迁移时这三个
 * 元数据原样保留没有意义。
 */
export interface ParsedTheme {
  name: string;
  css: string;
}

/**
 * `parseImport` / `applyImport` 在失败分支上返回的错误码集合。
 *
 * 错误分支决定 UI 显示的 toast 文案（Requirement 10.5–10.7），任何错误下
 * Custom_Theme_Collection 与 Active_Theme_Pointer 都保持不变。
 */
export type ImportError =
  | { code: "INVALID_JSON" }
  | { code: "INVALID_VERSION"; version: unknown }
  | { code: "THEMES_NOT_ARRAY" }
  | { code: "INVALID_THEME"; index: number; field: "name" | "css" }
  | { code: "COUNT_LIMIT"; resultLength: number };

/**
 * 把当前 Custom_Theme_Collection 序列化为 Theme_Export_Format JSON 字符串。
 *
 * 协议（Requirement 10.1）：`{ "version": THEME_EXPORT_VERSION, "themes": [{ name, css }] }`。
 * 仅保留 `name` 与 `css`：`id` / `createdAt` / `updatedAt` 在导入时由目标设备重新生成。
 */
export function serializeExport(themes: CustomCssTheme[]): string {
  return JSON.stringify({
    version: THEME_EXPORT_VERSION,
    themes: themes.map((theme) => ({ name: theme.name, css: theme.css })),
  });
}

/**
 * 校验导入文件中单条主题的 `name` 与 `css` 是否满足 schema 约束。
 *
 * 仅供 `parseImport` 内部使用；按 `name` → `css` 的顺序返回首个不合规字段，
 * 与 `validateThemeInput` 的字段优先级保持一致（Requirement 10.7）。
 */
function validateParsedTheme(
  theme: ParsedTheme,
): { ok: true } | { ok: false; field: "name" | "css" } {
  const trimmed = theme.name.trim();
  if (trimmed.length === 0 || trimmed.length > THEME_NAME_LIMIT) {
    return { ok: false, field: "name" };
  }
  if (byteLength(theme.css) > CSS_SIZE_LIMIT) {
    return { ok: false, field: "css" };
  }
  return { ok: true };
}

/**
 * 解析 Theme_Export_Format JSON 字符串。
 *
 * 行为契约（Requirement 10.6 / 10.7）：
 * - JSON 解析失败 → `INVALID_JSON`。
 * - `version` 不严格等于 `THEME_EXPORT_VERSION`（含缺失） → `INVALID_VERSION`，附带原值供 UI 显示。
 * - `themes` 不是数组 → `THEMES_NOT_ARRAY`。
 * - 任意一条主题 `name` 空 / 超长（>80 字符）或 `css` UTF-8 字节超 100 KiB →
 *   `INVALID_THEME`，附带索引与首个违反字段（不部分接受，整批拒绝）。
 *
 * 不在此处生成 UUID 或时间戳：那是 `applyImport` 的责任，并取决于追加/覆盖模式。
 */
export function parseImport(
  raw: string,
):
  | { ok: true; value: { version: 1; themes: ParsedTheme[] } }
  | { ok: false; error: ImportError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "INVALID_JSON" } };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: { code: "INVALID_JSON" } };
  }

  const obj = parsed as { version?: unknown; themes?: unknown };

  if (obj.version !== THEME_EXPORT_VERSION) {
    return {
      ok: false,
      error: { code: "INVALID_VERSION", version: obj.version },
    };
  }

  if (!Array.isArray(obj.themes)) {
    return { ok: false, error: { code: "THEMES_NOT_ARRAY" } };
  }

  const themes: ParsedTheme[] = [];
  for (let index = 0; index < obj.themes.length; index += 1) {
    const candidate = obj.themes[index] as
      | { name?: unknown; css?: unknown }
      | null
      | undefined;

    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate !== "object"
    ) {
      return {
        ok: false,
        error: { code: "INVALID_THEME", index, field: "name" },
      };
    }

    if (typeof candidate.name !== "string") {
      return {
        ok: false,
        error: { code: "INVALID_THEME", index, field: "name" },
      };
    }
    if (typeof candidate.css !== "string") {
      return {
        ok: false,
        error: { code: "INVALID_THEME", index, field: "css" },
      };
    }

    const themeCandidate: ParsedTheme = {
      name: candidate.name,
      css: candidate.css,
    };
    const validation = validateParsedTheme(themeCandidate);
    if (!validation.ok) {
      return {
        ok: false,
        error: { code: "INVALID_THEME", index, field: validation.field },
      };
    }

    themes.push(themeCandidate);
  }

  return { ok: true, value: { version: THEME_EXPORT_VERSION, themes } };
}

/**
 * 把已解析的导入主题应用到当前状态，并按追加/覆盖语义生成新状态。
 *
 * 行为契约（Requirement 10.3 / 10.4 / 10.5 / 10.7）：
 * - 每条导入主题都会重新生成 UUID `id` 与同一 ISO 时间戳作为 `createdAt` / `updatedAt`，
 *   确保与既有主题及批次内其他主题都不冲突。
 * - `append`：把新主题按数组顺序拼到 `state.themes` 末尾，保留 `state.activeId`。
 * - `overwrite`：用新主题替换整个集合，并把 `activeId` 重置为 `null`（Requirement 10.4）。
 * - 任意模式下，若结果长度超过 THEME_COUNT_LIMIT（20），整批拒绝（不部分接受）并返回
 *   `COUNT_LIMIT`，调用方据此通过 `Object.is` 检测保持原 state 不变。
 *
 * 不在此处再次校验单条 `name` / `css`：`parseImport` 已在解析阶段全部把过关，
 * 此处只负责"批次级"校验（数量上限）。
 */
export function applyImport(
  state: { themes: CustomCssTheme[]; activeId: string | null },
  parsed: { themes: ParsedTheme[] },
  mode: "append" | "overwrite",
):
  | {
      ok: true;
      next: { themes: CustomCssTheme[]; activeId: string | null };
    }
  | { ok: false; reason: ImportError } {
  const now = new Date().toISOString();
  const materialised: CustomCssTheme[] = parsed.themes.map((theme) => ({
    id: crypto.randomUUID(),
    name: theme.name.trim(),
    css: theme.css,
    createdAt: now,
    updatedAt: now,
  }));

  if (mode === "append") {
    const result = [...state.themes, ...materialised];
    if (result.length > THEME_COUNT_LIMIT) {
      return {
        ok: false,
        reason: { code: "COUNT_LIMIT", resultLength: result.length },
      };
    }
    return {
      ok: true,
      next: { themes: result, activeId: state.activeId },
    };
  }

  // mode === 'overwrite'
  if (materialised.length > THEME_COUNT_LIMIT) {
    return {
      ok: false,
      reason: { code: "COUNT_LIMIT", resultLength: materialised.length },
    };
  }
  return {
    ok: true,
    next: { themes: materialised, activeId: null },
  };
}
