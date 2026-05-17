/**
 * `useCustomThemes` —— Custom CSS Themes 应用层 controller。
 *
 * 架构位置：
 * - presentation 层（`CustomThemeSection` / `ThemeEditorDialog` /
 *   `ThemeImportDialog`）通过本 hook 拿到“当前主题列表 + 可用动作”。
 * - 业务规则全部委托给 `modules/settings/domain/custom-theme.ts` 的纯函数；
 *   本文件只负责把它们与 React Query 缓存、Theme_Storage、`useUpdateSettings`
 *   组装在一起。
 * - **不**并入 `useSettingsFormController` 的草稿态：每次显式动作都立即落库
 *   （Requirement 9.1 / 9.3），而不是等待页面底部“保存所有设置”按钮。
 *
 * 写入路径（Requirement 9.3）：
 * 仅在使用者显式动作（创建 / 编辑 / 删除 / 激活 / 切总闸 / 导入）回调内调用
 * `updateSettingsMutation.mutateAsync`；首屏挂载、Theme_Storage 读、`useSettings`
 * 数据到达等任何被动事件**不**触发该 mutation。
 *
 * 乐观更新 + 回滚（Requirement 9.5）：
 * 每次 `mutateAsync` 之前同步保存 `prev = queryClient.getQueryData(['settings'])`
 * 与 `prevStorage = readAllCustomThemeStorage()`，先把乐观结果写入 React Query
 * 缓存与 Theme_Storage；若 `mutateAsync` reject 则同步回滚二者，并把可读错误
 * 写入本地 `error` 状态，由 UI 持续展示直至 `dismissError`（Requirement 9.4）。
 */
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings, useUpdateSettings, normalizeSettings } from "@/hooks/use-settings";
import {
  applyImport,
  buildPersistPayload,
  computeEffectiveEnabled,
  createTheme as createThemeDomain,
  deleteTheme as deleteThemeDomain,
  activate as activateDomain,
  parseImport,
  reconcileStorageWithSettings,
  serializeExport,
  updateTheme as updateThemeDomain,
  validateThemeInput,
  type ImportError,
  type ParsedTheme,
} from "@/modules/settings/domain/custom-theme";
import {
  readAllCustomThemeStorage,
  restoreStorageSnapshot,
  type CustomThemeStorageSnapshot,
} from "@/lib/theme-storage";
import {
  CSS_SIZE_LIMIT,
  DEFAULT_SETTINGS,
  THEME_COUNT_LIMIT,
  THEME_NAME_LIMIT,
  type AppSettings,
  type CustomCssTheme,
} from "@/types/subscription";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { useI18n } from "@/i18n/I18nProvider";

const SETTINGS_QUERY_KEY = ["settings"] as const;

export interface UseCustomThemesResult {
  /** 当前主题列表（即 `settings.customThemes`，未加工）。 */
  themes: CustomCssTheme[];
  /** 当前激活主题 id；可能指向已删除主题（悬空，由 effectiveActive 兜底）。 */
  activeId: string | null;
  /** 总闸状态（不含 URL 旁路；见 effectiveActive 与 isUrlBypass）。 */
  enabled: boolean;
  /** 综合 bypass + enabled + activeId + customThemes 后真正生效的那条主题。 */
  effectiveActive: CustomCssTheme | null;
  /** 当前会话是否被 ?disableCustomCss=1 强制旁路。 */
  isUrlBypass: boolean;
  /** 是否有持久化写入正在进行中（来自 useUpdateSettings.isPending）。 */
  isMutating: boolean;
  /** 持久化失败时的可读错误；由 dismissError() 清空。 */
  error: string | null;
  /** 创建一条新主题（同步动作内立即落库）。 */
  createTheme: (input: { name: string; css: string }) => Promise<void>;
  /** 编辑一条主题（同步动作内立即落库）。 */
  updateTheme: (id: string, input: { name: string; css: string }) => Promise<void>;
  /** 删除一条主题（命中激活时同步把 activeId 置为 null）。 */
  deleteTheme: (id: string) => Promise<void>;
  /** 切换激活主题（target=null 表示取消激活）。 */
  activate: (id: string | null) => Promise<void>;
  /** 切换总闸（true ↔ false）。 */
  toggleEnabled: () => Promise<void>;
  /** 触发浏览器下载导出 JSON（同步执行）。 */
  exportThemes: () => void;
  /** 解析 + 应用导入文件，按 mode 决定追加 / 覆盖。 */
  importThemes: (file: File, mode: "append" | "overwrite") => Promise<void>;
  /** 仅解析导入文件，不修改任何状态（用于打开导入对话框前的预览）。 */
  parseImportFile: (
    file: File,
  ) => Promise<{ themes: ParsedTheme[] } | { error: ImportError }>;
  /** 关闭可读错误提示。 */
  dismissError: () => void;
}

