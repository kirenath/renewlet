/**
 * custom-theme-section.tsx 渲染设置页里的「自定义 CSS 主题」区块。
 *
 * 架构位置：纯 presentation 组件。所有写入路径都委托给 `useCustomThemes`
 * controller，controller 内部统一执行 Settings_Store 写入 + Theme_Storage
 * 收敛 + 失败回滚（Requirement 9.3 / 9.5）。本组件仅负责：
 *
 * - 顶部行：Master_Switch 总闸开关 + URL 旁路徽章；
 * - 工具栏：新建 / 导入 / 导出 入口；
 * - 主题列表：每行展示 radio + name + CSS 体积 + 相对更新时间 + 激活/编辑/删除 按钮；
 * - 删除流程：`<AlertDialog>` 双确认，默认焦点在「取消」按钮（Requirement 4.4）；
 * - 错误提示：当 controller.error 非空时持续展示一条 destructive Alert，
 *   含 dismiss 按钮（Requirement 9.4）；
 * - 数量上限：达到 20 条时禁用「新建主题」并旁路 tooltip 给出原因。
 *
 * Caveat:
 * - 不在此组件直接调用 useUpdateSettings / Theme_Storage：避免破坏
 *   presentation -> application -> domain 的依赖方向。
 * - 删除 / 编辑 dialog 的开关由本组件维护本地 state（`pendingDeleteId`/`editingTheme`），
 *   一旦动作成功（onSubmit 解析为 resolved），由本组件关闭 dialog；失败时
 *   保留输入由 ThemeEditorDialog 自行处理（Requirement 2.10 / 3.6）。
 *
 * Requirements: 2.1, 2.5, 2.9, 4.1, 4.2, 4.4, 4.5, 5.1, 5.2, 7.1, 7.6, 9.4, 10.1, 10.2
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";
import { Download, Plus, Upload, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import {
  byteLength,
  CSS_SIZE_LIMIT,
  THEME_COUNT_LIMIT,
  THEME_NAME_LIMIT,
  type ParsedTheme,
} from "@/modules/settings/domain/custom-theme";
import type { CustomCssTheme } from "@/types/subscription";

import { useCustomThemes } from "../application/use-custom-themes";
import { ThemeEditorDialog } from "./theme-editor-dialog";
import { ThemeImportDialog } from "./theme-import-dialog";

const KIB = 1024;

/**
 * 把字节数格式化成 `1.2 KiB / 100 KiB` 的形式。
 *
 * - 总是用 1 位小数显示当前体积；上限以整数 KiB 展示。
 * - 设计文档 §2 与 i18n key `customThemes.list.cssSize` 对齐：传入的 `size` 已经
 *   是该函数的返回值，不再二次包装。
 */
function formatCssSize(bytes: number): string {
  const usedKiB = (bytes / KIB).toFixed(1);
  const limitKiB = Math.round(CSS_SIZE_LIMIT / KIB);
  return `${usedKiB} KiB / ${limitKiB} KiB`;
}

/** 从 i18n locale 选择 date-fns 的 locale 数据。 */
function dateFnsLocale(locale: string) {
  return locale === "zh-CN" ? zhCN : enUS;
}

