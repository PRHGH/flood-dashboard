"use client";

import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  label: string;
}

interface State {
  hasError: boolean;
  message?: string;
}

export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // This is the ongoing visibility hook: any future unexpected crash in
    // this section logs here, with the section name and full stack, even
    // in production, without needing to reproduce it live.
    console.error(`[${this.props.label}] crashed:`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 12, color: "gray", border: "1px dashed #ccc", borderRadius: 8 }}>
          {this.props.label} unavailable
          {this.state.message ? ` (${this.state.message})` : ""}
        </div>
      );
    }
    return this.props.children;
  }
}