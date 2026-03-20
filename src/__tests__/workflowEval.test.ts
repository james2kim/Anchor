import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { buildWorkflow } from '../agent/graph';
import { RedisSessionStore } from '../stores/RedisSessionStore';
import { RedisCheckpointer } from '../memory/RedisCheckpointer';
import { routeToTool } from '../workflows/registry';
import { quizOutputSchema } from '../schemas/quizSchemas';
import type { QuizOutput } from '../schemas/quizSchemas';
import { validateQuiz } from '../llm/quizValidator';
import { rewriteQuery } from '../llm/queryRewriter';
import type { AgentTrace } from '../schemas/types';
import crypto from 'crypto';
import { TEST_USER_ID } from './fixtures/testDocuments';

/**
 * Workflow Evaluation Tests
 *
 * Three tiers:
 * 1. Tool routing — deterministic keyword matching (no LLM, fast)
 * 2. Single-turn — full pipeline with one user message (LLM, ~10-30s each)
 * 3. Multi-turn — multi-message conversations testing context inference (LLM, ~30-60s each)
 */

let agentApp: ReturnType<typeof buildWorkflow>;
const sessionIds: string[] = [];

function newSessionId(): string {
  const id = `wf-eval-${crypto.randomUUID()}`;
  sessionIds.push(id);
  return id;
}

async function runAgent(
  query: string,
  sessionId: string
): Promise<{
  response?: string;
  trace?: AgentTrace;
  workflowData?: unknown;
}> {
  const userMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: query,
    createdAt: new Date().toISOString(),
  };

  const result = await agentApp.invoke(
    {
      messages: [userMessage],
      userQuery: query,
      userId: TEST_USER_ID,
      sessionId,
    },
    { configurable: { thread_id: sessionId } }
  );

  return {
    response: result?.response,
    trace: result?.trace,
    workflowData: result?.workflowData,
  };
}

// ============================================================================
// SETUP / TEARDOWN
// ============================================================================

beforeAll(async () => {
  await RedisSessionStore.connect();
  const checkpointer = new RedisCheckpointer(RedisSessionStore);
  agentApp = buildWorkflow(checkpointer);
}, 30_000);

afterAll(async () => {
  const client = RedisSessionStore.getClient();
  for (const sid of sessionIds) {
    try {
      await client.del(`session:${sid}`);
      await client.del(`checkpoint:${sid}:latest`);
    } catch {
      // Ignore cleanup errors
    }
  }
  await RedisSessionStore.disconnect();
});

// ============================================================================
// 1. TOOL ROUTING (deterministic, no LLM)
// ============================================================================

describe('Tool Routing', () => {
  const quizQueries = [
    'quiz me on biology',
    'make me a quiz about photosynthesis',
    'create a practice test on the French Revolution',
    'test my knowledge on machine learning',
    'give me 5 questions about calculus',
    'generate a hard exam on organic chemistry',
    'ask me questions about data structures',
  ];

  const nonQuizQueries = [
    'what is photosynthesis',
    'explain the French Revolution',
    'help me understand calculus',
    'what did I study last week',
    'hello',
    'summarize my notes',
  ];

  it.each(quizQueries)('should route "%s" to quiz_generation', (query) => {
    const result = routeToTool(query);
    expect(result).not.toBeNull();
    expect(result!.tool.name).toBe('quiz_generation');
  });

  it.each(nonQuizQueries)('should NOT route "%s" to any workflow', (query) => {
    const result = routeToTool(query);
    expect(result).toBeNull();
  });
});

// ============================================================================
// 2. SINGLE-TURN WORKFLOW EVALUATION (full pipeline, one message)
// ============================================================================

