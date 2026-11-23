type CodiconName =
  | "add"
  | "bell"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "close"
  | "circle-large-outline"
  | "cursor-default"
  | "discard"
  | "edit"
  | "ellipsis"
  | "eye"
  | "gear"
  | "git-branch"
  | "grabber"
  | "hubot"
  | "inspect"
  | "layout-sidebar-left"
  | "layout-sidebar-right"
  | "lock"
  | "markdown"
  | "play"
  | "refresh"
  | "redo"
  | "run-all"
  | "screen-full"
  | "split-horizontal"
  | "split-vertical"
  | "sparkle"
  | "sync"
  | "terminal"
  | "trash"
  | "type-hierarchy-sub"
  | "warning"
  | "zoom-in"
  | "zoom-out"
  | "chevron-right"
  | "debug-start"
  | "debug-stop";

interface CodiconProps {
  name: CodiconName;
  className?: string;
}

export function Codicon(props: CodiconProps): JSX.Element {
  const className = [props.className, "codicon", `codicon-${props.name}`]
    .filter(Boolean)
    .join(" ");

  return <span aria-hidden="true" className={className} />;
}
