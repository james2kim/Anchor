import type { WorkflowTool, RouteResult } from './types';
import { quizTool } from './tools/quizTool';

/**
 * All registered workflow tools.
 * Adding a new workflow = append to this array and define its keywords.
 * Routing scores all tools by keyword match count; highest score wins.
 */
export const REGISTERED_TOOLS: readonly WorkflowTool[] = [
  quizTool,
  // flashcardTool,
  // studyPlanTool,
];

/**
 * Returns a user-facing summary of all registered workflows.
 * Used when routing finds no match so the user knows what's possible.
 */
export const getAvailableWorkflows = (): string[] =>
  REGISTERED_TOOLS.map((t) => t.description);

/**
 * Looks up a registered tool by name.
 * Returns null if no tool matches.
 */
export const getToolByName = (name: string): WorkflowTool | null =>
  REGISTERED_TOOLS.find((t) => t.name === name) ?? null;

/**
 * Routes a query to a workflow tool via keyword scoring.
 * Scores all tools by counting keyword matches; highest score wins.
 * Ties broken by registration order. Returns null if no tool matches.
 */
export const routeToTool = (query: string): RouteResult | null => {
  let bestTool: WorkflowTool | null = null;
  let bestScore = 0;
  const matches: { name: string; score: number }[] = [];

  for (const tool of REGISTERED_TOOLS) {
    const score = tool.keywords.reduce((n, kw) => {
      kw.lastIndex = 0; // Guard against /g flag statefulness
      return n + (kw.test(query) ? 1 : 0);
    }, 0);
    if (score > 0) {
      matches.push({ name: tool.name, score });
      if (score > bestScore) {
        bestScore = score;
        bestTool = tool;
      }
    }
  }

  if (!bestTool) {
    console.log('[workflowRouting] No keyword match');
    return null;
  }

  if (matches.length > 1) {
    console.log(
      `[workflowRouting] Multi-match: ${matches.map((m) => `${m.name}(${m.score})`).join(', ')}. Winner: ${bestTool.name}`
    );
  } else {
    console.log(`[workflowRouting] Matched "${bestTool.name}" (score=${bestScore})`);
  }

  return { tool: bestTool, method: 'deterministic' };
};
