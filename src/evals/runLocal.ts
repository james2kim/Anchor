/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Local Smoke Test Runner
 *
 * Runs smoke tests locally without LangSmith integration.
 * Useful for quick iteration before pushing to LangSmith.
 *
 * Usage:
 *   npx tsx src/evals/runLocal.ts
 *   npx tsx src/evals/runLocal.ts --category off_topic
 *   npx tsx src/evals/runLocal.ts --verbose
 *
 * Prerequisites:
 *   Run `npx tsx src/evals/seed.ts` first to seed test data.
 */

// Load env BEFORE any other imports (must be synchronous)
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { EVAL_USER_ID } from './fixtures/evalDocuments.js';

// Use separate LangSmith project for eval traces
process.env.LANGCHAIN_PROJECT = 'study-agent-evals';

// Now import everything else
import * as crypto from 'crypto';
import {
  SMOKE_TEST_DATASET,
  getTestCasesBySplit,
  getTestCasesByCategory,
  type SmokeTestCase,
  type Category,
} from './dataset.js';
import { runEvaluators, calculateOverallScore, type AgentOutput } from './evaluators.js';

// Dynamic imports for modules that depend on env vars
const loadAgentModules = async () => {
  const { buildWorkflow } = await import('../agent/graph.js');
  const { RedisSessionStore } = await import('../stores/RedisSessionStore.js');
  const { RedisCheckpointer } = await import('../memory/RedisCheckpointer.js');
  return { buildWorkflow, RedisSessionStore, RedisCheckpointer };
};

interface TestResult {
  query: string;
  category: string;
  expectedBehavior: string;
  response: string;
  passed: boolean;
  score: number;
  weightedScore: number;
  details: string;
  durationMs: number;
}

interface AgentRunResult {
  output: AgentOutput;
  durationMs: number;
}

async function invokeAgent(
  query: string,
  sessionId: string,
  agentApp: any
): Promise<any> {
  const userMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: query,
    createdAt: new Date().toISOString(),
  };

  return agentApp.invoke(
    {
      messages: [userMessage],
      userQuery: query,
      userId: EVAL_USER_ID,
      sessionId,
    },
    { configurable: { thread_id: sessionId } }
  );
}

async function runAgent(
  testCase: SmokeTestCase,
  agentApp: any,
  RedisSessionStore: any
): Promise<AgentRunResult> {
  const sessionId = `local-eval-${crypto.randomUUID()}`;

  try {
    // Run conversation setup messages first (multi-turn)
    if (testCase.conversation_setup?.length) {
      for (const setupQuery of testCase.conversation_setup) {
        await invokeAgent(setupQuery, sessionId, agentApp);
      }
    }

    // Run the actual test query
    const startTime = Date.now();
    const result = await invokeAgent(testCase.userQuery, sessionId, agentApp);
    const durationMs = Date.now() - startTime;

    // Clean up session
    try {
      await RedisSessionStore.getClient().del(`session:${sessionId}`);
      await RedisSessionStore.getClient().del(`checkpoint:${sessionId}:latest`);
    } catch {
      // Ignore cleanup errors
    }

    return {
      output: {
        response: result?.response || '',
        trace: result?.trace,
        gateDecision: result?.gateDecision,
        workflowData: result?.workflowData,
      },
      durationMs,
    };
  } catch (error) {
    return {
      output: {
        response: `ERROR: ${error}`,
      },
      durationMs: 0,
    };
  }
}

async function runTests(
  testCases: SmokeTestCase[],
  agentApp: any,
  RedisSessionStore: any,
  verbose: boolean
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    process.stdout.write(
      `\r[${i + 1}/${testCases.length}] Testing: ${tc.userQuery.slice(0, 40)}...`
    );

    const { output, durationMs } = await runAgent(tc, agentApp, RedisSessionStore);
    const evalResults = runEvaluators(output, tc, durationMs);
    const overall = calculateOverallScore(evalResults);

    results.push({
      query: tc.userQuery,
      category: tc.category,
      expectedBehavior: tc.expected_behavior,
      response: output.response,
      passed: overall.passed,
      score: overall.score,
      weightedScore: overall.weightedScore,
      details: overall.summary,
      durationMs,
    });

    if (verbose || !overall.passed) {
      console.log(); // New line after progress
      const status = overall.passed ? '✓' : '✗';
      console.log(`${status} [${tc.category}] ${tc.userQuery}`);
      if (!overall.passed) {
        console.log(`  Expected: ${tc.expected_behavior}`);
        console.log(`  Response: ${output.response.slice(0, 150)}...`);
        console.log(`  Details: ${overall.summary}`);
      }
    }
  }

  console.log(); // Final newline
  return results;
}

