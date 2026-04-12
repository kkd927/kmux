import type { NotificationItem } from "@kmux/proto";

import styles from "../styles/App.module.css";

interface NotificationsPanelProps {
  notifications: NotificationItem[];
  onClose: () => void;
  onJump: () => void;
  onClear: () => void;
}

export function NotificationsPanel(
  props: NotificationsPanelProps
): JSX.Element {
  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div
        className={styles.notifications}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <h2>Notifications</h2>
          <button aria-label="Close notifications" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className={styles.notificationActions}>
          <button onClick={props.onJump}>Jump latest unread</button>
          <button onClick={props.onClear}>Clear all</button>
        </div>
        <div className={styles.notificationList}>
          {props.notifications.map((notification) => (
            <div
              key={notification.id}
              className={styles.notificationItem}
              data-read={notification.read}
            >
              <div>{notification.title}</div>
              <div>{notification.message}</div>
              <div>{formatClock(notification.createdAt)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}
