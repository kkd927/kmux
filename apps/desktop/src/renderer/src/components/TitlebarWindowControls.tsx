import type { RendererPlatformDescriptor } from "../../../shared/platform/rendererPlatform";

import styles from "../styles/App.module.css";

interface TitlebarWindowControlsProps {
  windowChrome: RendererPlatformDescriptor["windowChrome"];
}

export function TitlebarWindowControls(
  props: TitlebarWindowControlsProps
): JSX.Element | null {
  if (props.windowChrome !== "custom") {
    return null;
  }

  return (
    <div className={styles.trafficLights}>
      <button
        aria-label="Close window"
        onClick={() => void window.kmux.windowControl("close")}
      />
      <button
        aria-label="Minimize window"
        onClick={() => void window.kmux.windowControl("minimize")}
      />
      <button
        aria-label="Maximize window"
        onClick={() => void window.kmux.windowControl("maximize")}
      />
    </div>
  );
}
