import type { UpdaterState } from "@kmux/proto";

import { getTitlebarUpdaterAction } from "../../../shared/updaterPresentation";
import { useUpdaterState } from "../hooks/useUpdaterState";
import styles from "../styles/App.module.css";

interface TitlebarUpdateActionProps {
  className?: string;
}

interface TitlebarUpdateActionButtonProps {
  updaterState: UpdaterState;
  className?: string;
}

export function TitlebarUpdateAction(
  props: TitlebarUpdateActionProps
): JSX.Element | null {
  const updaterState = useUpdaterState();

  return (
    <TitlebarUpdateActionButton
      className={props.className}
      updaterState={updaterState}
    />
  );
}

export function TitlebarUpdateActionButton(
  props: TitlebarUpdateActionButtonProps
): JSX.Element | null {
  const action = getTitlebarUpdaterAction(props.updaterState);

  if (!action) {
    return null;
  }

  const className = [
    props.className,
    styles.titleUpdateIndicator,
    action.prominent ? styles.titleUpdateIndicatorProminent : "",
    action.progress === "indefinite"
      ? styles.titleUpdateIndicatorProgressIndefinite
      : "",
    action.progress === "percent" ? styles.titleUpdateIndicatorProgressPercent : ""
  ]
    .filter(Boolean)
    .join(" ");
  const handleClick = (): void => {
    if (action.disabled) {
      return;
    }

    if (action.action === "download") {
      void window.kmux.downloadAvailableUpdate();
      return;
    }

    void window.kmux.installDownloadedUpdate();
  };

  return (
    <button
      aria-label={action.ariaLabel}
      className={className}
      data-testid="titlebar-update-action"
      disabled={action.disabled}
      onClick={handleClick}
      title={action.title}
      type="button"
    >
      <span className={styles.titleUpdateIndicatorLabel}>{action.label}</span>
    </button>
  );
}
