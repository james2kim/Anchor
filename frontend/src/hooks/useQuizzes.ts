import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { listQuizzes, getQuiz, deleteQuiz, type QuizListItem, type QuizRecord } from '../api/client';

export function useQuizzes() {
  const { getToken } = useAuth();
  const [quizzes, setQuizzes] = useState<QuizListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listQuizzes(getToken);
      setQuizzes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quizzes');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const fetchQuiz = useCallback(
    async (quizId: string): Promise<QuizRecord | null> => {
      try {
        return await getQuiz(quizId, getToken);
      } catch {
        return null;
      }
    },
    [getToken]
  );

  const removeQuiz = useCallback(
    async (quizId: string) => {
      await deleteQuiz(quizId, getToken);
      setQuizzes((prev) => prev.filter((q) => q.id !== quizId));
    },
    [getToken]
  );

  return { quizzes, loading, error, refresh, fetchQuiz, removeQuiz };
}
