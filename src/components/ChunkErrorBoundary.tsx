import { Component, type ReactNode } from 'react';

interface Props {
  label: string;
  onReset?: () => void;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ChunkErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({ hasError: false });
    this.props.onReset?.();
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="empty">
          <p role="alert">Failed to load {this.props.label}. Check your connection and reload the page.</p>
          <div className="loadmore-bar" style={{ marginTop: 10 }}>
            <button type="button" className="btn" onClick={this.handleReload}>
              Reload page
            </button>
            {this.props.onReset && (
              <button type="button" className="chip" onClick={this.handleReset}>
                Dismiss
              </button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
