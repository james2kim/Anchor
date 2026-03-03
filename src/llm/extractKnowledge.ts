import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { sonnetModel } from '../agent/constants';
import { withRetry } from '../util/RetryUtil';

import { knowledgeExtractionSchema, type KnowledgeExtraction } from '../schemas/types';

const KNOWLEDGE_EXTRACTION_PROMPT = `You are a knowledge classification and extraction module inside a persistent memory system. Your job is to analyze user input and determine what type of content it is and how it should be stored.

## Content Type Classification

Classify the input into exactly ONE of these categories:

### "study_material"
Factual, educational, or reference content that the user wants to learn or store for later retrieval. This includes:
- Notes, summaries, or explanations of topics
- Definitions, formulas, or concepts
- Content copied from textbooks, articles, or other sources
- Lists of facts, dates, or information to memorize
- Technical documentation or code explanations

Examples:
- "Mitochondria is the powerhouse of the cell. It produces ATP through oxidative phosphorylation..."
- "The French Revolution began in 1789 and ended in 1799..."
- "Here are the key points from chapter 5: 1. Supply and demand... 2. Market equilibrium..."

### "personal_memory"
Information about the user themselves - their preferences, goals, decisions, or personal facts. This includes:
- User preferences ("I prefer studying in the morning")
- User goals ("I want to pass my biology exam")
- User decisions ("I decided to focus on chapter 3 first")
- Facts about the user ("I'm a medical student")

### "ephemeral"
Conversational content that doesn't need to be stored:
- Greetings ("Hello", "Thanks", "OK")
- Questions to the assistant ("Can you explain this?", "What does this mean?")
- Commands or requests ("Summarize this for me")
- Acknowledgments or small talk

## Extraction Rules

1. **For study_material**: Extract a clear title and the full content. Include subject area if obvious.

2. **For personal_memory**: Extract discrete memory items using the memory schema (type, confidence, content). Follow the same rules as memory extraction - third person, self-contained, specific.

3. **For ephemeral**: No extraction needed, just classify.

## Important Guidelines

- If the input contains BOTH study material AND personal information, prioritize study_material if the bulk is educational content, or personal_memory if it's primarily about the user with some facts mixed in.
- Study material should be substantial (not just a single sentence unless it's a definition).
- When in doubt between study_material and personal_memory, ask: "Is this content the user wants to reference/learn, or is it about the user themselves?"
- Be conservative with personal_memory extraction - only extract what's clearly about the user.`;

const modelWithKnowledgeStructure = sonnetModel.withStructuredOutput(knowledgeExtractionSchema);

export const extractKnowledge = async (input: string): Promise<KnowledgeExtraction | null> => {
  try {
    const response = await withRetry(
      () => modelWithKnowledgeStructure.invoke([
        { role: 'system', content: KNOWLEDGE_EXTRACTION_PROMPT },
        { role: 'user', content: input },
      ]),
      { label: 'extractKnowledge' }
    );
    return response;
  } catch (err) {
    // Haiku sometimes struggles with nested structured outputs
    // Log and return null rather than crashing
    console.warn(
      '[extractKnowledge] Failed to parse extraction, skipping:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
};
