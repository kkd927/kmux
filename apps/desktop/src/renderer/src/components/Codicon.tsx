type CodiconName =
  | "add"
  | "bell"
  | "close"
  | "gear"
  | "layout-sidebar-left"
  | "search"
  | "split-horizontal"
  | "split-vertical"
  | "terminal-bash";

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
