import type { QuizOutput, QuizInput, QuizValidationResult } from '../schemas/quizSchemas';

/**
 * Normalize true/false questions in-place so options and correctAnswer
 * use canonical casing ("True"/"False") regardless of what the LLM produced.
 * Must run before validation and formatting.
 */
export const normalizeTrueFalse = (quiz: QuizOutput): void => {
  for (const q of quiz.questions) {
    if (q.type !== 'true_false') continue;

    q.options = q.options.map((o) => {
      const lower = o.toLowerCase().trim();
      if (lower === 'true') return 'True';
      if (lower === 'false') return 'False';
      return o;
    });

    const lowerAnswer = q.correctAnswer.toLowerCase().trim();
    if (lowerAnswer === 'true') q.correctAnswer = 'True';
    else if (lowerAnswer === 'false') q.correctAnswer = 'False';
  }
};

/**
 * Validates a generated quiz against its input parameters.
 * Pure deterministic checks — no LLM calls.
 *
 * Errors = critical (quiz is broken), Warnings = non-critical (quiz is usable).
 */
export const validateQuiz = (quiz: QuizOutput, input: QuizInput): QuizValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Question count ---
  if (quiz.questions.length !== input.questionCount) {
    warnings.push(
      `Requested ${input.questionCount} questions but got ${quiz.questions.length}`
    );
  }

  const seenQuestions = new Set<string>();

  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    const label = `Q${i + 1}`;

    // --- correctAnswer must be in options ---
    if (!q.options.includes(q.correctAnswer)) {
      errors.push(
        `${label}: correctAnswer "${q.correctAnswer}" is not in options [${q.options.join(', ')}]`
      );
    }

    // --- Option uniqueness ---
    const uniqueOptions = new Set(q.options.map((o) => o.toLowerCase().trim()));
    if (uniqueOptions.size !== q.options.length) {
      errors.push(`${label}: duplicate options detected`);
    }

    // --- True/false constraints ---
    if (q.type === 'true_false') {
      if (q.options.length !== 2 || q.options[0] !== 'True' || q.options[1] !== 'False') {
        errors.push(`${label}: true_false question must have exactly ["True", "False"] as options`);
      }
      if (q.correctAnswer !== 'True' && q.correctAnswer !== 'False') {
        errors.push(`${label}: true_false answer must be "True" or "False"`);
      }
    }

    // --- Multiple choice constraints ---
    if (q.type === 'multiple_choice' && q.options.length < 3) {
      errors.push(`${label}: multiple_choice question must have at least 3 options`);
    }

    // --- Type compliance ---
    if (!input.questionTypes.includes(q.type)) {
      warnings.push(
        `${label}: type "${q.type}" was not in requested types [${input.questionTypes.join(', ')}]`
      );
    }

    // --- Duplicate questions ---
    const normalizedQuestion = q.question.toLowerCase().trim();
    if (seenQuestions.has(normalizedQuestion)) {
      errors.push(`${label}: duplicate question text`);
    }
    seenQuestions.add(normalizedQuestion);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
};