describe('Single-Turn Workflow', () => {
  it('should generate a quiz when explicitly asked', async () => {
    const sid = newSessionId();
    const { response, trace, workflowData } = await runAgent(
      'make me a 3 question quiz about information retrieval',
      sid
    );

    expect(response).toBeDefined();
    expect(trace).toBeDefined();

    // Routed to workflow
    const gateSpan = trace!.spans.find((s) => s.node === 'retrievalGate');
    expect(gateSpan!.meta.queryType).toBe('workflow');

    // Workflow executed
    const spanNodes = trace!.spans.map((s) => s.node);
    expect(spanNodes).toContain('executeWorkflow');

    // Response looks like a quiz (has questions with options)
    expect(response).toMatch(/\d+\./);
    expect(response).toMatch(/[A-D]\./);

    // workflowData is a valid quiz
    if (workflowData) {
      const parsed = quizOutputSchema.safeParse(workflowData);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.questions.length).toBeGreaterThanOrEqual(1);
      }
    }
  }, 60_000);

  it('should generate a quiz with specified difficulty', async () => {
    const sid = newSessionId();
    const { response, trace } = await runAgent(
      'give me a hard quiz on information retrieval with 3 questions',
      sid
    );

    expect(response).toBeDefined();
    expect(trace!.outcome!.status).toBe('success');

    const spanNodes = trace!.spans.map((s) => s.node);
    expect(spanNodes).toContain('executeWorkflow');

    // Should have answer key
    expect(response).toMatch(/answer/i);
  }, 60_000);

  it('should generate true/false questions when asked', async () => {
    const sid = newSessionId();
    const { response, trace, workflowData } = await runAgent(
      'make me a 3 question true/false quiz about information retrieval',
      sid
    );

    expect(response).toBeDefined();
    expect(trace!.outcome!.status).toBe('success');

    if (workflowData) {
      const parsed = quizOutputSchema.safeParse(workflowData);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        const hasTrueFalse = parsed.data.questions.some((q) => q.type === 'true_false');
        expect(hasTrueFalse).toBe(true);
      }
    }
  }, 60_000);

  it('should handle quiz request with minimal context gracefully', async () => {
    const sid = newSessionId();
    const { response, trace } = await runAgent(
      'quiz me on quantum entanglement theory in black holes',
      sid
    );

    // Should either generate a quiz or explain insufficient context — not crash
    expect(response).toBeDefined();
    expect(response!.length).toBeGreaterThan(0);
    expect(trace).toBeDefined();
    expect(trace!.outcome).toBeDefined();
  }, 60_000);

  it('should not route a study question to the workflow', async () => {
    const sid = newSessionId();
    const { trace } = await runAgent(
      'explain how TF-IDF works in information retrieval',
      sid
    );

    expect(trace).toBeDefined();

    // Should NOT go through executeWorkflow
    const spanNodes = trace!.spans.map((s) => s.node);
    expect(spanNodes).not.toContain('executeWorkflow');

    // Should go through normal retrieval → response path
    expect(spanNodes).toContain('retrievalGate');
  }, 60_000);
});

// ============================================================================
// 3. MULTI-TURN WORKFLOW EVALUATION (context inference)
// ============================================================================

describe('Multi-Turn Workflow', () => {
  it('should generate a quiz about the topic from the previous turn', async () => {
    const sid = newSessionId();

    // Turn 1: Ask about a topic
    const turn1 = await runAgent(
      'what is TF-IDF and how does it work in information retrieval?',
      sid
    );
    expect(turn1.response).toBeDefined();
    expect(turn1.response!.length).toBeGreaterThan(50);

    // Turn 2: Ask for a quiz using a pronoun reference
    const turn2 = await runAgent('make me a quiz on it', sid);
    expect(turn2.response).toBeDefined();

    // Should have been routed to workflow
    const spanNodes = turn2.trace!.spans.map((s) => s.node);
    expect(spanNodes).toContain('executeWorkflow');

    // The quiz should be about information retrieval / TF-IDF, not a random topic
    const responseLower = turn2.response!.toLowerCase();
    const topicRelevant =
      responseLower.includes('tf-idf') ||
      responseLower.includes('tf–idf') ||
      responseLower.includes('retrieval') ||
      responseLower.includes('term frequency') ||
      responseLower.includes('document frequency') ||
      responseLower.includes('information');
    expect(topicRelevant).toBe(true);
  }, 120_000);

  it('should resolve "it" to the most recent topic, not an older one', async () => {
    const sid = newSessionId();

    // Turn 1: Discuss topic A
    const turn1 = await runAgent(
      'make me a quiz on information retrieval',
      sid
    );
    expect(turn1.response).toBeDefined();

    // Turn 2: Switch to topic B
    const turn2 = await runAgent(
      'what are the key concepts of neural networks and backpropagation?',
      sid
    );
    expect(turn2.response).toBeDefined();
    expect(turn2.response!.length).toBeGreaterThan(50);

    // Turn 3: "quiz me on it" — should refer to topic B (neural networks), not topic A
    const turn3 = await runAgent('make me a quiz on it', sid);
    expect(turn3.response).toBeDefined();

    const spanNodes = turn3.trace!.spans.map((s) => s.node);
    expect(spanNodes).toContain('executeWorkflow');

    // Quiz should be about neural networks / backpropagation, not information retrieval
    const responseLower = turn3.response!.toLowerCase();
    const topicRelevant =
      responseLower.includes('neural') ||
      responseLower.includes('backpropagation') ||
      responseLower.includes('network') ||
      responseLower.includes('gradient') ||
      responseLower.includes('deep learning');
    expect(topicRelevant).toBe(true);
  }, 180_000);

  it('should answer "I need more information" with context, not clarify', async () => {
    const sid = newSessionId();

    // Turn 1 & 2: Establish context about a topic
    await runAgent('What is TF-IDF?', sid);
    await runAgent('How is it used in information retrieval?', sid);

    // Turn 3: Vague request that should resolve to the established topic
    const turn3 = await runAgent('I need more information', sid);
    expect(turn3.response).toBeDefined();

    // Should NOT be routed to clarification — context makes the intent clear
    const responseLower = turn3.response!.toLowerCase();
    const isAnswering =
      responseLower.includes('tf-idf') ||
      responseLower.includes('retrieval') ||
      responseLower.includes('term frequency') ||
      responseLower.includes('document');
    expect(isAnswering).toBe(true);

    // Should NOT ask for clarification
    expect(responseLower).not.toMatch(/could you (clarify|be more specific)/);
  }, 120_000);
});

