import { Component, type ReactNode } from 'react';

interface Props {
  label: string;
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

  override render() {
    if (this.state.hasError) {
      return (
        <div className="empty" role="alert">
          <p>Failed to load {this.props.label}. Check your connection and reload the page.</p>
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={this.handleReload}>
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
