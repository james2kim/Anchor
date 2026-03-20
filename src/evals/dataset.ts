/**
 * Smoke Test Dataset for LangSmith Experiments
 *
 * Categories:
 * - study_content: Questions about documents/study materials → ANSWER
 * - personal: Questions about user's personal info/memories → ANSWER
 * - temporal_containment: Time-bound questions → ANSWER
 * - off_topic: Lifestyle/opinion questions → REFUSE
 * - unclear: Ambiguous queries → CLARIFY
 *
 * Expected behaviors:
 * - ANSWER: Should provide a substantive answer
 * - REFUSE: Should politely decline/redirect
 * - CLARIFY: Should ask for clarification
 */

export type ExpectedBehavior = 'ANSWER' | 'REFUSE' | 'CLARIFY';

export type Category =
  | 'study_content'
  | 'personal'
  | 'temporal_containment'
  | 'off_topic'
  | 'unclear'
  | 'general_knowledge'
  | 'conversational'
  | 'workflow';

export interface SmokeTestCase {
  userQuery: string;
  category: Category;
  expected_behavior: ExpectedBehavior;
  // Assertion fields
  answer_includes?: string[];
  answer_must_contain_any?: string[];
  answer_should_contain?: string[];
  answer_must_not_contain?: string[];
  must_cover?: string[];
  expected_amount_usd?: number;
  dataset_split?: string[];
  // Workflow-specific fields
  expected_workflow_tool?: string;
  quiz_topic_keywords?: string[];
  // Multi-turn: prior messages to send before the test query (same session)
  conversation_setup?: string[];
}

