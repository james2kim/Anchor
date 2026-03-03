import {
  RetrievalGateAssessment,
  RetrievalGateDecision,
  retrievalGateAssessmentSchema,
} from '../schemas/types';
import { haikuModel } from '../agent/constants';
import { withRetry } from '../util/RetryUtil';

const SYSTEM_PROMPT = `Classify this query for a study assistant.

queryType:
- study_content: questions about documents, notes, academic topics, learning materials
- personal: about user's goals, preferences, progress ("my goal", "what I said")
- general_knowledge: simple facts (capitals, math, definitions)
- conversational: greetings, thanks, meta ("hi", "what can you do?")
- off_topic: lifestyle/life advice unrelated to studying ("should I nap?", "what to wear")
- unclear: vague, ambiguous, or impossible to classify ("I need information")

referencesPersonalContext: true if query mentions "my", "I", or user-specific info

Examples:
"Explain photosynthesis" → study_content, false
"What's my main goal?" → personal, true
"What is 2+2?" → general_knowledge, false
"Thanks!" → conversational, false
"Should I take a nap?" → off_topic, false`;

const modelWithSchema = haikuModel.withStructuredOutput(retrievalGateAssessmentSchema);

/**
 * Rule-based pre-filter for obvious query types.
 * Returns assessment if pattern matches, null if LLM should decide.
 * Saves LLM calls for 60-70% of queries.
 */
const ruleBasedClassify = (query: string): RetrievalGateAssessment | null => {
  const q = query.trim();
  const lower = q.toLowerCase();

  // Conversational - greetings, thanks, meta
  if (/^(hi|hello|hey|thanks|thank you|bye|goodbye)[\s!.,?]*$/i.test(q)) {
    return {
      queryType: 'conversational',
      referencesPersonalContext: false,
      reasoning: 'rule: greeting/thanks',
    };
  }
  if (/^(what can you do|how do you work|help me|who are you)[\s?]*$/i.test(lower)) {
    return {
      queryType: 'conversational',
      referencesPersonalContext: false,
      reasoning: 'rule: meta question',
    };
  }

  // Personal statements - "I am/like/prefer/want/study/work/have..."
  if (/^i\s+(am|like|prefer|want|need|study|work|have|live|go|usually|always|never)\b/i.test(q)) {
    return {
      queryType: 'personal',
      referencesPersonalContext: true,
      reasoning: 'rule: personal statement',
    };
  }

  // Personal questions - "my goal", "my schedule", "what did I say"
  if (/\b(my|i)\b/i.test(q) && /\?$/.test(q)) {
    return {
      queryType: 'personal',
      referencesPersonalContext: true,
      reasoning: 'rule: personal question',
    };
  }
  if (/^(what('s| is| are| was| were) my|where did i|when did i|how did i)/i.test(lower)) {
    return {
      queryType: 'personal',
      referencesPersonalContext: true,
      reasoning: 'rule: personal question',
    };
  }

  // Study content - explicit topic questions
  // "give me", "show me", "tell me" imply personalization
  if (
    /^(explain|describe|summarize|what is|what are|how does|how do|why does|why do)\s+/i.test(q)
  ) {
    const hasPersonal = /\b(my|me|i)\b/i.test(q);
    if (!hasPersonal) {
      return {
        queryType: 'study_content',
        referencesPersonalContext: false,
        reasoning: 'rule: topic question',
      };
    }
  }

  // "give me", "show me", "tell me" + topic = study content with personal context
  if (/^(give me|show me|tell me|help me)\s+/i.test(q)) {
    return {
      queryType: 'study_content',
      referencesPersonalContext: true,
      reasoning: 'rule: personal request',
    };
  }

  // General knowledge - simple factual questions
  if (
    /^(what is|who is|when was|where is)\s+(the\s+)?(capital|president|population|date|year|definition)/i.test(
      q
    )
  ) {
    return {
      queryType: 'general_knowledge',
      referencesPersonalContext: false,
      reasoning: 'rule: factual question',
    };
  }

  // Off-topic - lifestyle advice patterns
  if (/\b(should i|would you recommend).*(wear|eat|buy|invest|date|sleep|nap)\b/i.test(lower)) {
    return {
      queryType: 'off_topic',
      referencesPersonalContext: false,
      reasoning: 'rule: lifestyle advice',
    };
  }

  // No rule matched - let LLM decide
  return null;
};

const createFallbackAssessment = (query: string): RetrievalGateAssessment => ({
  queryType: 'unclear',
  referencesPersonalContext: false,
  reasoning: `Fallback for: "${query.slice(0, 30)}"`,
});

/**
 * Classifies a query for routing decisions.
 * Uses rule-based filter first, falls back to LLM for ambiguous cases.
 */
export const retrievalGateAssessor = async (query: string): Promise<RetrievalGateAssessment> => {
  // Try rule-based classification first (fast, free)
  const ruleResult = ruleBasedClassify(query);
  if (ruleResult) {
    return ruleResult;
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
    return result;
  } catch (error) {
    console.warn('[retrievalGateAssessor] Failed, using fallback:', error);
    return createFallbackAssessment(query);
  }
};

/**
 * Determines retrieval strategy based on query classification.
 */
export const retrievalGatePolicy = (assessment: RetrievalGateAssessment): RetrievalGateDecision => {
  const { queryType, referencesPersonalContext } = assessment;

  // Off-topic: no retrieval, redirect (not clarification)
  if (queryType === 'off_topic') {
    return {
      shouldRetrieveDocuments: false,
      shouldRetrieveMemories: false,
      memoryBudget: 'minimal',
      needsClarification: false,
      reasoning: 'off_topic - redirect',
    };
  }

  // Unclear: no retrieval, ask clarifying question
  if (queryType === 'unclear') {
    return {
      shouldRetrieveDocuments: false,
      shouldRetrieveMemories: false,
      memoryBudget: 'minimal',
      needsClarification: true,
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
    reasoning: `study_content - retrieve docs + memories (${referencesPersonalContext ? 'full' : 'minimal'} budget)`,
  };
};
