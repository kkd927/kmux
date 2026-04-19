import styles from "../styles/TerminalPane.module.css";

interface SurfaceUsageAlertDotProps {
  fallbackVisible?: boolean;
}

export function SurfaceUsageAlertDot(
  props: SurfaceUsageAlertDotProps
): JSX.Element | null {
  if (!props.fallbackVisible) {
    return null;
  }

  return (
    <span
      className={styles.usageAlertDot}
      data-severity="warning"
      style={{ backgroundColor: "var(--warning)" }}
      aria-label="Unread notification"
      title="Unread notification"
    />
  );
}