function printSummary(results: TestResult[]) {
  console.log('\n' + '='.repeat(60));
  console.log('SMOKE TEST SUMMARY');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log(`\nTotal: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);
  console.log(`Pass Rate: ${((passed.length / results.length) * 100).toFixed(1)}%`);

  // Average weighted score
  const avgWeightedScore = results.reduce((sum, r) => sum + r.weightedScore, 0) / results.length;
  console.log(`Avg Weighted Score: ${(avgWeightedScore * 100).toFixed(1)}%`);

  // Group by category
  const byCategory = new Map<string, TestResult[]>();
  for (const r of results) {
    const existing = byCategory.get(r.category) || [];
    existing.push(r);
    byCategory.set(r.category, existing);
  }

  console.log('\nBy Category:');
  Array.from(byCategory.entries()).forEach(([category, catResults]) => {
    const catPassed = catResults.filter((r) => r.passed).length;
    const status = catPassed === catResults.length ? '✓' : '✗';
    console.log(`  ${status} ${category}: ${catPassed}/${catResults.length}`);
  });

  // Group by expected behavior
  const byBehavior = new Map<string, TestResult[]>();
  for (const r of results) {
    const existing = byBehavior.get(r.expectedBehavior) || [];
    existing.push(r);
    byBehavior.set(r.expectedBehavior, existing);
  }

  console.log('\nBy Expected Behavior:');
  Array.from(byBehavior.entries()).forEach(([behavior, behResults]) => {
    const behPassed = behResults.filter((r) => r.passed).length;
    const status = behPassed === behResults.length ? '✓' : '✗';
    console.log(`  ${status} ${behavior}: ${behPassed}/${behResults.length}`);
  });

  // Timing stats
  const durations = results.map((r) => r.durationMs);
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const maxDuration = Math.max(...durations);
  const minDuration = Math.min(...durations);

  console.log('\nTiming:');
  console.log(`  Avg: ${(avgDuration / 1000).toFixed(2)}s`);
  console.log(`  Min: ${(minDuration / 1000).toFixed(2)}s`);
  console.log(`  Max: ${(maxDuration / 1000).toFixed(2)}s`);
  console.log(`  Total: ${(durations.reduce((a, b) => a + b, 0) / 1000).toFixed(2)}s`);

  if (failed.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('FAILED TESTS:');
    console.log('='.repeat(60));
    for (const f of failed) {
      console.log(`\n✗ [${f.category}] ${f.query}`);
      console.log(`  Expected: ${f.expectedBehavior}`);
      console.log(`  Response: ${f.response.slice(0, 200)}...`);
      console.log(`  Details: ${f.details}`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let testCases = SMOKE_TEST_DATASET;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--split' && args[i + 1]) {
      testCases = getTestCasesBySplit(args[i + 1]);
      i++;
    } else if (args[i] === '--category' && args[i + 1]) {
      testCases = getTestCasesByCategory(args[i + 1] as Category);
      i++;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    }
  }

  if (testCases.length === 0) {
    console.error('No test cases found for the specified filter');
    process.exit(1);
  }

  console.log(`Running ${testCases.length} smoke tests...\n`);

  // Load agent modules (after env is loaded)
  const { buildWorkflow, RedisSessionStore, RedisCheckpointer } = await loadAgentModules();

  // Connect to Redis
  await RedisSessionStore.connect();
  const checkpointer = new RedisCheckpointer(RedisSessionStore);
  const agentApp = buildWorkflow(checkpointer);

  try {
    const results = await runTests(testCases, agentApp, RedisSessionStore, verbose);
    printSummary(results);

    // Exit with error code if any tests failed
    const failed = results.filter((r) => !r.passed);
    process.exit(failed.length > 0 ? 1 : 0);
  } finally {
    await RedisSessionStore.disconnect();
  }
}

main().catch(console.error);
