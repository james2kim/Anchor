import type { AgentState } from '../schemas/types';
import { MAX_MESSAGES } from './constants';

export const retrievalGateConditionalRouter = (state: AgentState) => {
  if (state.gateDecision?.needsClarification) {
    return 'clarificationResponse';
  }
  // Workflow queries (needsWorkflow) also go through retrieval first
  // so executeWorkflow has document context available
  if (
    state.gateDecision?.shouldRetrieveDocuments ||
    state.gateDecision?.shouldRetrieveMemories ||
    state.gateDecision?.needsWorkflow
  ) {
    return 'retrieveMemoriesAndChunks';
  }
  return 'injectContext';
};

export const postRetrievalRouter = (state: AgentState) => {
  if (state.gateDecision?.needsWorkflow) return 'executeWorkflow';
  return 'injectContext';
};

export const shouldRunBackgroundSummarization = (state: AgentState): boolean => {
  return state.messages.length >= MAX_MESSAGES;
};