/** 把 ImportError / ValidateThemeInputError 等非 Error 值转成可读文案。 */
function formatImportError(
  error: ImportError,
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (error.code) {
    case "INVALID_JSON":
      return t("customThemes.errors.import.invalidJson");
    case "INVALID_VERSION":
      return t("customThemes.errors.import.invalidVersion");
    case "THEMES_NOT_ARRAY":
      return t("customThemes.errors.import.themesNotArray");
    case "INVALID_THEME":
      return t("customThemes.errors.import.invalidTheme", {
        index: error.index,
        field: error.field,
      });
    case "COUNT_LIMIT":
      return t("customThemes.errors.import.countLimit", {
        limit: THEME_COUNT_LIMIT,
      });
  }
}

/** 用本地日期生成 `YYYY-MM-DD` 串（不使用 UTC）。 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 触发浏览器下载：创建临时 `<a download>` 链接、点击、清理。
 *
 * 同步执行：在使用者点击事件帧内完成 anchor 的创建与点击，避免被部分浏览器
 * 视为“非用户手势触发的下载”而拦截。`URL.createObjectURL` 创建的引用在
 * `revokeObjectURL` 后才会被 GC；我们在 click 之后立即 revoke 以避免泄漏。
 */
function triggerDownload(filename: string, blob: Blob): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 校验单条主题输入，命中校验失败时抛出 i18n 化的 Error。
 *
 * 行为：
 * - currentCount 由调用方决定：新建路径传当前数组长度（参与 COUNT_LIMIT
 *   判定）；编辑路径传 0，跳过 COUNT_LIMIT 检查（编辑不增数）。
 * - 抛出错误的 message 已经过 `t(...)` 翻译，可直接展示在 UI；外层 catch
 *   会再用 `getDisplayErrorMessage` 兜底，不会触碰这里的可读文案。
 */
function ensureValidThemeInput(
  input: { name: string; css: string },
  currentCount: number,
  t: ReturnType<typeof useI18n>["t"],
): void {
  const result = validateThemeInput(input.name, input.css, currentCount);
  if (result.ok) return;
  switch (result.code) {
    case "NAME_EMPTY":
      throw new Error(t("customThemes.errors.name.empty"));
    case "NAME_TOO_LONG":
      throw new Error(
        t("customThemes.errors.name.tooLong", { limit: THEME_NAME_LIMIT }),
      );
    case "CSS_TOO_LARGE":
      throw new Error(
        t("customThemes.errors.css.tooLarge", { limit: CSS_SIZE_LIMIT }),
      );
    case "COUNT_LIMIT":
      throw new Error(
        t("customThemes.errors.count.limit", { limit: THEME_COUNT_LIMIT }),
      );
  }
}

