import ReactMarkdown from 'react-markdown';
import DOMPurify from 'dompurify';

interface ChatMessageProps {
  content: string;
  role: 'user' | 'assistant' | 'system';
}

export function ChatMessage({ content, role }: ChatMessageProps) {
  const sanitized = DOMPurify.sanitize(content);

  return (
    <div className={`message ${role}`}>
      <ReactMarkdown>{sanitized}</ReactMarkdown>
    </div>
  );
}
