/**
 * 端到端测试用的 VS Code 主题变量（取自默认的 Dark Modern / Light Modern 主题的常用颜色），
 * 让 Chromium 里渲染出的界面接近真实 VS Code。
 */
const common = `--vscode-font-family: -apple-system, "Segoe WPC", "Segoe UI", system-ui, "Noto Sans CJK SC", sans-serif;
--vscode-font-size: 13px;
--vscode-editor-font-family: "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
--vscode-editor-font-size: 12px;`;

/**
 * VS Code 给每个 Webview 注入的默认样式里与插件相关的部分（插件自己的样式表在它之后加载）。
 * 主题的 textPreformat 色在很多深色主题里是橙色：插件没覆盖的地方会显示成橙色。
 */
export const VSCODE_DEFAULT_STYLES = `
code {
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-textPreformat-foreground);
  background-color: var(--vscode-textPreformat-background);
  padding: 1px 3px;
  border-radius: 4px;
}`;

export const DARK_THEME = `${common}
--vscode-textPreformat-foreground: #d7ba7d;
--vscode-textPreformat-background: #ffffff1a;
--vscode-foreground: #cccccc;
--vscode-descriptionForeground: #9d9d9d;
--vscode-sideBar-background: #181818;
--vscode-editor-background: #1f1f1f;
--vscode-editorWidget-background: #202020;
--vscode-input-background: #313131;
--vscode-input-foreground: #cccccc;
--vscode-input-border: #3c3c3c;
--vscode-input-placeholderForeground: #989898;
--vscode-focusBorder: #0078d4;
--vscode-button-background: #0078d4;
--vscode-button-foreground: #ffffff;
--vscode-button-hoverBackground: #026ec1;
--vscode-button-secondaryBackground: #313131;
--vscode-button-secondaryForeground: #cccccc;
--vscode-button-secondaryHoverBackground: #3c3c3c;
--vscode-textLink-foreground: #4daafc;
--vscode-textLink-activeForeground: #4daafc;
--vscode-textCodeBlock-background: #2b2b2b;
--vscode-textBlockQuote-border: #616161;
--vscode-widget-border: #313131;
--vscode-widget-shadow: rgba(0, 0, 0, 0.36);
--vscode-menu-background: #1f1f1f;
--vscode-menu-foreground: #cccccc;
--vscode-menu-border: #454545;
--vscode-menu-selectionBackground: #0078d4;
--vscode-menu-selectionForeground: #ffffff;
--vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.31);
--vscode-icon-foreground: #cccccc;
--vscode-errorForeground: #f85149;
--vscode-editorWarning-foreground: #cca700;
--vscode-inputValidation-warningBorder: #b89500;
--vscode-inputValidation-errorBorder: #be1100;
--vscode-progressBar-background: #0078d4;
--vscode-editorCursor-foreground: #aeafad;
--vscode-gitDecoration-addedResourceForeground: #81b88b;
--vscode-gitDecoration-deletedResourceForeground: #c74e39;`;

export const LIGHT_THEME = `${common}
--vscode-textPreformat-foreground: #a31515;
--vscode-textPreformat-background: #0000001a;
--vscode-foreground: #3b3b3b;
--vscode-descriptionForeground: #6f6f6f;
--vscode-sideBar-background: #f8f8f8;
--vscode-editor-background: #ffffff;
--vscode-editorWidget-background: #f8f8f8;
--vscode-input-background: #ffffff;
--vscode-input-foreground: #3b3b3b;
--vscode-input-border: #cecece;
--vscode-input-placeholderForeground: #767676;
--vscode-focusBorder: #005fb8;
--vscode-button-background: #005fb8;
--vscode-button-foreground: #ffffff;
--vscode-button-hoverBackground: #0258a8;
--vscode-button-secondaryBackground: #e5e5e5;
--vscode-button-secondaryForeground: #3b3b3b;
--vscode-button-secondaryHoverBackground: #cccccc;
--vscode-textLink-foreground: #005fb8;
--vscode-textLink-activeForeground: #005fb8;
--vscode-textCodeBlock-background: #f0f0f0;
--vscode-textBlockQuote-border: #e5e5e5;
--vscode-widget-border: #e5e5e5;
--vscode-widget-shadow: rgba(0, 0, 0, 0.16);
--vscode-menu-background: #ffffff;
--vscode-menu-foreground: #3b3b3b;
--vscode-menu-border: #cecece;
--vscode-menu-selectionBackground: #005fb8;
--vscode-menu-selectionForeground: #ffffff;
--vscode-toolbar-hoverBackground: rgba(184, 184, 184, 0.31);
--vscode-icon-foreground: #3b3b3b;
--vscode-errorForeground: #f85149;
--vscode-editorWarning-foreground: #bf8803;
--vscode-inputValidation-warningBorder: #bf8803;
--vscode-inputValidation-errorBorder: #be1100;
--vscode-progressBar-background: #005fb8;
--vscode-editorCursor-foreground: #000000;
--vscode-gitDecoration-addedResourceForeground: #587c0c;
--vscode-gitDecoration-deletedResourceForeground: #ad0707;`;