export function useCustomThemes(): UseCustomThemesResult {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const updateSettingsMutation = useUpdateSettings();
  const [error, setError] = useState<string | null>(null);

  // 一次性读 URL 旁路标志：只在 hook 首次创建时解析一次，避免每次重渲染重复解析。
  // ?disableCustomCss=1 仅本会话有效，期间不修改持久化值（Requirement 7.8）。
  const isUrlBypass = useMemo<boolean>(() => {
    if (typeof window === "undefined") return false;
    return (
      new URLSearchParams(window.location.search).get("disableCustomCss") ===
      "1"
    );
  }, []);

  // 当前 settings；尚未到达时退回 DEFAULT_SETTINGS，让所有动作都至少能正确
  // 计算 buildPersistPayload（其余字段会在 mutateAsync 内被 normalizeSettings
  // 与 React Query 缓存中真正的 current 合并，所以不会污染未触及字段）。
  const current: AppSettings = settings ?? DEFAULT_SETTINGS;
  const themes = current.customThemes;
  const activeId = current.activeCustomThemeId;
  const enabled = current.customThemesEnabled;

  // 综合 bypass + enabled + activeId + customThemes 计算 effectiveActive，与
  // CustomCssInjector 的判定保持一致；UI 用它来显示“当前激活”徽章。
  const effectiveActive = useMemo<CustomCssTheme | null>(() => {
    const search = typeof window === "undefined" ? null : window.location.search;
    const { enabled: effectiveEnabled } = computeEffectiveEnabled({
      search,
      settingsEnabled: settings ? settings.customThemesEnabled : null,
      storageEnabled: enabled,
    });
    if (!effectiveEnabled) return null;
    if (activeId === null) return null;
    return themes.find((theme) => theme.id === activeId) ?? null;
  }, [activeId, enabled, settings, themes]);

  /**
   * 共享 mutation 路径：保存快照 → 应用乐观更新 → 等待 mutateAsync → 失败回滚。
   *
   * 设计：
   * - 把 `compute` 设计成 `(current) => next` 让上层动作只关注“怎么算下一个状态”，
   *   把缓存读、storage 收敛、回滚等胶水代码集中在这里。
   * - `current` 优先取 React Query 缓存，避免使用闭包里的 `settings`（后者在
   *   并发动作之间可能落后于真实缓存）。
   * - 失败时把异常抛回调用方（让对话框可以保留输入）；同时 `error` 状态被
   *   更新，由顶层 toast / Alert 持续展示（Requirement 9.4）。
   */
  const performMutation = useCallback(
    async (compute: (current: AppSettings) => AppSettings): Promise<void> => {
      const prev =
        queryClient.getQueryData<AppSettings>(SETTINGS_QUERY_KEY) ??
        DEFAULT_SETTINGS;
      const prevStorage: CustomThemeStorageSnapshot =
        readAllCustomThemeStorage();
      const optimistic = compute(prev);

      // 同步应用乐观更新：React Query 缓存 + Theme_Storage 三 key 一并收敛，
      // 让 CustomCssInjector 在 mutateAsync 解决之前就能看到新状态。
      queryClient.setQueryData(SETTINGS_QUERY_KEY, optimistic);
      reconcileStorageWithSettings(optimistic);

      try {
        // useUpdateSettings 内部以 React Query 缓存 + patch 二次 normalize 合并，
        // 把当前所有字段一并写回；这里传 buildPersistPayload 输出的三字段即可。
        const patch = buildPersistPayload({
          themes: optimistic.customThemes,
          activeId: optimistic.activeCustomThemeId,
          enabled: optimistic.customThemesEnabled,
        });
        await updateSettingsMutation.mutateAsync(patch);
        // 成功路径不在这里写缓存：useUpdateSettings.onSuccess 会以服务器返回值
        // 覆盖缓存，避免乐观值与服务器值出现微小差异（如时间戳）时无法收敛。
      } catch (e) {
        // 同步回滚：缓存与 storage 均回到本次写入前；error 持续可见至 dismiss。
        queryClient.setQueryData(SETTINGS_QUERY_KEY, prev);
        restoreStorageSnapshot(prevStorage);
        setError(
          t("customThemes.errors.save.failed", {
            reason: getDisplayErrorMessage(e),
          }),
        );
        throw e;
      }
    },
    [queryClient, t, updateSettingsMutation],
  );

  // ---- CRUD 动作 ----------------------------------------------------------

  const createTheme = useCallback(
    async (input: { name: string; css: string }): Promise<void> => {
      // 校验放在 performMutation 之前：避免“先写乐观再回滚”的多余抖动，让
      // UI 内联错误提示在 ensureValidThemeInput 抛错路径上即可显示。
      ensureValidThemeInput(input, current.customThemes.length, t);
      const newTheme = createThemeDomain(input);
      await performMutation((latest) =>
        normalizeSettings({
          ...latest,
          ...buildPersistPayload({
            themes: [...latest.customThemes, newTheme],
            activeId: latest.activeCustomThemeId,
            enabled: latest.customThemesEnabled,
          }),
        }),
      );
    },
    [current.customThemes.length, performMutation, t],
  );

  const updateTheme = useCallback(
    async (
      id: string,
      input: { name: string; css: string },
    ): Promise<void> => {
      // 编辑路径不参与 COUNT_LIMIT；传 0 让 validateThemeInput 跳过该项判定。
      ensureValidThemeInput(input, 0, t);
      await performMutation((latest) => {
        const nextThemes = updateThemeDomain(latest.customThemes, id, input);
        return normalizeSettings({
          ...latest,
          ...buildPersistPayload({
            themes: nextThemes,
            activeId: latest.activeCustomThemeId,
            enabled: latest.customThemesEnabled,
          }),
        });
      });
    },
    [performMutation, t],
  );

  const deleteTheme = useCallback(
    async (id: string): Promise<void> => {
      await performMutation((latest) => {
        const nextState = deleteThemeDomain(
          {
            themes: latest.customThemes,
            activeId: latest.activeCustomThemeId,
          },
          id,
        );
        return normalizeSettings({
          ...latest,
          ...buildPersistPayload({
            themes: nextState.themes,
            activeId: nextState.activeId,
            enabled: latest.customThemesEnabled,
          }),
        });
      });
    },
    [performMutation],
  );

  const activate = useCallback(
    async (target: string | null): Promise<void> => {
      await performMutation((latest) => {
        const nextState = activateDomain(
          {
            themes: latest.customThemes,
            activeId: latest.activeCustomThemeId,
          },
          target,
        );
        return normalizeSettings({
          ...latest,
          ...buildPersistPayload({
            themes: nextState.themes,
            activeId: nextState.activeId,
            enabled: latest.customThemesEnabled,
          }),
        });
      });
    },
    [performMutation],
  );

  const toggleEnabled = useCallback(async (): Promise<void> => {
    await performMutation((latest) =>
      normalizeSettings({
        ...latest,
        ...buildPersistPayload({
          themes: latest.customThemes,
          activeId: latest.activeCustomThemeId,
          enabled: !latest.customThemesEnabled,
        }),
      }),
    );
  }, [performMutation]);

  // ---- 导入 / 导出 --------------------------------------------------------

  const exportThemes = useCallback((): void => {
    const json = serializeExport(current.customThemes);
    const blob = new Blob([json], { type: "application/json" });
    const filename = `renewlet-themes-${formatLocalDate(new Date())}.json`;
    triggerDownload(filename, blob);
  }, [current.customThemes]);

  const parseImportFile = useCallback(
    async (
      file: File,
    ): Promise<{ themes: ParsedTheme[] } | { error: ImportError }> => {
      const text = await file.text();
      const result = parseImport(text);
      if (result.ok) {
        return { themes: result.value.themes };
      }
      return { error: result.error };
    },
    [],
  );

  const importThemes = useCallback(
    async (file: File, mode: "append" | "overwrite"): Promise<void> => {
      const text = await file.text();
      const parsed = parseImport(text);
      if (!parsed.ok) {
        const message = formatImportError(parsed.error, t);
        setError(message);
        throw new Error(message);
      }
      await performMutation((latest) => {
        const result = applyImport(
          {
            themes: latest.customThemes,
            activeId: latest.activeCustomThemeId,
          },
          { themes: parsed.value.themes },
          mode,
        );
        if (!result.ok) {
          // 把 applyImport 的拒绝（如 COUNT_LIMIT）转成 throw，让 performMutation
          // 的 try/catch 进入回滚路径并填充 error；不直接 setError 是为了保证
          // 内存状态、storage 与缓存的回滚由同一条路径触发。
          throw new Error(formatImportError(result.reason, t));
        }
        return normalizeSettings({
          ...latest,
          ...buildPersistPayload({
            themes: result.next.themes,
            activeId: result.next.activeId,
            enabled: latest.customThemesEnabled,
          }),
        });
      });
    },
    [performMutation, t],
  );

  const dismissError = useCallback(() => setError(null), []);

  return {
    themes,
    activeId,
    enabled,
    effectiveActive,
    isUrlBypass,
    isMutating: updateSettingsMutation.isPending,
    error,
    createTheme,
    updateTheme,
    deleteTheme,
    activate,
    toggleEnabled,
    exportThemes,
    importThemes,
    parseImportFile,
    dismissError,
  };
}
