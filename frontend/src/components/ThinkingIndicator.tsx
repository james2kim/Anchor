interface ThinkingIndicatorProps {
  label?: string | null;
}

export function ThinkingIndicator({ label }: ThinkingIndicatorProps) {
  return (
    <div className="message thinking">
      <span>{label || 'Thinking'}</span>
      <div className="thinking-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  );
}