export const SMOKE_TEST_DATASET: SmokeTestCase[] = [
  // === TEMPORAL CONTAINMENT ===
  {
    userQuery: 'What did I do in 2023?',
    category: 'temporal_containment',
    expected_behavior: 'ANSWER',
    answer_must_contain_any: ['DataFlow'],
    // Ensure it's an affirmative answer, not "I don't know about DataFlow"
    answer_must_not_contain: ["don't have information", "don't know", 'no record', 'unable to find'],
    dataset_split: ['base'],
  },

  // === OFF-TOPIC (Should REFUSE) ===
  {
    userQuery: 'Can I get some advice on what stocks to invest in?',
    category: 'off_topic',
    expected_behavior: 'REFUSE',
    dataset_split: ['base'],
  },
  {
    userQuery: 'Should I wear blue or black jeans?',
    category: 'off_topic',
    expected_behavior: 'REFUSE',
    dataset_split: ['base'],
  },
  {
    userQuery: 'Do you think I should take dutasteride over finasteride?',
    category: 'off_topic',
    expected_behavior: 'REFUSE',
    dataset_split: ['base'],
  },
  {
    userQuery: 'Is pineapple good on pizza?',
    category: 'off_topic',
    expected_behavior: 'REFUSE',
    dataset_split: ['base'],
  },

  // === UNCLEAR (Should CLARIFY) ===
  {
    userQuery: 'What was that again?',
    category: 'unclear',
    expected_behavior: 'CLARIFY',
    dataset_split: ['base'],
  },
  {
    userQuery: 'I need more information',
    category: 'unclear',
    expected_behavior: 'CLARIFY',
    dataset_split: ['base'],
  },
  {
    userQuery: 'Can you help me with this?',
    category: 'unclear',
    expected_behavior: 'CLARIFY',
    dataset_split: ['base'],
  },

  // === STUDY CONTENT (Should ANSWER) ===
  {
    userQuery: 'is finasteride > dutasteride?',
    category: 'study_content',
    expected_behavior: 'ANSWER',
    // Should indicate dutasteride is more effective (the question asks if finasteride > dutasteride, answer should be NO)
    answer_must_contain_any: ['dutasteride'],
    // Ensure response indicates dutasteride is better, not finasteride
    answer_must_not_contain: ['finasteride is more effective', 'finasteride outperforms', 'finasteride is superior'],
    dataset_split: ['base'],
  },
  {
    userQuery: 'Why is context in the middle bad?',
    category: 'study_content',
    expected_behavior: 'ANSWER',
    answer_must_contain_any: [
      'middle',
      'position',
      'primacy',
      'recency',
      'attention',
      'performance',
    ],
    dataset_split: ['base'],
  },
  {
    userQuery: 'What is ReAct?',
    category: 'study_content',
    expected_behavior: 'ANSWER',
    answer_must_contain_any: ['reasoning', 'acting', 'tool', 'observation'],
    dataset_split: ['base'],
  },
  {
    userQuery: 'What is React?',
    category: 'study_content',
    expected_behavior: 'ANSWER',
    must_cover: [
      'JavaScript library',
      'user interfaces',
      'component-based',
      'developed by Facebook or Meta',
    ],
    dataset_split: ['base'],
  },

  // === PERSONAL (Should ANSWER with user-specific info) ===
  {
    userQuery: 'How much was my severance again?',
    category: 'personal',
    expected_behavior: 'ANSWER',
    expected_amount_usd: 42500,
    dataset_split: ['base'],
  },
  {
    userQuery: 'What is my career goal?',
    category: 'personal',
    expected_behavior: 'ANSWER',
    answer_must_contain_any: ['machine learning', 'ML', 'NLP', 'engineer'],
    answer_must_not_contain: ["don't have", "don't know", 'no information'],
    dataset_split: ['base'],
  },
  {
    userQuery: 'What is my preferred programming language?',
    category: 'personal',
    expected_behavior: 'ANSWER',
    answer_should_contain: ['Python'],
    answer_must_not_contain: ["don't have", "don't know", 'no information'],
    dataset_split: ['base'],
  },
  {
    userQuery: 'Where did I work in 2021?',
    category: 'personal',
    expected_behavior: 'ANSWER',
    answer_should_contain: ['Sunrise'],
    // Ensure it's affirmative, not "I don't see Sunrise Labs in your records"
    answer_must_not_contain: ["don't have", "don't see", 'no record', 'unable to find', "couldn't find"],
    dataset_split: ['base'],
  },

  // === WORKFLOW: SINGLE-TURN (Should generate quiz) ===
  {
    userQuery: 'Make me a 3 question quiz about why context in the middle is bad',
    category: 'workflow',
    expected_behavior: 'ANSWER',
    expected_workflow_tool: 'quiz_generation',
    quiz_topic_keywords: ['middle', 'context', 'position', 'primacy', 'recency', 'attention'],
    dataset_split: ['base'],
  },
  {
    userQuery: 'Quiz me on the ReAct framework with 3 questions',
    category: 'workflow',
    expected_behavior: 'ANSWER',
    expected_workflow_tool: 'quiz_generation',
    quiz_topic_keywords: ['react', 'reasoning', 'acting', 'tool', 'observation', 'agent'],
    dataset_split: ['base'],
  },
  {
    userQuery: 'Create a true/false practice test about React with 3 questions',
    category: 'workflow',
    expected_behavior: 'ANSWER',
    expected_workflow_tool: 'quiz_generation',
    quiz_topic_keywords: ['react', 'component', 'virtual dom', 'javascript', 'ui', 'jsx'],
    dataset_split: ['base'],
  },

  // === WORKFLOW: MULTI-TURN (Context inference) ===
  {
    userQuery: 'make me a quiz on it',
    category: 'workflow',
    expected_behavior: 'ANSWER',
    expected_workflow_tool: 'quiz_generation',
    conversation_setup: [
      'Why is context in the middle bad for language models?',
    ],
    quiz_topic_keywords: ['middle', 'context', 'position', 'primacy', 'recency', 'performance'],
    dataset_split: ['base'],
  },
  {
    userQuery: 'quiz me on that',
    category: 'workflow',
    expected_behavior: 'ANSWER',
    expected_workflow_tool: 'quiz_generation',
    conversation_setup: [
      'make me a quiz on React',
      'What is the ReAct framework and how does it work?',
    ],
    // Should be about ReAct (most recent topic), NOT React library
    quiz_topic_keywords: ['react', 'reasoning', 'acting', 'tool', 'observation', 'agent'],
    answer_must_not_contain: ['virtual dom', 'jsx', 'component-based'],
    dataset_split: ['base'],
  },

  // === MULTI-TURN: CONTEXT-AWARE CLARIFICATION (should ANSWER, not CLARIFY) ===
  {
    userQuery: 'I need more information',
    category: 'study_content',
    expected_behavior: 'ANSWER',
    conversation_setup: [
      'What is the ReAct framework?',
      'How does it combine reasoning and acting?',
    ],
    // With prior context about ReAct, "I need more information" should be resolved
    // to "I need more information about ReAct" and answered, NOT routed to clarify.
    answer_must_contain_any: ['react', 'reasoning', 'acting', 'tool', 'observation', 'agent'],
    answer_must_not_contain: ['could you clarify', 'could you be more specific', 'what topic'],
    dataset_split: ['base'],
  },
];

/**
 * Get test cases by split (e.g., 'base', 'extended')
 */
export const getTestCasesBySplit = (split: string): SmokeTestCase[] => {
  return SMOKE_TEST_DATASET.filter((tc) => tc.dataset_split?.includes(split));
};

/**
 * Get test cases by category
 */
export const getTestCasesByCategory = (category: Category): SmokeTestCase[] => {
  return SMOKE_TEST_DATASET.filter((tc) => tc.category === category);
};

/**
 * Get test cases by expected behavior
 */
export const getTestCasesByBehavior = (behavior: ExpectedBehavior): SmokeTestCase[] => {
  return SMOKE_TEST_DATASET.filter((tc) => tc.expected_behavior === behavior);
};
