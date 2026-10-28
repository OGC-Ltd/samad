// Catches render errors so one broken section doesn't crash the app.

import { Component } from "react";
import "./ErrorBoundary.scss";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error(
      `[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ""}] caught an error:`,
      error,
      errorInfo
    );
  }

  handleRetry = () => {

    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {

      const { fullSection, label } = this.props;
      return (
        <div className={`error-boundary${fullSection ? " error-boundary--full" : " error-boundary--compact"}`}>
          <span className="error-boundary__icon">⚠</span>
          <div className="error-boundary__text">
            <p className="error-boundary__title">
              {label ? `${label} failed to load` : "Something went wrong"}
            </p>
            <p className="error-boundary__subtitle">
              The rest of the dashboard is still working normally.
            </p>
          </div>
          <button className="error-boundary__retry" onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
