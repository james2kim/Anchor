import { useEffect, useRef } from 'react';
import { SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/clerk-react';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { FileUpload } from './components/FileUpload';
import { ThinkingIndicator } from './components/ThinkingIndicator';
import { useChat } from './hooks/useChat';

function App() {
  const { messages, isLoading, rateLimit, handleSend, handleUpload } = useChat();
  const isRateLimited = rateLimit !== null && rateLimit.remaining <= 0;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  return (
    <>
      <header>
        <h1>Study Assistant Agent</h1>
        <div className="header-actions">
          <SignedIn>
            <UserButton />
          </SignedIn>
        </div>
      </header>

      <SignedOut>
        <div className="auth-container">
          <div className="auth-card">
            <h2>Welcome to Study Assistant</h2>
            <p>Sign in to start chatting with your AI study assistant.</p>
            <SignInButton mode="modal">
              <button className="primary">Sign In</button>
            </SignInButton>
          </div>
        </div>
      </SignedOut>

      <SignedIn>
        <div className="container">
          <div className="messages">
            {messages.map((msg) => (
              <ChatMessage key={msg.id} content={msg.content} role={msg.role} />
            ))}
            {isLoading && <ThinkingIndicator />}
            <div ref={messagesEndRef} />
          </div>

          {isRateLimited && (
            <div className="rate-limit-alert">
              Daily message limit reached ({rateLimit.limit}/{rateLimit.limit}). Please try again tomorrow.
            </div>
          )}
          <ChatInput onSend={handleSend} disabled={isLoading || isRateLimited} />
          <FileUpload onUpload={handleUpload} disabled={isLoading} />
        </div>
      </SignedIn>
    </>
  );
}

export default App;
