export function formatShortcutLabel(
  shortcut: string | undefined,
  isMac: boolean
): string | undefined {
  if (!shortcut) {
    return undefined;
  }

  if (!isMac) {
    return shortcut.replaceAll("+", " + ");
  }

  return shortcut
    .split("+")
    .map((part) => {
      switch (part) {
        case "Meta":
          return "⌘";
        case "Shift":
          return "⇧";
        case "Ctrl":
          return "⌃";
        case "Alt":
          return "⌥";
        case "ArrowUp":
          return "↑";
        case "ArrowDown":
          return "↓";
        case "ArrowLeft":
          return "←";
        case "ArrowRight":
          return "→";
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join("");
}
