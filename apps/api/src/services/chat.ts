import { asc, eq } from 'drizzle-orm';
import {
  conversations,
  messages as messagesTable,
  requestLogs,
  withTenant,
} from '@polyglot/db';
import { streamCompletion, type OrchestratedEvent, type RequestMetrics } from '@polyglot/providers';
import { getModel, loadConfig, type ContentBlock, type Message } from '@polyglot/core';
import { executeTool, toolDefinitions, type ToolContext } from '../tools/index.js';
import { buildGroundedSystemPrompt, defaultRetrievalSettings, retrieve, type RetrievedChunk } from './rag.js';

/**
 * The agentic loop: model asks for tools, we run them, we feed results back,
 * the model answers. Supports several sequential rounds in a single turn.
 *
 * The loop is provider-agnostic because it only ever sees StreamEvents and
 * ContentBlocks. Swapping Anthropic for Gemini mid-conversation changes
 * nothing here — that is the point of Module A.
 */

const MAX_TOOL_ROUNDS = 5;

export interface ChatTurnOptions {
  tenantId: string;
  conversationId: string;
  modelId: string;
  userContent: ContentBlock[];
  system?: string;
  collectionId?: string;
  enabledTools?: string[];
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
  /** Overrides the configured chain; [] disables fallback for this request. */
  fallbackChain?: string[];
}

export type ClientEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; status: 'started' | 'running' | 'done' | 'error'; input?: unknown; output?: string }
  | { type: 'citations'; chunks: Array<Omit<RetrievedChunk, 'similarity'> & { similarity: number; index: number }> }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | { type: 'metrics'; metrics: RequestMetrics }
  | { type: 'error'; kind: string; message: string }
  | { type: 'done'; messageId: string | null };

