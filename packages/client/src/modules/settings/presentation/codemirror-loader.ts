/**
 * codemirror-loader.ts 是 CodeMirror 6 的懒加载边界。
 *
 * 架构位置：仅供 `ThemeEditorDialog` 通过动态 `import('./codemirror-loader')` 调用
 * 一次，结果作为编辑器加载状态机的 `ready` 数据。Vite 会把该文件打成独立 chunk，
 * 主 chunk 不包含 CodeMirror，避免首屏携带 ~80–110 KiB 的编辑器代码。
 *
 * Caveat: 该文件**只**集中导入并 re-export CodeMirror 6 的最小子集
 * （`@codemirror/state` / `@codemirror/view` / `@codemirror/lang-css` /
 * `@codemirror/commands`），不允许引入 React 或任何 Renewlet 代码，否则
 * Vite tree-shaking 会把其它模块拖进同一个 chunk，破坏懒加载边界。
 */
export { EditorState, Compartment } from "@codemirror/state";
export { EditorView, keymap } from "@codemirror/view";
export { css } from "@codemirror/lang-css";
export { indentWithTab } from "@codemirror/commands";
export { indentUnit } from "@codemirror/language";