// ============================================================================
// 4. QUIZ STRUCTURAL CORRECTNESS
// ============================================================================

describe('Quiz Structural Correctness', () => {
  it('should produce a structurally valid quiz with correct answers in options', async () => {
    const sid = newSessionId();
    const { workflowData } = await runAgent(
      'make me a 5 question quiz about information retrieval',
      sid
    );

    expect(workflowData).toBeDefined();
    const parsed = quizOutputSchema.safeParse(workflowData);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const quiz = parsed.data;

    // correctAnswer must appear in options for every question
    for (let i = 0; i < quiz.questions.length; i++) {
      const q = quiz.questions[i];
      expect(
        q.options.includes(q.correctAnswer),
        `Q${i + 1}: correctAnswer "${q.correctAnswer}" not found in options [${q.options.join(', ')}]`
      ).toBe(true);
    }
  }, 60_000);

  it('should have no duplicate questions', async () => {
    const sid = newSessionId();
    const { workflowData } = await runAgent(
      'make me a 5 question quiz about information retrieval',
      sid
    );

    expect(workflowData).toBeDefined();
    const parsed = quizOutputSchema.safeParse(workflowData);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const questions = parsed.data.questions.map((q) => q.question.toLowerCase().trim());
    const unique = new Set(questions);
    expect(unique.size).toBe(questions.length);
  }, 60_000);

  it('should have unique options within each question', async () => {
    const sid = newSessionId();
    const { workflowData } = await runAgent(
      'make me a 4 question quiz about information retrieval',
      sid
    );

    expect(workflowData).toBeDefined();
    const parsed = quizOutputSchema.safeParse(workflowData);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    for (let i = 0; i < parsed.data.questions.length; i++) {
      const q = parsed.data.questions[i];
      const normalizedOpts = q.options.map((o) => o.toLowerCase().trim());
      const unique = new Set(normalizedOpts);
      expect(
        unique.size,
        `Q${i + 1}: duplicate options detected`
      ).toBe(normalizedOpts.length);
    }
  }, 60_000);

  it('should have explanations for every question', async () => {
    const sid = newSessionId();
    const { workflowData } = await runAgent(
      'make me a 3 question quiz about information retrieval',
      sid
    );

    expect(workflowData).toBeDefined();
    const parsed = quizOutputSchema.safeParse(workflowData);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    for (const q of parsed.data.questions) {
      expect(q.explanation.length).toBeGreaterThan(20);
    }
  }, 60_000);

  it('should pass the internal quiz validator', async () => {
    const sid = newSessionId();
    const { workflowData } = await runAgent(
      'make me a 5 question quiz about information retrieval',
      sid
    );

    expect(workflowData).toBeDefined();
    const parsed = quizOutputSchema.safeParse(workflowData);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Run the same validator the pipeline uses
    const result = validateQuiz(parsed.data, {
      topic: 'information retrieval',
      questionCount: 5,
      questionTypes: ['multiple_choice'],
      difficulty: 'medium',
    });

    expect(result.errors).toEqual([]);
  }, 60_000);

  it('should complete quiz generation within 45 seconds', async () => {
    const sid = newSessionId();
    const start = Date.now();
    const { trace } = await runAgent(
      'make me a 3 question quiz about information retrieval',
      sid
    );
    const elapsed = Date.now() - start;

    expect(trace).toBeDefined();
    expect(elapsed).toBeLessThan(45_000);
  }, 60_000);
});

