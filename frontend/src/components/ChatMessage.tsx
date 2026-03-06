import ReactMarkdown from 'react-markdown';
import DOMPurify from 'dompurify';

interface ChatMessageProps {
  content: string;
  role: 'user' | 'assistant' | 'system';
  loading?: boolean;
}

export function ChatMessage({ content, role, loading }: ChatMessageProps) {
  const sanitized = DOMPurify.sanitize(content);

  return (
    <div className={`message ${role}${loading ? ' message-loading' : ''}`}>
      {loading && <span className="message-spinner" />}
      <ReactMarkdown>{sanitized}</ReactMarkdown>
    </div>
  );
}
