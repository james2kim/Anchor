import type { WorkflowTool, WorkflowContext, WorkflowResult } from '../types';
import type { WorkflowRun } from '../WorkflowRun';
import { WorkflowRunner } from '../WorkflowRunner';
import type { ErrorMapping } from '../WorkflowRunner';
import { WorkflowStepError } from '../errors';
import { extractQuizIntent, generateQuiz } from '../../llm/quizGenerator';
import type { LLMUsage } from '../../llm/quizGenerator';
import { normalizeTrueFalse, validateQuiz } from '../../llm/quizValidator';
import { formatQuizAsMarkdown } from '../../llm/quizFormatter';
import { buildContextBlock } from '../../llm/promptBuilder';
import {
  quizGenerationSuccessSchema,
  quizGenerationFailureSchema,
} from '../../schemas/quizSchemas';
import type { QuizInput, QuizOutput } from '../../schemas/quizSchemas';
import { wlog } from '../../util/WorkflowLogger';

// Step artifact shapes stored in durable state
interface IntentArtifact {
  data: QuizInput;
  usage: LLMUsage;
  durationMs: number;
}

interface GenerationArtifact {
  data: QuizOutput;
  usage: LLMUsage;
  durationMs: number;
}

interface ValidationArtifact {
  valid: true;
  warnings: string[];
}

const logUsage = (label: string, model: string, usage: LLMUsage, durationMs: number) => {
  const tokenInfo =
    usage.inputTokens != null ? ` (in=${usage.inputTokens}, out=${usage.outputTokens})` : '';
  wlog.log(
    `[quizTool] ${label} ${model} completed in ${(durationMs / 1000).toFixed(2)}s${tokenInfo}`
  );
};

const validateFailureObservation = (
  message: string,
  errorType: string,
  validationErrors?: string[]
) => {
  const observation = {
    success: false as const,
    error_type: errorType,
    error_message: message,
    validationErrors,
  };
  const parsed = quizGenerationFailureSchema.safeParse(observation);
  if (!parsed.success) {
    wlog.warn(
      '[quizTool] Failure observation schema validation failed:',
      parsed.error.issues.map((i) => i.message)
    );
  }
};

const QUIZ_ERROR_MAP: ErrorMapping[] = [
  {
    code: 'INTENT_EXTRACTION_FAILED',
    message:
      'I couldn\'t understand the quiz parameters from your request. Could you try rephrasing? For example: "Make me a 5-question quiz about photosynthesis".',
    errorType: 'intent_extraction_failed',
    onError: (err) => validateFailureObservation(err.message, 'intent_extraction_failed'),
  },
  {
    code: 'GENERATION_FAILED',
    message:
      'I had trouble generating the quiz. Could you try again? If the problem persists, try a simpler request like "quiz me on [topic]".',
    errorType: 'generation_failed',
    onError: (err) => validateFailureObservation(err.message, 'generation_failed'),
  },
  {
    code: 'VALIDATION_FAILED',
    message:
      "The generated quiz had some issues and I couldn't ensure its accuracy. Could you try again?",
    errorType: 'validation_failed',
    onError: (err) =>
      validateFailureObservation(
        err.message,
        'validation_failed',
        err.details.validationErrors as string[] | undefined
      ),
  },
];

