import {
  RetrievalGateAssessment,
  RetrievalGateDecision,
  retrievalGateAssessmentSchema,
} from '../schemas/types';
import { haikuModel } from '../agent/constants';
import { withRetry } from '../util/RetryUtil';
import { routeToTool } from '../workflows/registry';

const SYSTEM_PROMPT = `Classify this query for a study assistant.

queryType:
- study_content: questions about documents, notes, academic topics, learning materials
- personal: about user's goals, preferences, progress ("my goal", "what I said")
- general_knowledge: simple facts (capitals, math, definitions)
- conversational: greetings, thanks, meta ("hi", "what can you do?")
- workflow: requests to create, generate, or build something (quizzes, flashcards, study plans, practice tests)
- off_topic: lifestyle/life advice unrelated to studying ("should I nap?", "what to wear")
- unclear: vague, ambiguous, or impossible to classify ("I need information")

referencesPersonalContext: true if query mentions "my", "I", or user-specific info

Examples:
"Explain photosynthesis" → study_content, false
"What's my main goal?" → personal, true
"What is 2+2?" → general_knowledge, false
"Thanks!" → conversational, false
"Make me a quiz about photosynthesis" → workflow, false
"Should I take a nap?" → off_topic, false`;

const modelWithSchema = haikuModel.withStructuredOutput(retrievalGateAssessmentSchema);

interface RuleBasedResult {
  assessment: RetrievalGateAssessment;
  matchedToolName?: string;
}

/**
 * Rule-based pre-filter for obvious query types.
 * Returns assessment if pattern matches, null if LLM should decide.
 * Saves LLM calls for 60-70% of queries.
 */
