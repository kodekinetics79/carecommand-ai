import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';

class ChunkErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the console useful without surfacing a blank shell.
    console.error('Lazy chunk failed to load', error, info);
  }

  render() {
    if (this.state.error) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function ChunkErrorFallback({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-4 text-sm text-t2 shadow-sm">
      <p className="font-semibold text-t1">{title}</p>
      <p className="mt-1 text-[12px] leading-6 text-t3">{description}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-3 inline-flex items-center rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[12px] font-semibold text-t1 hover:bg-[var(--s2)]"
      >
        Refresh page
      </button>
    </div>
  );
}

interface LazyBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  title: string;
  description: string;
}

export default function LazyBoundary({ children, fallback, title, description }: LazyBoundaryProps) {
  return (
    <ChunkErrorBoundary fallback={<ChunkErrorFallback title={title} description={description} />}>
      <Suspense fallback={fallback}>
        {children}
      </Suspense>
    </ChunkErrorBoundary>
  );
}
