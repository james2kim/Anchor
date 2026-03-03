import type { AgentState, FinalAction } from '../../schemas/types';
import { haikuModel } from '../constants';
import { TraceUtil } from '../../util/TraceUtil';
import { withRetry } from '../../util/RetryUtil';

const CLARIFICATION_SYSTEM_MESSAGE = `You are a Study Assistant Agent. The user asked something that is outside your core domain or requires clarification.

Your job:
1. Briefly acknowledge the question (1 sentence max)
2. Politely explain you're focused on study-related help
3. Offer to help with something in your domain

Keep it short - 2-3 sentences total. No lectures, no apologies, no emojis.

Examples:
- "Stock tips aren't really my area. I'm better at helping with your study goals - want to review any materials or check on your progress?"
- "I'd need more context to help with that. What specifically are you trying to learn or accomplish?"
- "That's outside my wheelhouse. Anything study-related I can help with?"`;

export const clarificationResponse = async (state: AgentState) => {
  const span = TraceUtil.startSpan('clarificationResponse');
  let trace = state.trace!;

  const aiMessage = await withRetry(
    () => haikuModel.invoke([
      { role: 'system', content: CLARIFICATION_SYSTEM_MESSAGE },
      { role: 'user', content: state.userQuery },
    ]),
    { label: 'clarificationResponse' }
  );

  const response =
    typeof aiMessage.content === 'string' ? aiMessage.content : JSON.stringify(aiMessage.content);

  trace = span.end(trace, {
    responseLength: response.length,
  });

  // Set final outcome - clarification requested
  trace = TraceUtil.setOutcome(trace, {
    status: 'clarified',
    reason: 'ambiguous_or_off_topic',
    triggeringSpan: 'retrievalGate',
  });

  // Prune trace at the end of the workflow to prevent bloat
  trace = TraceUtil.pruneTrace(trace);

  // Determine final action: REFUSE for off-topic, CLARIFY for ambiguous
  const gateSpan = trace.spans.find((s) => s.node === 'retrievalGate');
  const queryType = gateSpan?.meta?.queryType as string | undefined;
  const finalAction: FinalAction = queryType === 'off_topic' ? 'REFUSE' : 'CLARIFY';

  // Create trace summary for evaluations
  const traceSummary = TraceUtil.createTraceSummary(trace);

  return {
    messages: [aiMessage],
    response,
    trace,
    finalAction,
    traceSummary,
  };
};
