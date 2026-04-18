import { useUsageSelector } from "../hooks/useUsageView";
import styles from "../styles/TerminalPane.module.css";

interface SurfaceUsageAlertDotProps {
  surfaceId: string;
  fallbackVisible?: boolean;
}

export function SurfaceUsageAlertDot(
  props: SurfaceUsageAlertDotProps
): JSX.Element | null {
  const severity = useUsageSelector(
    (snapshot) => snapshot.surfaces[props.surfaceId]?.alertSeverity ?? "none"
  );

  const showingFallback = Boolean(props.fallbackVisible);
  const resolvedSeverity = showingFallback
    ? "warning"
    : severity;

  if (resolvedSeverity === "none") {
    return null;
  }

  const dotColor =
    resolvedSeverity === "urgent" ? "var(--danger)" : "var(--warning)";

  return (
    <span
      className={styles.usageAlertDot}
      data-severity={resolvedSeverity}
      data-testid={`surface-alert-dot-${props.surfaceId}`}
      style={{ backgroundColor: dotColor }}
      aria-label={
        showingFallback ? "Unread notification" : `Usage ${resolvedSeverity}`
      }
      title={
        showingFallback ? "Unread notification" : `Usage ${resolvedSeverity}`
      }
    />
  );
}
