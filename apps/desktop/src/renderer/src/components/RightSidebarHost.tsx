import type { ReactNode } from "react";

import styles from "../styles/App.module.css";

interface RightSidebarHostProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  badge?: string;
  children: ReactNode;
  testId?: string;
}

export function RightSidebarHost(props: RightSidebarHostProps): JSX.Element {
  return (
    <aside
      className={styles.rightSidebar}
      data-testid={props.testId}
      aria-label={props.title}
      data-has-subtitle={props.subtitle ? "true" : "false"}
    >
      <div className={styles.rightSidebarHeader}>
        <div className={styles.rightSidebarHeaderCopy}>
          <div className={styles.rightSidebarTitleRow}>
            {props.eyebrow ? (
              <div className={styles.rightSidebarEyebrow}>{props.eyebrow}</div>
            ) : null}
            <h2 className={styles.rightSidebarTitle}>{props.title}</h2>
            {props.badge ? (
              <span className={styles.rightSidebarBadge}>{props.badge}</span>
            ) : null}
          </div>
          {props.subtitle ? (
            <div className={styles.rightSidebarSubtitle}>{props.subtitle}</div>
          ) : null}
        </div>
      </div>
      <div className={styles.rightSidebarBody}>{props.children}</div>
    </aside>
  );
}
