import { useState, useEffect, useRef } from 'react';
import { SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/clerk-react';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { FileUpload } from './components/FileUpload';
import { ThinkingIndicator } from './components/ThinkingIndicator';
import { DocumentList } from './components/DocumentList';
import { QuizList } from './components/QuizList';
import { QuizView } from './components/QuizView';
import { useChat } from './hooks/useChat';

type Tab = 'chat' | 'documents' | 'quizzes';

function App() {
  const { messages, isLoading, rateLimit, handleSend, handleUpload } = useChat();
  const isRateLimited = rateLimit !== null && rateLimit.remaining <= 0;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [documentsKey, setDocumentsKey] = useState(0);
  const [quizzesKey, setQuizzesKey] = useState(0);
  const [selectedQuizId, setSelectedQuizId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const switchTab = (tab: Tab) => {
    setActiveTab(tab);
    setMenuOpen(false);
    if (tab === 'documents') {
      setDocumentsKey((k) => k + 1);
    }
    if (tab === 'quizzes') {
      setQuizzesKey((k) => k + 1);
      setSelectedQuizId(null);
    }
  };

  return (
    <>
      <header>
        <div className="header-logo">
          <img src="/logo.png" alt="Anchor logo" />
          <h1>Anchor</h1>
        </div>
        <SignedIn>
          <div className={`header-tabs${menuOpen ? ' open' : ''}`}>
            <button
              className={`tab-button${activeTab === 'chat' ? ' active' : ''}`}
              onClick={() => switchTab('chat')}
            >
              Chat
            </button>
            <button
              className={`tab-button${activeTab === 'documents' ? ' active' : ''}`}
              onClick={() => switchTab('documents')}
            >
              Documents
            </button>
            <button
              className={`tab-button${activeTab === 'quizzes' ? ' active' : ''}`}
              onClick={() => switchTab('quizzes')}
            >
              Quizzes
            </button>
          </div>
        </SignedIn>
        <div className="header-actions">
          <SignedIn>
            <button
              className="hamburger"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Toggle menu"
            >
              <span /><span /><span />
            </button>
            <UserButton />
          </SignedIn>
        </div>
      </header>

      <SignedOut>
        <div className="auth-container">
          <div className="auth-card">
            <h2>Welcome to Anchor</h2>
            <p>Your AI-powered study companion. Upload documents, ask questions, and learn smarter.</p>
            <SignInButton mode="modal">
              <button className="primary">Sign In</button>
            </SignInButton>
          </div>
        </div>
      </SignedOut>

      <SignedIn>
        {activeTab === 'chat' && (
          <div className="container">
            <div className="messages">
              {messages.map((msg) => (
                <ChatMessage key={msg.id} content={msg.content} role={msg.role} loading={msg.loading} />
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
        )}
        {activeTab === 'documents' && (
          <div className="container">
            <DocumentList key={documentsKey} />
          </div>
        )}
        {activeTab === 'quizzes' && (
          <div className="container">
            {selectedQuizId ? (
              <QuizView
                key={selectedQuizId}
                quizId={selectedQuizId}
                onBack={() => setSelectedQuizId(null)}
              />
            ) : (
              <QuizList
                key={quizzesKey}
                onSelectQuiz={(id) => setSelectedQuizId(id)}
              />
            )}
          </div>
        )}
      </SignedIn>
    </>
  );
}

export default App;
