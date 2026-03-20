import { useState } from 'react';
import { useQuizzes } from '../hooks/useQuizzes';
import { ConfirmModal } from './ConfirmModal';

interface QuizListProps {
  onSelectQuiz: (quizId: string) => void;
}

export function QuizList({ onSelectQuiz }: QuizListProps) {
  const { quizzes, loading, error, removeQuiz } = useQuizzes();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  if (loading) {
    return (
      <div className="documents-list">
        <p style={{ textAlign: 'center', color: '#666' }}>Loading quizzes...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="documents-list">
        <p style={{ textAlign: 'center', color: '#e74c3c' }}>{error}</p>
      </div>
    );
  }

  if (quizzes.length === 0) {
    return (
      <div className="documents-list">
        <p style={{ textAlign: 'center', color: '#666' }}>
          No quizzes yet. Ask the agent to make you a quiz in the Chat tab!
        </p>
      </div>
    );
  }

  return (
    <div className="documents-list">
      {deleteTarget && (
        <ConfirmModal
          title="Delete Quiz"
          message={`Are you sure you want to delete "${deleteTarget.title}"? This cannot be undone.`}
          onConfirm={() => {
            removeQuiz(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {quizzes.map((quiz) => (
        <div
          key={quiz.id}
          className="document-card"
          style={{ cursor: 'pointer' }}
          onClick={() => onSelectQuiz(quiz.id)}
        >
          <div className="document-card-header">
            <h3>{quiz.title}</h3>
            <button
              className="document-delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget({ id: quiz.id, title: quiz.title });
              }}
              title="Delete quiz"
            >
              Delete
            </button>
          </div>
          <div className="document-meta">
            <span>{quiz.question_count} question{quiz.question_count !== 1 ? 's' : ''}</span>
            <span>{new Date(quiz.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
