import type { ReactNode } from "react";

import styles from "../styles/App.module.css";

interface RightSidebarHostProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  badge?: string;
  tabs?: Array<{ key: string; label: string }>;
  activeTab?: string;
  onSelectTab?: (key: string) => void;
  children: ReactNode;
  testId?: string;
}

export function RightSidebarHost(props: RightSidebarHostProps): JSX.Element {
  const hasTabs = props.tabs && props.tabs.length > 0;

  return (
    <aside
      className={styles.rightSidebar}
      data-testid={props.testId}
      aria-label={props.title}
      data-has-tabs={hasTabs ? "true" : "false"}
      data-has-subtitle={props.subtitle ? "true" : "false"}
    >
      {hasTabs ? (
        <div className={styles.rightSidebarTabBar} role="tablist">
          {props.tabs!.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={props.activeTab === tab.key}
              className={styles.rightSidebarTabBarItem}
              data-active={props.activeTab === tab.key ? "true" : "false"}
              onClick={() => props.onSelectTab?.(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : (
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
      )}
      <div className={styles.rightSidebarBody}>{props.children}</div>
    </aside>
  );
}
