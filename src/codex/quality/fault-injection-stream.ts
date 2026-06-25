export interface ResponseStreamEvent {
  type: string;
  sequence_number?: number;
  [key: string]: unknown;
}

export type StreamFault =
  | { kind: 'throw_after'; afterEvents: number; message?: string }
  | { kind: 'truncate_after'; afterEvents: number }
  | { kind: 'drop_terminal_event' }
  | { kind: 'duplicate_sequence_number'; targetIndex: number; sequenceNumber?: number };

export interface FaultInjectedStreamSpec {
  label: string;
  events: ResponseStreamEvent[];
  faults?: StreamFault[];
}

export function createFaultInjectedStream(
  events: readonly ResponseStreamEvent[],
  faults: readonly StreamFault[] = [],
): AsyncIterable<ResponseStreamEvent> {
  const preparedEvents = applyNonRuntimeFaults(events, faults);
  const throwFault = faults.find((fault): fault is Extract<StreamFault, { kind: 'throw_after' }> => fault.kind === 'throw_after');
  const truncateFault = faults.find((fault): fault is Extract<StreamFault, { kind: 'truncate_after' }> => fault.kind === 'truncate_after');

  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      let thrown = false;

      return {
        async next(): Promise<IteratorResult<ResponseStreamEvent>> {
          if (throwFault && index >= throwFault.afterEvents && !thrown) {
            thrown = true;
            throw new Error(throwFault.message || 'Injected stream failure');
          }

          if (truncateFault && index >= truncateFault.afterEvents) {
            return { done: true, value: undefined };
          }

          if (index >= preparedEvents.length) {
            return { done: true, value: undefined };
          }

          return {
            done: false,
            value: cloneEvent(preparedEvents[index++]),
          };
        },
      };
    },
  };
}

export async function collectStreamEvents(stream: AsyncIterable<ResponseStreamEvent>): Promise<ResponseStreamEvent[]> {
  const events: ResponseStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export function responseCreated(id: string, sequenceNumber?: number): ResponseStreamEvent {
  return {
    type: 'response.created',
    ...(sequenceNumber !== undefined ? { sequence_number: sequenceNumber } : {}),
    response: { id },
  };
}

export function responseCompleted(
  id: string,
  usage: Record<string, unknown> = {},
  sequenceNumber?: number,
): ResponseStreamEvent {
  return {
    type: 'response.completed',
    ...(sequenceNumber !== undefined ? { sequence_number: sequenceNumber } : {}),
    response: { id, usage },
  };
}

export function responseFailed(id: string, message: string, sequenceNumber?: number): ResponseStreamEvent {
  return {
    type: 'response.failed',
    ...(sequenceNumber !== undefined ? { sequence_number: sequenceNumber } : {}),
    response: { id, error: { message } },
  };
}

export function responseIncomplete(id: string, reason: string, sequenceNumber?: number): ResponseStreamEvent {
  return {
    type: 'response.incomplete',
    ...(sequenceNumber !== undefined ? { sequence_number: sequenceNumber } : {}),
    response: { id, incomplete_details: { reason } },
  };
}

export function textDelta(text: string, sequenceNumber?: number): ResponseStreamEvent {
  return {
    type: 'response.output_text.delta',
    ...(sequenceNumber !== undefined ? { sequence_number: sequenceNumber } : {}),
    delta: text,
  };
}

export function functionCallEvents(params: {
  itemId: string;
  callId: string;
  name: string;
  args?: string;
  sequenceStart?: number;
}): ResponseStreamEvent[] {
  const args = params.args || '{}';
  const firstSequence = params.sequenceStart;
  return [
    {
      type: 'response.function_call_arguments.done',
      ...(firstSequence !== undefined ? { sequence_number: firstSequence } : {}),
      item_id: params.itemId,
      name: params.name,
      arguments: args,
    },
    {
      type: 'response.output_item.done',
      ...(firstSequence !== undefined ? { sequence_number: firstSequence + 1 } : {}),
      item: {
        type: 'function_call',
        id: params.itemId,
        call_id: params.callId,
        name: params.name,
        arguments: args,
      },
    },
  ];
}

export function hostedWebSearchEvents(itemId: string, sequenceStart?: number): ResponseStreamEvent[] {
  return [
    {
      type: 'response.web_search_call.in_progress',
      ...(sequenceStart !== undefined ? { sequence_number: sequenceStart } : {}),
      item_id: itemId,
    },
    {
      type: 'response.web_search_call.searching',
      ...(sequenceStart !== undefined ? { sequence_number: sequenceStart + 1 } : {}),
      item_id: itemId,
    },
    {
      type: 'response.web_search_call.completed',
      ...(sequenceStart !== undefined ? { sequence_number: sequenceStart + 2 } : {}),
      item_id: itemId,
    },
  ];
}

export function messageWithCitations(citations: Array<{ url: string; title?: string }>, sequenceNumber?: number): ResponseStreamEvent {
  return {
    type: 'response.output_item.done',
    ...(sequenceNumber !== undefined ? { sequence_number: sequenceNumber } : {}),
    item: {
      type: 'message',
      content: [
        {
          type: 'output_text',
          annotations: citations.map(citation => ({
            type: 'url_citation',
            url: citation.url,
            title: citation.title || citation.url,
          })),
        },
      ],
    },
  };
}

export function makeCompletedTextStreamSpec(id: string, text = 'Done.'): FaultInjectedStreamSpec {
  return {
    label: id,
    events: [
      responseCreated(id),
      textDelta(text),
      responseCompleted(id),
    ],
  };
}

export function makeFunctionCallStreamSpec(params: {
  responseId: string;
  itemId: string;
  callId: string;
  name: string;
  args?: string;
}): FaultInjectedStreamSpec {
  return {
    label: params.responseId,
    events: [
      responseCreated(params.responseId),
      ...functionCallEvents(params),
      responseCompleted(params.responseId),
    ],
  };
}

function applyNonRuntimeFaults(
  events: readonly ResponseStreamEvent[],
  faults: readonly StreamFault[],
): ResponseStreamEvent[] {
  let nextEvents = events.map(cloneEvent);

  for (const fault of faults) {
    if (fault.kind === 'drop_terminal_event') {
      nextEvents = nextEvents.filter(event => !isTerminalEvent(event));
    }

    if (fault.kind === 'duplicate_sequence_number') {
      const target = nextEvents[fault.targetIndex];
      if (target) {
        const previousSequenceNumber = nextEvents[fault.targetIndex - 1]?.sequence_number;
        target.sequence_number = fault.sequenceNumber ?? previousSequenceNumber ?? target.sequence_number ?? 1;
      }
    }
  }

  return nextEvents;
}

function isTerminalEvent(event: ResponseStreamEvent): boolean {
  return event.type === 'response.completed'
    || event.type === 'response.failed'
    || event.type === 'response.incomplete';
}

function cloneEvent<T extends ResponseStreamEvent>(event: T): T {
  return JSON.parse(JSON.stringify(event)) as T;
}
