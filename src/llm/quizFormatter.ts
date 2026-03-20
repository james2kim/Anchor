import type { QuizOutput } from '../schemas/quizSchemas';

const LETTER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Formats a quiz as markdown for the chat UI (ReactMarkdown).
 * Includes numbered questions with lettered options and a collapsible answer key.
 */
export const formatQuizAsMarkdown = (quiz: QuizOutput): string => {
  const sections: string[] = [];

  sections.push(`## ${quiz.title}\n`);

  // --- Questions ---
  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    const lines: string[] = [];

    lines.push(`**${i + 1}. ${q.question}**\n`);

    for (let j = 0; j < q.options.length; j++) {
      lines.push(`${LETTER_LABELS[j]}. ${q.options[j]}`);
    }

    sections.push(lines.join('\n'));
  }

  // --- Answer Key (collapsible) ---
  const answerLines: string[] = [];
  answerLines.push('\n<details>\n<summary>Show Answer Key</summary>\n');

  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    const correctIndex = q.options.indexOf(q.correctAnswer);
    const letter = correctIndex >= 0 ? LETTER_LABELS[correctIndex] : '?';

    answerLines.push(`**${i + 1}. ${letter}. ${q.correctAnswer}**`);
    answerLines.push(`${q.explanation}\n`);
  }

  answerLines.push('</details>');
  sections.push(answerLines.join('\n'));

  return sections.join('\n\n');
};
