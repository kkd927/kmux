export function formatShortcutParts(
  shortcut: string | undefined,
  isMac: boolean
): string[] | undefined {
  if (!shortcut) {
    return undefined;
  }

  const parts = shortcut.split("+");
  if (!isMac) {
    return parts.map((part) => formatShortcutPart(part, false));
  }

  const formattedParts = parts.map((part) => formatShortcutPart(part, true));
  if (!formattedParts.includes("⌥")) {
    return formattedParts;
  }

  const keys = formattedParts.filter(
    (part) => part !== "⌃" && part !== "⌥" && part !== "⇧" && part !== "⌘"
  );
  return ["⌃", "⌥", "⇧", "⌘"].filter((part) =>
    formattedParts.includes(part)
  ).concat(keys);
}

export function formatShortcutLabel(
  shortcut: string | undefined,
  isMac: boolean,
  options: { separator?: string } = {}
): string | undefined {
  const parts = formatShortcutParts(shortcut, isMac);
  if (!parts) {
    return undefined;
  }

  if (!isMac) {
    return parts.join(options.separator ?? " + ");
  }

  return parts.join(options.separator ?? "");
}

function formatShortcutPart(part: string, isMac: boolean): string {
  if (!isMac) {
    return part.length === 1 ? part.toUpperCase() : part;
  }

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
}
