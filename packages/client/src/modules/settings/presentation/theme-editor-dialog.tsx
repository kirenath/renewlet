/**
 * theme-editor-dialog.tsx 是 Custom_CSS_Theme 的新建/编辑对话框。
 *
 * 架构位置：纯 presentation 组件，不发起任何持久化。它只负责
 * - 懒加载 CodeMirror 6（`./codemirror-loader`），10 秒内加载失败降级为 `<textarea>`；
 * - 在编辑器中维护 `name` / `css` 草稿态；
 * - 调用 `validateThemeInput`（保持与 controller / schema 的同源校验）控制提交按钮 disabled；
 * - 提交时把 `{ name, css }` 上抛给调用方 `onSubmit`，由 `useCustomThemes` 统一执行
 *   create/update + Settings_Store 写入 + Theme_Storage 收敛。
 *
 * Caveat:
 * - 编辑器内部状态机 `loading | ready | failed` 互斥穷尽（design.md §3）。
 * - 初次失败显示降级提示；`ready` 中运行期异常通过 ErrorBoundary 捕获后转 textarea 但
 *   **不**显示降级提示，与初始失败区分（Requirement 11.7）。
 * - `mode === 'create'` 且 `currentCount >= themeCountLimit` 时，整体禁用提交按钮 +
 *   显示数量上限提示；调用方应优先在 toolbar 上禁掉「新建」按钮避免打开此 dialog。
 *
 * Requirements: 2.1, 2.6, 2.7, 2.8, 2.10, 3.1, 3.5, 3.6, 11.1, 11.2, 11.3, 11.4,
 * 11.5, 11.6, 11.7
 */
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/I18nProvider";
import {
  byteLength,
  CSS_SIZE_LIMIT,
  THEME_NAME_LIMIT,
  validateThemeInput,
} from "@/modules/settings/domain/custom-theme";

/**
 * 编辑器组件内部加载状态机。
 *
 * - `loading`：动态 import 进行中或 10 秒计时器尚未触发。
 * - `ready`：CodeMirror 模块加载成功；持有 `loaded` 引用以构造 EditorView。
 * - `failed`：初次加载失败（`reason: 'timeout' | 'import-error'`），UI 显示降级提示。
 * - `runtime-failed`：`ready` 之后 ErrorBoundary 捕获到的运行期异常，与 `failed`
 *   行为基本相同（textarea 兜底）但 **不**展示降级提示文案，避免与初始失败混淆。
 */
type LoadedCodeMirror = typeof import("./codemirror-loader");

type EditorState =
  | { kind: "loading" }
  | { kind: "ready"; loaded: LoadedCodeMirror }
  | { kind: "failed"; reason: "timeout" | "import-error" }
  | { kind: "runtime-failed" };

const CODEMIRROR_LOAD_TIMEOUT_MS = 10_000;

export interface ThemeEditorDialogProps {
  /** 弹窗是否打开。 */
  open: boolean;
  /** 弹窗开关回调。 */
  onOpenChange: (open: boolean) => void;
  /** 创建 vs 编辑。`edit` 模式下必须提供 `initial`。 */
  mode: "create" | "edit";
  /** `edit` 模式必填：被编辑主题的当前 `name` / `css`。 */
  initial?: { name: string; css: string };
  /**
   * 提交回调。调用方负责把结果写入 Settings_Store / Theme_Storage 并
   * 在成功后关闭 dialog；失败时本组件不会自动关闭，允许保留输入。
   */
  onSubmit: (next: { name: string; css: string }) => Promise<void>;
  /** 主题数量上限（来自 `THEME_COUNT_LIMIT`）。 */
  themeCountLimit: number;
  /** CSS 字节上限（来自 `CSS_SIZE_LIMIT`）。 */
  cssSizeLimit: number;
  /** Name 字符上限（来自 `THEME_NAME_LIMIT`）。 */
  themeNameLimit: number;
  /** 当前 Custom_Theme_Collection 长度（用于 `create` 模式上限提示）。 */
  currentCount: number;
}