const ruleBasedClassify = (query: string): RuleBasedResult | null => {
  const q = query.trim();
  const lower = q.toLowerCase();

  // Conversational - greetings, thanks, meta
  if (/^(hi|hello|hey|thanks|thank you|bye|goodbye)[\s!.,?]*$/i.test(q)) {
    return { assessment: {
      queryType: 'conversational',
      referencesPersonalContext: false,
      reasoning: 'rule: greeting/thanks',
    }};
  }
  if (/^(what can you do|how do you work|help me|who are you)[\s?]*$/i.test(lower)) {
    return { assessment: {
      queryType: 'conversational',
      referencesPersonalContext: false,
      reasoning: 'rule: meta question',
    }};
  }

  // Off-topic - lifestyle/personal advice patterns (must run BEFORE personal rules
  // because "should I ... ?" matches both off-topic and personal question patterns)
  if (/\b(should i|would you recommend|can i get.*(advice|recommendation)).*(wear|eat|buy|invest|date|sleep|nap|stock)\b/i.test(lower)) {
    return { assessment: {
      queryType: 'off_topic',
      referencesPersonalContext: false,
      reasoning: 'rule: lifestyle advice',
    }};
  }
  if (/\b(should i|do you think i should)\s+take\b/i.test(lower) && !/\b(notes?|test|exam|class|course)\b/i.test(lower)) {
    return { assessment: {
      queryType: 'off_topic',
      referencesPersonalContext: false,
      reasoning: 'rule: personal medical/supplement advice',
    }};
  }

  // Unclear - vague requests that need clarification (must run BEFORE personal statements
  // because "I need more information" matches "I need..." personal pattern)
  if (/^i\s+need\s+(more\s+)?(information|info|details|help|context)\s*\.?$/i.test(q)) {
    return { assessment: {
      queryType: 'unclear',
      referencesPersonalContext: false,
      reasoning: 'rule: vague request needing clarification',
    }};
  }

  // Personal statements - "I am/like/prefer/want/study/work/have..."
  if (/^i\s+(am|like|prefer|want|need|study|work|have|live|go|usually|always|never)\b/i.test(q)) {
    return { assessment: {
      queryType: 'personal',
      referencesPersonalContext: true,
      reasoning: 'rule: personal statement',
    }};
  }

  // Personal questions - "my goal", "my schedule", "what did I say"
  if (/\b(my|i)\b/i.test(q) && /\?$/.test(q)) {
    return { assessment: {
      queryType: 'personal',
      referencesPersonalContext: true,
      reasoning: 'rule: personal question',
    }};
  }
  if (/^(what('s| is| are| was| were) my|where did i|when did i|how did i)/i.test(lower)) {
    return { assessment: {
      queryType: 'personal',
      referencesPersonalContext: true,
      reasoning: 'rule: personal question',
    }};
  }

  // Workflow - delegate to the tool registry as single source of truth
  const workflowRoute = routeToTool(q);
  if (workflowRoute) {
    return {
      assessment: {
        queryType: 'workflow',
        referencesPersonalContext: false,
        reasoning: 'rule: matched registered workflow tool',
      },
      matchedToolName: workflowRoute.tool.name,
    };
  }

  // Study content - explicit topic questions
  // "give me", "show me", "tell me" imply personalization
  if (
    /^(explain|describe|summarize|what is|what are|how does|how do|why does|why do)\s+/i.test(q)
  ) {
    const hasPersonal = /\b(my|me|i)\b/i.test(q);
    if (!hasPersonal) {
      return { assessment: {
        queryType: 'study_content',
        referencesPersonalContext: false,
        reasoning: 'rule: topic question',
      }};
    }
  }

  // "give me", "show me", "tell me" + topic = study content with personal context
  if (/^(give me|show me|tell me|help me)\s+/i.test(q)) {
    return { assessment: {
      queryType: 'study_content',
      referencesPersonalContext: true,
      reasoning: 'rule: personal request',
    }};
  }

  // General knowledge - simple factual questions
  if (
    /^(what is|who is|when was|where is)\s+(the\s+)?(capital|president|population|date|year|definition)/i.test(
      q
    )
  ) {
    return { assessment: {
      queryType: 'general_knowledge',
      referencesPersonalContext: false,
      reasoning: 'rule: factual question',
    }};
  }

  // No rule matched - let LLM decide
  return null;
};

const createFallbackAssessment = (query: string): RetrievalGateAssessment => ({
  queryType: 'unclear',
  referencesPersonalContext: false,
  reasoning: `Fallback for: "${query.slice(0, 30)}"`,
});

export interface AssessorResult {
  assessment: RetrievalGateAssessment;
  matchedWorkflowTool?: string;
}

/**
 * Classifies a query for routing decisions.
 * Uses rule-based filter first, falls back to LLM for ambiguous cases.
 */
export const retrievalGateAssessor = async (query: string): Promise<AssessorResult> => {
  // Try rule-based classification first (fast, free)
  const ruleResult = ruleBasedClassify(query);
  if (ruleResult) {
    return {
      assessment: ruleResult.assessment,
      matchedWorkflowTool: ruleResult.matchedToolName,
    };
  }

  // Fall back to LLM for ambiguous queries
  try {
    const result = await withRetry(
      () => modelWithSchema.invoke([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: query },
      ]),
      { label: 'retrievalGateAssessor' }
    );
    console.log(`[retrievalGateAssessor] LLM-based: ${result.queryType}`);

    // When LLM says workflow, resolve the tool name now — the query may be
    // rewritten before executeWorkflow runs, breaking keyword matching.
    if (result.queryType === 'workflow') {
      const route = routeToTool(query);
      return { assessment: result, matchedWorkflowTool: route?.tool.name };
    }

    return { assessment: result };
  } catch (error) {
    console.warn('[retrievalGateAssessor] Failed, using fallback:', error);
    return { assessment: createFallbackAssessment(query) };
  }
};

/**
 * Determines retrieval strategy based on query classification.
 */
export const retrievalGatePolicy = (assessment: RetrievalGateAssessment): RetrievalGateDecision => {
  const { queryType, referencesPersonalContext } = assessment;

  // Workflow: retrieve context for generation, route to workflow executor
  if (queryType === 'workflow') {
    return {
      shouldRetrieveDocuments: true,
      shouldRetrieveMemories: true,
      memoryBudget: 'full',
      needsClarification: false,
      needsWorkflow: true,
      reasoning: 'workflow - retrieve context for generation',
    };
  }

  // Off-topic: no retrieval, route to clarificationResponse which handles refusal
  if (queryType === 'off_topic') {
    return {
      shouldRetrieveDocuments: false,
      shouldRetrieveMemories: false,
      memoryBudget: 'minimal',
      needsClarification: true,
      needsWorkflow: false,
      reasoning: 'off_topic - redirect to clarification/refusal',
    };
  }

  // Unclear: no retrieval, ask clarifying question
  if (queryType === 'unclear') {
    return {
      shouldRetrieveDocuments: false,
      shouldRetrieveMemories: false,
      memoryBudget: 'minimal',
      needsClarification: true,
      needsWorkflow: false,
      reasoning: 'unclear - clarify',
    };
  }

  // Conversational: no retrieval
  if (queryType === 'conversational') {
    return {
      shouldRetrieveDocuments: false,
      shouldRetrieveMemories: false,
      memoryBudget: 'minimal',
      needsClarification: false,
      needsWorkflow: false,
      reasoning: 'conversational - no retrieval',
    };
  }

  // General knowledge: retrieve documents in case we have relevant info
  if (queryType === 'general_knowledge') {
    return {
      shouldRetrieveDocuments: true,
      shouldRetrieveMemories: false,
      memoryBudget: 'minimal',
      needsClarification: false,
      needsWorkflow: false,
      reasoning: 'general_knowledge - retrieve documents',
    };
  }

  // Personal: retrieve both documents and memories with full budget
  if (queryType === 'personal') {
    return {
      shouldRetrieveDocuments: true,
      shouldRetrieveMemories: true,
      memoryBudget: 'full',
      needsClarification: false,
      needsWorkflow: false,
      reasoning: 'personal - retrieve documents and memories',
    };
  }

  // Study content: retrieve both documents and memories
  // Use full budget if explicitly personal, minimal otherwise
  return {
    shouldRetrieveDocuments: true,
    shouldRetrieveMemories: true,
    memoryBudget: referencesPersonalContext ? 'full' : 'minimal',
    needsClarification: false,
    needsWorkflow: false,
    reasoning: `study_content - retrieve docs + memories (${referencesPersonalContext ? 'full' : 'minimal'} budget)`,
  };
};
