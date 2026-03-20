import { StateGraph, START, END } from '@langchain/langgraph';
import { AgentStateSchema } from '../schemas/types';
import { RedisCheckpointer } from '../memory/RedisCheckpointer';
import {
  retrievalGate,
  retrieveMemoriesAndChunks,
  injectContext,
  clarificationResponse,
  executeWorkflow,
} from './nodes';
import { retrievalGateConditionalRouter, postRetrievalRouter } from './routers';

export function buildWorkflow(checkpointer: RedisCheckpointer) {
  const workflow = new StateGraph(AgentStateSchema)
    .addNode('retrievalGate', retrievalGate)
    .addNode('retrieveMemoriesAndChunks', retrieveMemoriesAndChunks)
    .addNode('injectContext', injectContext)
    .addNode('clarificationResponse', clarificationResponse)
    .addNode('executeWorkflow', executeWorkflow)
    .addEdge(START, 'retrievalGate')
    .addConditionalEdges('retrievalGate', retrievalGateConditionalRouter)
    .addConditionalEdges('retrieveMemoriesAndChunks', postRetrievalRouter)
    .addEdge('injectContext', END) // Knowledge extraction runs in background
    .addEdge('clarificationResponse', END)
    .addEdge('executeWorkflow', END);

  return workflow.compile({ checkpointer });
}