export async function* runChatTurn(opts: ChatTurnOptions): AsyncGenerator<ClientEvent> {
  const cfg = loadConfig();
  const embeddingModelId = cfg.defaults.embeddingModel;

  // ---- 1. load history and persist the user turn ---------------------------
  const history = await withTenant(opts.tenantId, async (tx) => {
    await tx.insert(messagesTable).values({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      role: 'user',
      content: opts.userContent,
    });
    await tx
      .update(conversations)
      .set({ updatedAt: new Date(), lastModelId: opts.modelId })
      .where(eq(conversations.id, opts.conversationId));

    return tx
      .select({ role: messagesTable.role, content: messagesTable.content })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, opts.conversationId))
      .orderBy(asc(messagesTable.createdAt));
  });

  const working: Message[] = history.map((m) => ({
    role: m.role as Message['role'],
    content: m.content as ContentBlock[],
  }));

  // ---- 2. optional pre-retrieval ------------------------------------------
  let system = opts.system;
  const citations: RetrievedChunk[] = [];

  if (opts.collectionId) {
    const queryText = opts.userContent.map((b) => b.text ?? '').join(' ').trim();
    const retrieved = await retrieve({
      tenantId: opts.tenantId,
      collectionId: opts.collectionId,
      query: queryText,
      settings: defaultRetrievalSettings(),
      embeddingModelId,
    });
    citations.push(...retrieved);
    system = buildGroundedSystemPrompt(retrieved, opts.system);
    if (retrieved.length > 0) {
      yield { type: 'citations', chunks: retrieved.map((c, i) => ({ ...c, index: i + 1 })) };
    } else {
      yield { type: 'notice', level: 'info', message: 'No relevant passages found; the model was told to say it does not know.' };
    }
  }

  const toolCtx: ToolContext = {
    tenantId: opts.tenantId,
    collectionId: opts.collectionId,
    embeddingModelId,
    signal: opts.signal,
    onRetrieved: (cs) => citations.push(...cs),
  };

  const model = getModel(opts.modelId);
  const tools = model.capabilities.tools ? toolDefinitions(opts.enabledTools) : undefined;
  if (!model.capabilities.tools && opts.enabledTools?.length) {
    yield { type: 'notice', level: 'warn', message: `${model.displayName} does not support tool calling, so tools are disabled for this turn.` };
  }

  // ---- 3. the loop ---------------------------------------------------------
  const allMetrics: RequestMetrics[] = [];
  let lastMessageId: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const assistantBlocks: ContentBlock[] = [];
    const pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let textBuffer = '';
    let finished = false;
    let errored = false;

    const stream = streamCompletion({
      request: {
        model: opts.modelId,
        messages: working,
        system,
        tools,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
      },
      fallbackChain: opts.fallbackChain,
      maxCostUsd: Number(process.env.MAX_COST_USD_PER_REQUEST ?? 0.5),
    });

    for await (const event of stream as AsyncGenerator<OrchestratedEvent>) {
      switch (event.type) {
        case 'text_delta':
          textBuffer += event.text;
          yield { type: 'text', text: event.text };
          break;
        case 'reasoning_delta':
          yield { type: 'reasoning', text: event.text };
          break;
        case 'tool_use_start':
          yield { type: 'tool_call', id: event.id, name: event.name, status: 'started' };
          break;
        case 'tool_use_complete':
          pendingToolCalls.push({ id: event.id, name: event.name, input: event.input });
          yield { type: 'tool_call', id: event.id, name: event.name, status: 'running', input: event.input };
          break;
        case 'provider_switch':
          yield { type: 'notice', level: 'warn', message: `${event.from} failed (${event.reason}); fell back to ${event.to}.` };
          break;
        case 'context_truncated':
          yield { type: 'notice', level: 'warn', message: `Conversation exceeded the context window; ${event.droppedCount} older message(s) were dropped.` };
          break;
        case 'metrics':
          allMetrics.push(event.metrics);
          yield { type: 'metrics', metrics: event.metrics };
          break;
        case 'error':
          errored = true;
          yield { type: 'error', kind: event.error.kind, message: event.error.message };
          break;
        case 'done':
          finished = event.finishReason !== 'tool_use';
          break;
      }
    }

    if (textBuffer) assistantBlocks.push({ type: 'text', text: textBuffer });
    for (const call of pendingToolCalls) {
      assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }

    if (assistantBlocks.length > 0) {
      const assistantMessage: Message = { role: 'assistant', content: assistantBlocks };
      working.push(assistantMessage);
      lastMessageId = await persistMessage(opts, assistantMessage, opts.modelId);
    }

    if (errored || pendingToolCalls.length === 0 || finished) break;

    // ---- execute tools, sequentially, and feed results back ---------------
    const resultBlocks: ContentBlock[] = [];
    for (const call of pendingToolCalls) {
      const { content, isError } = await executeTool(call.name, call.input, toolCtx);
      yield { type: 'tool_call', id: call.id, name: call.name, status: isError ? 'error' : 'done', output: content };
      resultBlocks.push({ type: 'tool_result', toolUseId: call.id, content, isError });
    }

    const toolMessage: Message = { role: 'tool', content: resultBlocks };
    working.push(toolMessage);
    await persistMessage(opts, toolMessage, opts.modelId);

    if (citations.length > 0) {
      yield {
        type: 'citations',
        chunks: dedupeChunks(citations).map((c, i) => ({ ...c, index: i + 1 })),
      };
    }
  }

  await logMetrics(opts, allMetrics);
  yield { type: 'done', messageId: lastMessageId };
}

async function persistMessage(opts: ChatTurnOptions, message: Message, modelId: string): Promise<string> {
  const [row] = await withTenant(opts.tenantId, (tx) =>
    tx
      .insert(messagesTable)
      .values({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        role: message.role,
        content: message.content,
        modelId,
      })
      .returning({ id: messagesTable.id }),
  );
  return row!.id;
}

async function logMetrics(opts: ChatTurnOptions, metrics: RequestMetrics[]): Promise<void> {
  if (metrics.length === 0) return;
  await withTenant(opts.tenantId, (tx) =>
    tx.insert(requestLogs).values(
      metrics.map((m) => ({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        modelId: m.modelId,
        provider: m.provider,
        ttftMs: m.ttftMs,
        totalMs: m.totalMs,
        inputTokens: m.usage.inputTokens,
        outputTokens: m.usage.outputTokens,
        cachedInputTokens: m.usage.cachedInputTokens ?? null,
        reasoningTokens: m.usage.reasoningTokens ?? null,
        costUsd: m.costUsd.toFixed(6),
        finishReason: m.finishReason,
        retryCount: m.retryCount,
        fallbackFrom: m.fallbackFrom,
        errorKind: m.errorKind ?? null,
      })),
    ),
  );
}

function dedupeChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