/** Name / CSS 字段当前的校验错误（与 `validateThemeInput` 错误码对齐）。 */
interface FieldErrors {
  name: "NAME_EMPTY" | "NAME_TOO_LONG" | null;
  css: "CSS_TOO_LARGE" | null;
}

export function ThemeEditorDialog(props: ThemeEditorDialogProps) {
  const {
    open,
    onOpenChange,
    mode,
    initial,
    onSubmit,
    themeCountLimit,
    cssSizeLimit,
    themeNameLimit,
    currentCount,
  } = props;

  const { t } = useI18n();

  const [name, setName] = useState<string>(initial?.name ?? "");
  const [css, setCss] = useState<string>(initial?.css ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [editorState, setEditorState] = useState<EditorState>({ kind: "loading" });

  // 当 dialog 由「关闭 → 打开」切换时，按 props.initial 重置草稿态；
  // 关闭时不动 state，避免提交失败保留输入的体验被破坏（Requirement 2.10 / 3.6）。
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setName(initial?.name ?? "");
      setCss(initial?.css ?? "");
      setSubmitting(false);
    }
    wasOpenRef.current = open;
  }, [open, initial]);

  // 编辑器懒加载状态机：只在 `open === true` 时启动 import，关闭/卸载时取消。
  // `failed` 一旦确定就不再重试本次会话（Requirement 11.6 的精神：避免反复尝试
  // 失败的 chunk 拖慢 UI）。`ready` 同样保持稳定。
  useEffect(() => {
    if (!open) return;
    if (editorState.kind !== "loading") return;

    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => {
      if (ac.signal.aborted) return;
      ac.abort();
      setEditorState({ kind: "failed", reason: "timeout" });
    }, CODEMIRROR_LOAD_TIMEOUT_MS);

    void import("./codemirror-loader")
      .then((loaded) => {
        if (ac.signal.aborted) return;
        clearTimeout(timeoutHandle);
        ac.abort();
        setEditorState({ kind: "ready", loaded });
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        clearTimeout(timeoutHandle);
        ac.abort();
        setEditorState({ kind: "failed", reason: "import-error" });
      });

    return () => {
      clearTimeout(timeoutHandle);
      ac.abort();
    };
  }, [open, editorState.kind]);

  // 校验 + 字节计数（同帧重算，Requirement 11.3）。
  const cssBytes = useMemo(() => byteLength(css), [css]);
  const errors = useMemo<FieldErrors>(() => {
    const validation = validateThemeInput(name, css, 0);
    if (validation.ok) {
      return { name: null, css: null };
    }
    if (validation.code === "NAME_EMPTY") return { name: "NAME_EMPTY", css: null };
    if (validation.code === "NAME_TOO_LONG") return { name: "NAME_TOO_LONG", css: null };
    if (validation.code === "CSS_TOO_LARGE") return { name: null, css: "CSS_TOO_LARGE" };
    // COUNT_LIMIT 不属于字段级校验：currentCount 在外部独立判断。
    return { name: null, css: null };
  }, [name, css]);

  const isCountLimited = mode === "create" && currentCount >= themeCountLimit;

  const canSubmit =
    !submitting &&
    !isCountLimited &&
    errors.name === null &&
    errors.css === null;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({ name, css });
    } finally {
      // 失败时调用方决定是否关闭 dialog；本组件统一把按钮恢复可点。
      setSubmitting(false);
    }
  }, [canSubmit, css, name, onSubmit]);

  const namePercent = Math.min(100, Math.round((name.length / themeNameLimit) * 100));
  // 计数文案：CSS 体积百分比保留 1 位小数，与 design.md §3 的 `xxxxx / 102400 (yy.y%)` 一致。
  const cssPercentText = ((cssBytes / cssSizeLimit) * 100).toFixed(1);

  const titleKey =
    mode === "create"
      ? ("customThemes.editor.titleCreate" as const)
      : ("customThemes.editor.titleEdit" as const);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="custom-theme-name">{t("customThemes.editor.nameLabel")}</Label>
              <span
                className="text-xs text-muted-foreground"
                aria-label={`name ${name.length}/${themeNameLimit} (${namePercent}%)`}
              >
                {t("customThemes.editor.nameCounter", {
                  length: name.length,
                  limit: themeNameLimit,
                })}
              </span>
            </div>
            <Input
              id="custom-theme-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("customThemes.editor.namePlaceholder")}
              maxLength={themeNameLimit * 4}
              aria-invalid={errors.name !== null}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {errors.name === "NAME_EMPTY" ? (
              <p role="alert" className="text-xs text-destructive">
                {t("customThemes.errors.name.empty")}
              </p>
            ) : null}
            {errors.name === "NAME_TOO_LONG" ? (
              <p role="alert" className="text-xs text-destructive">
                {t("customThemes.errors.name.tooLong", { limit: themeNameLimit })}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="custom-theme-css">{t("customThemes.editor.cssLabel")}</Label>
              <span
                className="text-xs text-muted-foreground"
                aria-label={`css ${cssBytes}/${cssSizeLimit} (${cssPercentText}%)`}
              >
                {t("customThemes.editor.cssCounter", {
                  bytes: cssBytes,
                  limit: cssSizeLimit,
                  percent: cssPercentText,
                })}
              </span>
            </div>

            <CodeEditor
              editorId="custom-theme-css"
              state={editorState}
              value={css}
              onChange={setCss}
              onRuntimeError={() => setEditorState({ kind: "runtime-failed" })}
              placeholder={t("customThemes.editor.cssPlaceholder")}
            />

            {editorState.kind === "failed" ? (
              <p className="text-xs text-muted-foreground">
                {t("customThemes.editor.fallback")}
              </p>
            ) : null}

            {errors.css === "CSS_TOO_LARGE" ? (
              <p role="alert" className="text-xs text-destructive">
                {t("customThemes.errors.css.tooLarge", { limit: cssSizeLimit })}
              </p>
            ) : null}
          </div>

          {isCountLimited ? (
            <p role="alert" className="text-xs text-destructive">
              {t("customThemes.errors.count.limit", { limit: themeCountLimit })}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="w-full sm:w-auto"
          >
            {t("customThemes.editor.cancel")}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={!canSubmit}
            className="w-full sm:w-auto"
          >
            {submitting ? t("customThemes.editor.saving") : t("customThemes.editor.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 内部子组件
// ────────────────────────────────────────────────────────────────────────────

interface CodeEditorProps {
  editorId: string;
  state: EditorState;
  value: string;
  onChange: (next: string) => void;
  onRuntimeError: () => void;
  placeholder: string;
}

/**
 * 根据当前 EditorState 选择 CodeMirror 视图或 textarea 兜底。
 *
 * - `loading`：渲染等高 placeholder（`<div>`），避免布局抖动。
 * - `ready`：通过 ErrorBoundary 包住 CodeMirror 视图；运行期异常上报给上层切到
 *   `runtime-failed`，按 textarea 渲染但不显示降级提示（Requirement 11.7）。
 * - `failed` / `runtime-failed`：渲染 textarea，含 Tab → 两个空格的 keydown 处理。
 */
function CodeEditor(props: CodeEditorProps) {
  const { editorId, state, value, onChange, onRuntimeError, placeholder } = props;

  if (state.kind === "loading") {
    return (
      <div
        id={editorId}
        aria-hidden="true"
        className="min-h-[24rem] rounded-md border border-input bg-background"
      />
    );
  }

  if (state.kind === "ready") {
    return (
      <CodeMirrorErrorBoundary onError={onRuntimeError}>
        <CodeMirrorView
          editorId={editorId}
          loaded={state.loaded}
          value={value}
          onChange={onChange}
        />
      </CodeMirrorErrorBoundary>
    );
  }

  // `failed` / `runtime-failed` 共用 textarea 兜底；提示文案由父级根据 state 区分。
  return (
    <TextareaFallback
      editorId={editorId}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  );
}

interface CodeMirrorViewProps {
  editorId: string;
  loaded: LoadedCodeMirror;
  value: string;
  onChange: (next: string) => void;
}

/**
 * CodeMirror 6 视图封装。
 *
 * - 用 `keymap.of([indentWithTab])` + `EditorState.tabSize.of(2)` +
 *   `indentUnit.of('  ')` 满足 Requirement 11.2（Tab 插入两个空格）。
 * - `css()` 提供 CSS 高亮 / 撤销栈。
 * - 容器 `<div>` 使用 `font-mono` + 显式关闭 spellcheck/autocorrect/autocapitalize
 *   （Requirement 11.1）。CodeMirror 内部的 `.cm-content` 是 contenteditable，
 *   这些 attribute 通过 `contentAttributes` facet 同步过去。
 * - `value` props 变化时若与编辑器当前内容不同则一次性 dispatch 替换，避免
 *   外部触发 reset 时游标错乱。
 */
function CodeMirrorView(props: CodeMirrorViewProps) {
  const { editorId, loaded, value, onChange } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<InstanceType<LoadedCodeMirror["EditorView"]> | null>(null);
  // `onChange` ref 让 EditorView updateListener 始终读到最新闭包，无需重建视图。
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { EditorState, EditorView, keymap, css, indentWithTab, indentUnit } = loaded;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const contentAttributes = EditorView.contentAttributes.of({
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
    });

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([indentWithTab]),
          EditorState.tabSize.of(2),
          indentUnit.of("  "),
          css(),
          updateListener,
          contentAttributes,
          EditorView.theme({
            "&": { height: "24rem" },
            ".cm-scroller": { fontFamily: "inherit" },
          }),
        ],
      }),
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `loaded` 引用在状态机进入 `ready` 后保持稳定；初始 doc 只用一次。
    // 后续 `value` 变化通过下面单独的 effect 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // 外部 `value` 变化（例如 dialog 重新打开重置）时，把内容同步进编辑器。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      id={editorId}
      ref={containerRef}
      className="min-h-[24rem] overflow-hidden rounded-md border border-input bg-background font-mono text-sm"
      spellCheck={false}
      // 这两个属性虽是 textarea/input 专用，但对 contenteditable 子节点也起辅助作用，
      // 与 Requirement 11.1 的“关闭浏览器辅助行为”意图一致。
      autoCorrect="off"
      autoCapitalize="off"
    />
  );
}

interface TextareaFallbackProps {
  editorId: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}

/**
 * 没有 CodeMirror 时的兜底：等宽 `<textarea>` + 自实现 Tab 缩进。
 *
 * Requirement 11.1 / 11.2 / 11.3 / 11.6：
 * - 关闭 spellcheck / autoCorrect / autoCapitalize；
 * - Tab 键插入两个空格；
 * - 编辑流程仍可保存（提交流程在父级）。
 */
function TextareaFallback(props: TextareaFallbackProps) {
  const { editorId, value, onChange, placeholder } = props;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Tab") return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const target = event.currentTarget;
      const { selectionStart, selectionEnd } = target;
      target.setRangeText("  ", selectionStart, selectionEnd, "end");
      // setRangeText 直接改 DOM value，但 React 受控组件需要 onChange 同步 state。
      onChange(target.value);
    },
    [onChange],
  );

  return (
    <textarea
      id={editorId}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      rows={16}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      className="min-h-[24rem] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-relaxed ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    />
  );
}

interface CodeMirrorErrorBoundaryProps {
  onError: () => void;
  children: ReactNode;
}

interface CodeMirrorErrorBoundaryState {
  hasError: boolean;
}

/**
 * CodeMirror 视图的错误边界。
 *
 * 一旦 `ready` 状态下 CodeMirror 抛出运行期异常，边界把状态传给父组件
 * 让它切到 `runtime-failed`，textarea 兜底接管。父组件负责保证此切换不
 * 显示降级提示（Requirement 11.7）。
 */
class CodeMirrorErrorBoundary extends Component<
  CodeMirrorErrorBoundaryProps,
  CodeMirrorErrorBoundaryState
> {
  state: CodeMirrorErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CodeMirrorErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo) {
    this.props.onError();
  }

  render() {
    if (this.state.hasError) {
      // 父组件已切换到 `runtime-failed`，本边界返回 null 让父组件渲染 textarea。
      return null;
    }
    return this.props.children;
  }
}

// 这两个常量被 re-export 给调用方做 props 类型校验时偶尔会用到。
export { CSS_SIZE_LIMIT, THEME_NAME_LIMIT };
