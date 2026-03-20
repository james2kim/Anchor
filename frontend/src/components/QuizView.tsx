import { useState, useEffect } from 'react';
import { useQuizzes } from '../hooks/useQuizzes';
import type { QuizData, QuizQuestion } from '../api/client';

interface QuizViewProps {
  quizId: string;
  onBack: () => void;
}

const LETTER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function QuizView({ quizId, onBack }: QuizViewProps) {
  const { fetchQuiz } = useQuizzes();
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [loading, setLoading] = useState(true);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchQuiz(quizId).then((record) => {
      if (record) {
        setQuiz(record.quiz_data);
      }
      setLoading(false);
    });
  }, [quizId, fetchQuiz]);

  if (loading) {
    return (
      <div className="quiz-view">
        <p style={{ textAlign: 'center', color: '#666' }}>Loading quiz...</p>
      </div>
    );
  }

  if (!quiz) {
    return (
      <div className="quiz-view">
        <p style={{ textAlign: 'center', color: '#e74c3c' }}>Quiz not found.</p>
        <button className="quiz-back-btn" onClick={onBack}>Back to quizzes</button>
      </div>
    );
  }

  const questions = quiz.questions;
  const totalQuestions = questions.length;
  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === totalQuestions;

  const selectAnswer = (questionIdx: number, optionIdx: number) => {
    if (submitted) return;
    setAnswers((prev) => ({ ...prev, [questionIdx]: optionIdx }));
  };

  const handleSubmit = () => {
    if (!allAnswered) return;
    setSubmitted(true);
  };

  const handleRetake = () => {
    setAnswers({});
    setSubmitted(false);
  };

  const getScore = () => {
    let correct = 0;
    for (let i = 0; i < questions.length; i++) {
      const selectedIdx = answers[i];
      if (selectedIdx !== undefined && questions[i].options[selectedIdx] === questions[i].correctAnswer) {
        correct++;
      }
    }
    return correct;
  };

  const isCorrect = (qIdx: number): boolean | null => {
    if (!submitted) return null;
    const selectedIdx = answers[qIdx];
    if (selectedIdx === undefined) return null;
    return questions[qIdx].options[selectedIdx] === questions[qIdx].correctAnswer;
  };

  const correctOptionIdx = (q: QuizQuestion): number =>
    q.options.indexOf(q.correctAnswer);

  return (
    <div className="quiz-view">
      <div className="quiz-header">
        <button className="quiz-back-btn" onClick={onBack}>&larr; Back</button>
        <h2>{quiz.title}</h2>
        {submitted && (
          <div className="quiz-score">
            {getScore()} / {totalQuestions}
          </div>
        )}
      </div>

      <div className="quiz-questions">
        {questions.map((q, qIdx) => {
          const correct = isCorrect(qIdx);
          return (
            <div
              key={qIdx}
              className={`quiz-question${submitted ? (correct ? ' correct' : ' incorrect') : ''}`}
            >
              <div className="quiz-question-text">
                <strong>{qIdx + 1}.</strong> {q.question}
              </div>

              <div className="quiz-options">
                {q.options.map((opt, oIdx) => {
                  const isSelected = answers[qIdx] === oIdx;
                  const isCorrectOption = submitted && oIdx === correctOptionIdx(q);
                  const isWrongSelection = submitted && isSelected && !isCorrectOption;

                  let className = 'quiz-option';
                  if (isSelected && !submitted) className += ' selected';
                  if (isCorrectOption) className += ' correct-option';
                  if (isWrongSelection) className += ' wrong-option';

                  return (
                    <button
                      key={oIdx}
                      className={className}
                      onClick={() => selectAnswer(qIdx, oIdx)}
                      disabled={submitted}
                    >
                      <span className="quiz-option-letter">{LETTER_LABELS[oIdx]}</span>
                      {opt}
                    </button>
                  );
                })}
              </div>

              {submitted && (
                <div className="quiz-explanation">
                  <strong>{correct ? 'Correct!' : `Incorrect — Answer: ${LETTER_LABELS[correctOptionIdx(q)]}`}</strong>
                  <p>{q.explanation}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="quiz-actions">
        {!submitted ? (
          <button
            className="primary quiz-submit-btn"
            onClick={handleSubmit}
            disabled={!allAnswered}
          >
            Submit ({answeredCount}/{totalQuestions})
          </button>
        ) : (
          <button className="primary quiz-submit-btn" onClick={handleRetake}>
            Retake Quiz
          </button>
        )}
      </div>
    </div>
  );
}
