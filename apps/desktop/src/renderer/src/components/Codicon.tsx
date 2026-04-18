type CodiconName =
  | "add"
  | "bell"
  | "check"
  | "close"
  | "gear"
  | "git-branch"
  | "layout-sidebar-left"
  | "layout-sidebar-right"
  | "split-horizontal"
  | "split-vertical"
  | "terminal";

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