export function CustomThemeSection() {
  const { t, locale } = useI18n();
  const controller = useCustomThemes();
  const {
    themes,
    activeId,
    enabled,
    isUrlBypass,
    isMutating,
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
  } = controller;

  // ---- 编辑器 / 导入 / 删除 dialog 的本地状态 ----------------------------
  // 本地 state 仅控制 UI 显隐与编辑预填数据；所有持久化由 controller 完成。
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [editorInitial, setEditorInitial] = useState<{
    id: string | null;
    name: string;
    css: string;
  }>({ id: null, name: "", css: "" });

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [parsedImport, setParsedImport] = useState<{
    themes: ParsedTheme[];
  } | null>(null);

  // 隐藏的 file input 用作「导入」按钮触发器；ref 让我们能从工具栏的可见
  // Button 上手动调起原生选择器，保持视觉一致。
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 删除对话框的 Cancel 按钮 ref：dialog 打开时主动 setFocus，符合 Req 4.4
  // 「默认焦点位于取消」的可访问性约束。
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (pendingDeleteId === null) return;
    // Radix 在 onOpenAutoFocus 内部会决定初始焦点；用 microtask 在它之后再
    // 显式 focus 取消按钮，确保表现与设计文档一致（即使将来 Radix 默认行为变化）。
    const handle = window.setTimeout(() => {
      cancelButtonRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [pendingDeleteId]);

  const isAtCountLimit = themes.length >= THEME_COUNT_LIMIT;

  const pendingDeleteTheme = useMemo<CustomCssTheme | null>(() => {
    if (pendingDeleteId === null) return null;
    return themes.find((theme) => theme.id === pendingDeleteId) ?? null;
  }, [pendingDeleteId, themes]);

  const editingTheme = useMemo<CustomCssTheme | null>(() => {
    if (editorMode !== "edit" || editorInitial.id === null) return null;
    return themes.find((theme) => theme.id === editorInitial.id) ?? null;
  }, [editorInitial.id, editorMode, themes]);

  // ---- 行为回调 -----------------------------------------------------------

  const handleOpenCreate = useCallback(() => {
    setEditorMode("create");
    setEditorInitial({ id: null, name: "", css: "" });
    setEditorOpen(true);
  }, []);

  const handleOpenEdit = useCallback((theme: CustomCssTheme) => {
    setEditorMode("edit");
    setEditorInitial({ id: theme.id, name: theme.name, css: theme.css });
    setEditorOpen(true);
  }, []);

  const handleEditorSubmit = useCallback(
    async (input: { name: string; css: string }): Promise<void> => {
      // controller 已经把校验与 normalize 处理好；本组件只负责把 mode + id
      // 路由到对应动作，并在成功后关闭 dialog。
      if (editorMode === "create") {
        await createTheme(input);
      } else if (editorInitial.id !== null) {
        await updateTheme(editorInitial.id, input);
      } else {
        return;
      }
      setEditorOpen(false);
    },
    [createTheme, editorInitial.id, editorMode, updateTheme],
  );

  const handleConfirmDelete = useCallback(async (): Promise<void> => {
    if (pendingDeleteId === null) return;
    try {
      await deleteTheme(pendingDeleteId);
    } finally {
      // 不论成功失败都关闭 dialog：失败时 controller 已经把错误写入
      // controller.error，由本组件的 Alert 区域持续展示（Req 9.4）。
      setPendingDeleteId(null);
    }
  }, [deleteTheme, pendingDeleteId]);

  const handleToggleActivate = useCallback(
    async (theme: CustomCssTheme): Promise<void> => {
      if (activeId === theme.id) {
        await activate(null);
      } else {
        await activate(theme.id);
      }
    },
    [activate, activeId],
  );

  // 缓存「待导入文件」用于 onConfirm 时 controller.importThemes 的二次解析；
  // controller.importThemes 内部会再 parse 一次（保证逻辑收敛在一处），所以
  // 这里把 file 透传而非把 parsed 结果透传。
  const pendingImportFileRef = useRef<File | null>(null);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportConfirm = useCallback(
    async (mode: "append" | "overwrite"): Promise<void> => {
      const file = pendingImportFileRef.current;
      if (!file || !parsedImport) {
        // 兜底：理论上 dialog 打开 ⇒ pendingImportFileRef 必有值；
        // 如果走到这里说明状态被并发清空，关闭 dialog 即可。
        setImportDialogOpen(false);
        setParsedImport(null);
        return;
      }
      try {
        await importThemes(file, mode);
        setImportDialogOpen(false);
        setParsedImport(null);
        pendingImportFileRef.current = null;
      } catch {
        // 失败由 controller.error 持续展示；保留 dialog 让使用者重试或取消。
      }
    },
    [importThemes, parsedImport],
  );

  const handleImportDialogOpenChange = useCallback((open: boolean) => {
    setImportDialogOpen(open);
    if (!open) {
      // dialog 关闭时清理 parsed + ref，避免下一次「导入」按钮触发文件选择器
      // 时仍能看到上次的预览。
      setParsedImport(null);
      pendingImportFileRef.current = null;
    }
  }, []);

  // 让「导入」按钮在选完文件后路由到 parse → 弹窗 → onConfirm 三步：
  // - parse 成功：缓存 file 与 parsed 数据，弹出 ThemeImportDialog；
  // - parse 失败：复用 controller.importThemes 的错误格式化路径（它内部会再
  //   parse 一次），让 controller.error 持续展示统一的可读文案。
  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      const result = await parseImportFile(file);
      if ("error" in result) {
        // 错误路径：复用 controller.importThemes 让错误流入 controller.error
        // （mode 在 parse 失败时不会被使用，传 "append" 仅满足类型）。
        try {
          await importThemes(file, "append");
        } catch {
          /* 错误已写入 controller.error。 */
        }
        return;
      }
      pendingImportFileRef.current = file;
      setParsedImport({ themes: result.themes });
      setImportDialogOpen(true);
    },
    [importThemes, parseImportFile],
  );

  // 返回的 JSX --------------------------------------------------------------

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">
          {t("customThemes.section.title")}
        </h2>
        {isUrlBypass ? (
          <Badge variant="outline" className="border-amber-500/40 text-amber-600">
            {t("customThemes.section.bypassActive")}
          </Badge>
        ) : null}
      </div>

      {/* 顶部行：Master_Switch 总闸 ------------------------------------- */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3 rounded-md border border-border/60 bg-secondary/30 p-4">
        <div className="grid gap-1">
          <span className="text-sm font-medium text-foreground">
            {t("customThemes.section.master")}
          </span>
          <p className="text-xs text-muted-foreground">
            {isUrlBypass
              ? t("customThemes.section.bypassHelp")
              : t("customThemes.section.masterHelp")}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={() => {
            void toggleEnabled();
          }}
          disabled={isMutating}
          aria-label={t("customThemes.section.master")}
        />
      </div>

      {/* 工具栏 --------------------------------------------------------- */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {isAtCountLimit ? (
          // 达到上限时给出 tooltip 解释为何按钮不可点。Tooltip 套在 span 上是
          // 因为 Radix 的 Tooltip 不能直接接受 disabled 的 button（pointer events
          // 会被 disabled 吞掉）；包一层 span 既能保留 tooltip 行为，又不会让
          // 屏幕阅读器误以为按钮可用。
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled
                  aria-disabled
                  className="gap-1"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {t("customThemes.section.create")}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("customThemes.errors.count.limit", { limit: THEME_COUNT_LIMIT })}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="gap-1"
            onClick={handleOpenCreate}
            disabled={isMutating}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t("customThemes.section.create")}
          </Button>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={handleImportClick}
          disabled={isMutating}
        >
          <Upload className="h-4 w-4" aria-hidden />
          {t("customThemes.section.import")}
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => exportThemes()}
          disabled={themes.length === 0}
        >
          <Download className="h-4 w-4" aria-hidden />
          {t("customThemes.section.export")}
        </Button>

        <span
          className="ml-auto text-xs text-muted-foreground"
          aria-live="polite"
        >
          {t("customThemes.section.countSummary", {
            count: themes.length,
            limit: THEME_COUNT_LIMIT,
          })}
        </span>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(event) => {
            void handleFileChange(event);
          }}
        />
      </div>

      {/* 错误提示 ------------------------------------------------------- */}
      {error ? (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <p className="leading-relaxed">{error}</p>
          <button
            type="button"
            onClick={dismissError}
            aria-label={t("common.cancel")}
            className="shrink-0 rounded-md p-1 text-destructive hover:bg-destructive/15"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {/* 主题列表 ------------------------------------------------------- */}
      {themes.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-secondary/20 p-6 text-center text-sm text-muted-foreground">
          {t("customThemes.list.empty")}
        </div>
      ) : (
        <ul className="grid gap-3" role="list">
          {themes.map((theme) => {
            const isActive = activeId === theme.id;
            const sizeText = formatCssSize(byteLength(theme.css));
            const updatedRelative = (() => {
              const parsed = new Date(theme.updatedAt);
              if (Number.isNaN(parsed.getTime())) return theme.updatedAt;
              return formatDistanceToNow(parsed, {
                addSuffix: true,
                locale: dateFnsLocale(locale),
              });
            })();
            return (
              <li
                key={theme.id}
                className={cn(
                  "grid gap-3 rounded-md border border-border bg-background p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center",
                  isActive && "border-primary/40 bg-primary/5",
                )}
              >
                <label
                  className="flex cursor-pointer items-center gap-3"
                  // radio 的 input 用原生元素以保证可访问性；点击 label 触发
                  // toggle 行为与「激活/取消激活」按钮等价。
                >
                  <input
                    type="radio"
                    name="custom-theme-active"
                    checked={isActive}
                    onChange={() => {
                      void handleToggleActivate(theme);
                    }}
                    disabled={isMutating}
                    aria-label={
                      isActive
                        ? t("customThemes.list.deactivate")
                        : t("customThemes.list.activate")
                    }
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                </label>

                <div className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      {theme.name}
                    </span>
                    {isActive ? (
                      <Badge variant="default" className="bg-primary/15 text-primary">
                        {t("customThemes.list.activeBadge")}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {t("customThemes.list.cssSize", { size: sizeText })}
                    </span>
                    <span>
                      {t("customThemes.list.updatedAt", { time: updatedRelative })}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <Button
                    type="button"
                    variant={isActive ? "outline" : "secondary"}
                    size="sm"
                    onClick={() => {
                      void handleToggleActivate(theme);
                    }}
                    disabled={isMutating}
                  >
                    {isActive
                      ? t("customThemes.list.deactivate")
                      : t("customThemes.list.activate")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleOpenEdit(theme)}
                    disabled={isMutating}
                  >
                    {t("customThemes.list.edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => setPendingDeleteId(theme.id)}
                    disabled={isMutating}
                  >
                    {t("customThemes.list.delete")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 编辑器 dialog -------------------------------------------------- */}
      <ThemeEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        mode={editorMode}
        // 编辑模式：使用最新的 theme（避免使用者在 dialog 打开后另一个动作
        // 修改了同一条主题，旧 initial 仍被保留导致提交时覆盖最新内容）。
        initial={editorMode === "edit" && editingTheme
          ? { name: editingTheme.name, css: editingTheme.css }
          : { name: editorInitial.name, css: editorInitial.css }}
        onSubmit={handleEditorSubmit}
        themeCountLimit={THEME_COUNT_LIMIT}
        cssSizeLimit={CSS_SIZE_LIMIT}
        themeNameLimit={THEME_NAME_LIMIT}
        currentCount={themes.length}
      />

      {/* 导入 dialog ---------------------------------------------------- */}
      <ThemeImportDialog
        open={importDialogOpen}
        parsed={parsedImport}
        onOpenChange={handleImportDialogOpenChange}
        onConfirm={handleImportConfirm}
      />

      {/* 删除确认 dialog ------------------------------------------------ */}
      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent className="border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("customThemes.list.deleteDialogTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("customThemes.list.deleteDialogDescription", {
                name: pendingDeleteTheme?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelButtonRef}>
              {t("customThemes.list.deleteCancel")}
            </AlertDialogCancel>
            {/* 不用 AlertDialogAction：那个组件会自动关闭 dialog；我们要让
                 关闭与 controller 的 mutation 解耦，方便错误时让 dialog 自然
                 通过 onOpenChange 收尾，避免 mutation 失败时 dialog 已经关闭
                 但错误状态被吞掉。 */}
            <button
              type="button"
              className={cn(
                buttonVariants({ variant: "destructive" }),
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
              disabled={isMutating || pendingDeleteTheme === null}
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmDelete();
              }}
            >
              {t("customThemes.list.deleteConfirm")}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