// ============================================================================
// 5. QUERY REWRITER EDGE CASES (deterministic heuristics + LLM topic extraction)
// ============================================================================

describe('Query Rewriter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('Heuristic bypass (no LLM call)', () => {
    it('should not rewrite when there is no conversation context', async () => {
      const result = await rewriteQuery('make me a quiz on biology');
      expect(result.wasRewritten).toBe(false);
      expect(result.rewrittenQuery).toBe('make me a quiz on biology');
    });

    it('should not rewrite when the query has no references', async () => {
      const result = await rewriteQuery('make me a quiz on biology', 'User: hi\nAssistant: hello');
      expect(result.wasRewritten).toBe(false);
      expect(result.rewrittenQuery).toBe('make me a quiz on biology');
    });

    it('should not rewrite long self-contained queries with incidental pronouns', async () => {
      const result = await rewriteQuery(
        'explain how machine learning models process data and why it matters for real world applications today',
        'User: what is TF-IDF?\nAssistant: TF-IDF is...'
      );
      expect(result.wasRewritten).toBe(false);
    });
  });

  describe('Pronoun resolution (LLM topic extraction)', () => {
    it('should resolve "it" using conversation context', async () => {
      const result = await rewriteQuery(
        'make me a quiz on it',
        'Assistant: Photosynthesis is the process by which plants convert sunlight into energy.\nUser: what is photosynthesis?'
      );
      expect(result.wasRewritten).toBe(true);
      expect(result.rewrittenQuery.toLowerCase()).toContain('photosynthesis');
      expect(result.rewrittenQuery.toLowerCase()).toContain('quiz');
    }, 15_000);

    it('should resolve "this" using conversation context', async () => {
      const result = await rewriteQuery(
        'explain this more',
        'Assistant: The Krebs cycle produces ATP through a series of chemical reactions.\nUser: what is the Krebs cycle?'
      );
      expect(result.wasRewritten).toBe(true);
      expect(result.rewrittenQuery.toLowerCase()).toContain('krebs');
    }, 15_000);

    it('should resolve "that" using conversation context', async () => {
      const result = await rewriteQuery(
        'quiz me on that',
        'Assistant: Binary search trees maintain sorted order for efficient lookup.\nUser: how do binary search trees work?'
      );
      expect(result.wasRewritten).toBe(true);
      expect(result.rewrittenQuery.toLowerCase()).toContain('binary search');
    }, 15_000);
  });

  describe('Implicit references (LLM topic extraction)', () => {
    it('should expand bare "explain" with the topic', async () => {
      const result = await rewriteQuery(
        'explain',
        'Assistant: Gradient descent is an optimization algorithm used in machine learning.\nUser: what is gradient descent?'
      );
      expect(result.wasRewritten).toBe(true);
      expect(result.rewrittenQuery.toLowerCase()).toContain('gradient');
      expect(result.rewrittenQuery.toLowerCase()).toContain('explain');
    }, 15_000);

    it('should expand "elaborate" with the topic', async () => {
      const result = await rewriteQuery(
        'elaborate',
        'Assistant: DNA replication involves unwinding the double helix and copying each strand.\nUser: how does DNA replication work?'
      );
      expect(result.wasRewritten).toBe(true);
      expect(result.rewrittenQuery.toLowerCase()).toContain('dna');
      expect(result.rewrittenQuery.toLowerCase()).toContain('elaborate');
    }, 15_000);
  });

  describe('Query structure preservation', () => {
    it('should preserve "make me a quiz on" structure after substitution', async () => {
      const result = await rewriteQuery(
        'make me a quiz on it',
        'Assistant: Photosynthesis converts light energy into chemical energy.\nUser: tell me about photosynthesis'
      );
      expect(result.wasRewritten).toBe(true);
      // Should start with the original structure, not be completely rewritten
      expect(result.rewrittenQuery.toLowerCase()).toMatch(/^make me a quiz on/);
    }, 15_000);

    it('should preserve "test me on" structure after substitution', async () => {
      const result = await rewriteQuery(
        'test me on that',
        'Assistant: The water cycle describes the continuous movement of water within Earth.\nUser: explain the water cycle'
      );
      expect(result.wasRewritten).toBe(true);
      expect(result.rewrittenQuery.toLowerCase()).toMatch(/^test me on/);
    }, 15_000);
  });
});
