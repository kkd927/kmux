import { Component, type ErrorInfo, type ReactNode } from "react";

interface SurfaceRenderErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  resetKey: string;
}

interface SurfaceRenderErrorBoundaryState {
  failed: boolean;
}

export class SurfaceRenderErrorBoundary extends Component<
  SurfaceRenderErrorBoundaryProps,
  SurfaceRenderErrorBoundaryState
> {
  state: SurfaceRenderErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): SurfaceRenderErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: SurfaceRenderErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("Markdown Surface render failed", error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