export const quizTool: WorkflowTool = {
  name: 'quiz_generation',
  description:
    'Generates quizzes and practice tests from study materials. Use when the user wants to be tested, quizzed, or wants practice questions.',
  keywords: [
    /\b(quiz|test|assess|examine)\s+me\b/i,
    /\bpractice\s+(test|questions|problems|exam)\b/i,
    /\breview\s+questions\b/i,
    /\b(make|create|generate|give|write)\b.*\b(quiz|test|questions|problems|exam)\b/i,
    /\bask\s+me\b.*\bquestions?\b/i,
    /\b(test|check|assess)\s+(my|our)\s+(knowledge|understanding)\b/i,
  ],

  async execute(ctx: WorkflowContext, run: WorkflowRun): Promise<WorkflowResult> {
    const runner = new WorkflowRunner(ctx.trace, run, ctx.sessionId);
    const { userQuery, contextBlock, conversationContext } = ctx;

    return runner.execute(async () => {
      // ---- Step 1: Extract quiz intent ----
      const intent = await runner.runStep<IntentArtifact>(
        'intentExtraction',
        'quizIntentExtraction',
        async () => {
          const start = Date.now();
          const res = await extractQuizIntent(userQuery, contextBlock, conversationContext);
          const durationMs = Date.now() - start;

          if (!res) {
            throw new WorkflowStepError(
              'INTENT_EXTRACTION_FAILED',
              'Failed to extract quiz intent from user query'
            );
          }

          logUsage('intentExtraction', 'haiku', res.usage, durationMs);
          return { data: res.data, usage: res.usage, durationMs };
        },
        {
          timeoutMs: 45_000,
          progressLabel: 'Understanding your request...',
          spanMeta: (a) => ({
            success: true,
            topic: a.data.topic,
            questionCount: a.data.questionCount,
            difficulty: a.data.difficulty,
            questionTypes: JSON.stringify(a.data.questionTypes),
          }),
        }
      );

      const input = intent.data;

      // ---- Step 2: Context enrichment via in-workflow retrieval ----
      let activeContextBlock = contextBlock;
      const contextThin = !activeContextBlock || activeContextBlock.length < 500;

      if (contextThin) {
        const retrievalResult = await runner.runStep<{ chunksAdded: number; finalLength: number }>(
          'contextRetrieval',
          'workflowContextRetrieval',
          async () => {
            wlog.log(
              `[quizTool] Context thin (${activeContextBlock?.length ?? 0} chars), retrieving for topic: "${input.topic}"`
            );
            const retrieved = await ctx.retrieve(input.topic);
            let chunksAdded = 0;
            if (retrieved.length > 0) {
              const existingIds = new Set(ctx.documents.map((d) => d.id));
              const newChunks = retrieved.filter((c) => !existingIds.has(c.id));
              if (newChunks.length > 0) {
                // Normalize retrieved chunks' confidence to sort after reranked docs
                // Reranked docs have calibrated confidence; raw retrieval uses distance-based scores
                const normalized = newChunks.map((c) => ({
                  ...c,
                  confidence: Math.min(c.confidence, 0.3),
                }));
                const allDocs = [...ctx.documents, ...normalized];
                activeContextBlock = buildContextBlock(allDocs, ctx.memories);
                chunksAdded = newChunks.length;
              }
            }
            return { chunksAdded, finalLength: activeContextBlock?.length ?? 0 };
          },
          {
            durable: false,
            progressLabel: 'Finding relevant study materials...',
            spanMeta: (a) => ({
              contextWasThin: true,
              chunksAdded: a.chunksAdded,
              finalContextLength: a.finalLength,
            }),
          }
        );

        wlog.log(
          `[quizTool] Retrieval complete: ${retrievalResult.chunksAdded} chunks added, context now ${retrievalResult.finalLength} chars`
        );
      }

      if (!activeContextBlock || activeContextBlock.length < 100) {
        return runner.failure(
          `I don't have enough study materials on "${input.topic}" to create a quiz from. Please upload some documents or notes first, then try again.`,
          'insufficient_context'
        );
      }

      // ---- Step 3: Generate quiz ----
      const gen = await runner.runStep<GenerationArtifact>(
        'quizGeneration',
        'quizGeneration',
        async () => {
          const start = Date.now();
          const res = await generateQuiz(input, activeContextBlock!);
          const durationMs = Date.now() - start;

          if (!res) {
            throw new WorkflowStepError('GENERATION_FAILED', 'Quiz generation returned no result');
          }

          logUsage('quizGeneration', 'sonnet', res.usage, durationMs);
          return { data: res.data, usage: res.usage, durationMs };
        },
        {
          timeoutMs: 120_000,
          progressLabel: 'Generating questions...',
          spanMeta: (a) => ({
            success: true,
            questionsGenerated: a.data.questions.length,
            title: a.data.title,
          }),
        }
      );

      const quiz = gen.data;
      normalizeTrueFalse(quiz);

      // ---- Step 4: Validate quiz ----
      await runner.runStep<ValidationArtifact>(
        'quizValidation',
        'quizValidation',
        async () => {
          const validation = validateQuiz(quiz, input);

          if (!validation.valid) {
            wlog.warn('[quizTool] Quiz validation failed:', validation.errors);
            throw new WorkflowStepError('VALIDATION_FAILED', 'Quiz validation failed', {
              validationErrors: validation.errors,
            });
          }

          if (validation.warnings.length > 0) {
            wlog.log('[quizTool] Quiz validation warnings:', validation.warnings);
          }

          return { valid: true as const, warnings: validation.warnings };
        },
        {
          durable: false,
          progressLabel: 'Checking quiz quality...',
          spanMeta: (a) => ({
            valid: true,
            errorCount: 0,
            warningCount: a.warnings.length,
            errors: '[]',
            warnings: JSON.stringify(a.warnings),
          }),
        }
      );

      // ---- Step 5: Format output (inline, pure computation) ----
      const successObservation = {
        success: true as const,
        quiz,
        input,
        questionsGenerated: quiz.questions.length,
        questionsRequested: input.questionCount,
      };
      const successParsed = quizGenerationSuccessSchema.safeParse(successObservation);
      if (!successParsed.success) {
        wlog.warn(
          '[quizTool] Success observation schema validation failed:',
          successParsed.error.issues.map((i) => i.message)
        );
      }

      let response = formatQuizAsMarkdown(quiz);
      if (quiz.questions.length < input.questionCount) {
        response += `\n\n*Note: I was able to generate ${quiz.questions.length} of the ${input.questionCount} requested questions from your study materials.*`;
      }
      const result = runner.success(response, quiz);
      wlog.log(
        `[quizTool] Total tokens: in=${result.totalInputTokens}, out=${result.totalOutputTokens}`
      );

      return result;
    }, QUIZ_ERROR_MAP);
  },
};
