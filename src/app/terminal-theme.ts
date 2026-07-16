export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

const FALLBACK_THEME: TerminalTheme = {
  background: "#030a0f",
  foreground: "#e6f4fb",
  cursor: "#29b6f6",
  selectionBackground: "#1d3d4e",
};

export function readTerminalTheme(
  root: HTMLElement = document.documentElement,
): TerminalTheme {
  const styles = getComputedStyle(root);
  return {
    background: readCssToken(
      styles,
      "--qs-terminal-bg",
      FALLBACK_THEME.background,
    ),
    foreground: readCssToken(
      styles,
      "--qs-terminal-text",
      FALLBACK_THEME.foreground,
    ),
    cursor: readCssToken(styles, "--qs-accent", FALLBACK_THEME.cursor),
    selectionBackground: readCssToken(
      styles,
      "--qs-border",
      FALLBACK_THEME.selectionBackground,
    ),
  };
}

function readCssToken(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string,
): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}
