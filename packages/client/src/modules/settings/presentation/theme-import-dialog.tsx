/**
 * theme-import-dialog.tsx 渲染“追加 / 覆盖”二选一的导入确认对话框。
 *
 * 架构位置：纯 presentation 组件，不发起任何持久化。仅在使用者点击按钮时
 * 通过 onConfirm(mode) 把选择上抛给 useCustomThemes.importThemes，由
 * controller 统一执行 applyImport + 写入 Settings_Store + 收敛 Theme_Storage。
 *
 * Caveat: 解析（parseImport）发生在打开对话框之前，因此 props.parsed 已是合法
 * 数据；本组件只负责展示主题数与名称预览（最多 10 条 + “…还有 N 条”）。
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n/I18nProvider";

const PREVIEW_MAX = 10;

export interface ThemeImportDialogProps {
  /** 弹窗是否打开（由上层控制）。 */
  open: boolean;
  /** 已解析的导入文件内容；为 null 时不渲染主体（loading / 解析失败的兜底）。 */
  parsed: { themes: { name: string; css: string }[] } | null;
  /** 弹窗开关回调。 */
  onOpenChange: (open: boolean) => void;
  /** 使用者选择导入方式后的回调；mode 由按钮决定，组件不发起持久化。 */
  onConfirm: (mode: "append" | "overwrite") => Promise<void>;
}

/** 导入主题确认对话框（追加 / 覆盖二选一）。 */
export function ThemeImportDialog({ open, parsed, onOpenChange, onConfirm }: ThemeImportDialogProps) {
  const { t } = useI18n();

  const themes = parsed?.themes ?? [];
  const total = themes.length;
  const previewItems = themes.slice(0, PREVIEW_MAX);
  const remaining = Math.max(0, total - previewItems.length);

  const handleConfirm = (mode: "append" | "overwrite") => {
    void onConfirm(mode);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("customThemes.import.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("customThemes.import.dialogDescription", { count: total })}
          </DialogDescription>
        </DialogHeader>

        {parsed ? (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <p className="text-sm font-medium text-foreground">
                {t("customThemes.import.previewTitle")}
              </p>
              <ul className="grid gap-1 rounded-md border border-border bg-secondary/30 p-3 text-sm text-muted-foreground">
                {previewItems.map((theme, index) => (
                  <li key={`${index}-${theme.name}`} className="truncate">
                    {theme.name}
                  </li>
                ))}
                {remaining > 0 ? (
                  <li className="text-xs text-muted-foreground/80">
                    {t("customThemes.import.previewMore", { count: remaining })}
                  </li>
                ) : null}
              </ul>
            </div>

            <div className="grid gap-2 rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
              <p>{t("customThemes.import.appendDescription")}</p>
              <p>{t("customThemes.import.overwriteDescription")}</p>
            </div>
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="w-full sm:w-auto"
          >
            {t("customThemes.import.cancel")}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => handleConfirm("append")}
            disabled={total === 0}
            className="w-full sm:w-auto"
          >
            {t("customThemes.import.append")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => handleConfirm("overwrite")}
            disabled={total === 0}
            className="w-full sm:w-auto"
          >
            {t("customThemes.import.overwrite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
