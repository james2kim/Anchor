import { haikuModel, sonnetModel } from '../agent/constants';
import { withRetry } from '../util/RetryUtil';
import { quizInputSchema, quizOutputSchema } from '../schemas/quizSchemas';
import type { QuizInput, QuizOutput } from '../schemas/quizSchemas';
import type { AIMessageChunk } from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import { wlog } from '../util/WorkflowLogger';

export interface LLMUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LLMResult<T> {
  data: T;
  usage: LLMUsage;
}

// ============================================================================
// STEP 1: Extract quiz intent from natural language
// ============================================================================

const INTENT_EXTRACTION_PROMPT = `You are a quiz parameter extractor. Given a user's natural language request for a quiz, extract structured parameters.

## Rules
- "topic" should be a concise description of what the quiz covers
- Default to 5 questions if not specified
- Default to "multiple_choice" if no type is specified
- Default to "medium" difficulty if not specified
- Only set focusAreas if the user explicitly mentions specific subtopics or areas to focus on
- If the user says "true/false" or "T/F", set questionTypes to ["true_false"]
- If the user says "mixed", set questionTypes to ["multiple_choice", "true_false"]

## Examples
- "quiz me on photosynthesis" → topic: "photosynthesis", questionCount: 5, questionTypes: ["multiple_choice"], difficulty: "medium"
- "10 hard true/false questions on the French Revolution" → topic: "French Revolution", questionCount: 10, questionTypes: ["true_false"], difficulty: "hard"
- "easy quiz about cell biology focusing on mitosis and meiosis" → topic: "cell biology", questionCount: 5, questionTypes: ["multiple_choice"], difficulty: "easy", focusAreas: ["mitosis", "meiosis"]`;

const intentModel = haikuModel.withStructuredOutput(quizInputSchema, { includeRaw: true });

export const extractQuizIntent = async (
  userQuery: string,
  documentContext?: string | null,
  conversationContext?: string | null
): Promise<LLMResult<QuizInput> | null> => {
  try {
    let userContent = `User request: ${userQuery}`;
    if (conversationContext) {
      userContent += `\n\nRecent conversation (use this to resolve references like "it", "this topic", etc.):\n${conversationContext}`;
    }
    if (documentContext) {
      userContent += `\n\nAvailable study material topics:\n${documentContext}`;
    }

    const result = await withRetry(
      (signal) =>
        intentModel.invoke(
          [
            { role: 'system', content: INTENT_EXTRACTION_PROMPT },
            { role: 'user', content: userContent },
          ],
          { signal }
        ),
      { label: 'extractQuizIntent' }
    );

    // Belt-and-suspenders: validate LLM output against schema
    const parsed = quizInputSchema.safeParse(result.parsed);
    if (!parsed.success) {
      wlog.warn(
        '[extractQuizIntent] Schema validation failed after structured output:',
        parsed.error.issues.map((i) => i.message)
      );
      return null;
    }

    const usageMeta = (result.raw as AIMessageChunk).usage_metadata;
    return {
      data: parsed.data,
      usage: {
        inputTokens: usageMeta?.input_tokens ?? null,
        outputTokens: usageMeta?.output_tokens ?? null,
      },
    };
  } catch (err) {
    // LangChain throws OutputParserException when the LLM returns unparseable output — expected
    if (err instanceof OutputParserException) {
      wlog.warn('[extractQuizIntent] LLM output parse failure (expected):', err.message);
      return null;
    }
    wlog.error('[extractQuizIntent] Unexpected error (propagating):', err);
    throw err;
  }
};

// ============================================================================
// STEP 2: Generate quiz from structured input + context
// ============================================================================

const buildQuizGenerationPrompt = (input: QuizInput, contextBlock: string): string => {
  const typeDescriptions = input.questionTypes
    .map((t) => (t === 'multiple_choice' ? 'multiple choice' : 'true/false'))
    .join(' and ');

  return `You are a quiz generator for a study assistant. Generate a quiz based on the provided study materials.

## Quiz Parameters
- Topic: ${input.topic}
- Number of questions: ${input.questionCount}
- Question types: ${typeDescriptions}
- Difficulty: ${input.difficulty}
${input.focusAreas?.length ? `- Focus areas: ${input.focusAreas.join(', ')}` : ''}

## Rules
1. ALL questions MUST be grounded in the provided study materials. Do not make up facts.
2. For multiple_choice questions: provide 4 options (A-D). The correctAnswer MUST exactly match one of the options.
3. For true_false questions: options MUST be exactly ["True", "False"]. The correctAnswer MUST be either "True" or "False".
4. Each explanation should reference the source material and explain WHY the answer is correct.
5. No duplicate questions.
6. Vary question difficulty according to the requested level:
   - easy: recall and recognition
   - medium: understanding and application
   - hard: analysis and evaluation
7. The title should describe the quiz topic concisely.

## Study Materials
${contextBlock}`;
};

const quizModel = sonnetModel.withStructuredOutput(quizOutputSchema, { includeRaw: true });

export const generateQuiz = async (
  input: QuizInput,
  contextBlock: string
): Promise<LLMResult<QuizOutput> | null> => {
  try {
    const systemPrompt = buildQuizGenerationPrompt(input, contextBlock);

    const result = await withRetry(
      (signal) =>
        quizModel.invoke(
          [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `Generate a ${input.difficulty} quiz with ${input.questionCount} questions about "${input.topic}".`,
            },
          ],
          { signal }
        ),
      { label: 'generateQuiz' }
    );

    // Belt-and-suspenders: validate LLM output against schema
    const parsed = quizOutputSchema.safeParse(result.parsed);
    if (!parsed.success) {
      wlog.warn(
        '[generateQuiz] Schema validation failed after structured output:',
        parsed.error.issues.map((i) => i.message)
      );
      return null;
    }

    const usageMeta = (result.raw as AIMessageChunk).usage_metadata;
    return {
      data: parsed.data,
      usage: {
        inputTokens: usageMeta?.input_tokens ?? null,
        outputTokens: usageMeta?.output_tokens ?? null,
      },
    };
  } catch (err) {
    if (err instanceof OutputParserException) {
      wlog.warn('[generateQuiz] LLM output parse failure (expected):', err.message);
      return null;
    }
    wlog.error('[generateQuiz] Unexpected error (propagating):', err);
    throw err;
  }
};
