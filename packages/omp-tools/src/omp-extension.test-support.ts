import { randomUUID } from 'node:crypto';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { vi } from 'vitest';

type Tool = {
    name: string;
    approval: string;
    execute(
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
    ): Promise<AgentToolResult>;
};
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export function fakeOmp() {
    const tools = new Map<string, Tool>();
    const handlers = new Map<string, Handler[]>();
    const schema = {
        describe: () => schema,
        int: () => schema,
        min: () => schema,
        max: () => schema,
        nonnegative: () => schema,
        positive: () => schema,
        regex: () => schema,
        optional: () => schema,
    };
    const makeSchema = () => schema;
    const appendEntry = vi.fn<(customType: string, data: unknown) => void>();
    const sendMessage = vi.fn();
    const sessionId = randomUUID();
    const branch: unknown[] = [];
    const timers: (() => void)[] = [];
    const context = {
        agent: { kind: 'main', id: 'main-agent', parentId: undefined as string | undefined },
        sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
        isIdle: vi.fn(() => true),
        hasPendingMessages: vi.fn(() => false),
        abort: vi.fn(),
        setTimeout: (fn: () => void) => timers.push(fn),
    };
    const ctx = context as unknown as ExtensionContext;
    const api = {
        zod: {
            array: makeSchema,
            boolean: makeSchema,
            enum: makeSchema,
            literal: makeSchema,
            number: makeSchema,
            object: makeSchema,
            record: makeSchema,
            string: makeSchema,
            union: makeSchema,
            unknown: makeSchema,
            discriminatedUnion: makeSchema,
        },
        arktype: makeSchema,
        registerTool: (tool: Tool) => tools.set(tool.name, tool),
        on(name: string, handler: Handler) {
            const listeners = handlers.get(name) ?? [];
            listeners.push(handler);
            handlers.set(name, listeners);
        },
        appendEntry,
        sendMessage,
        logger: { warn: vi.fn() },
    } as unknown as ExtensionAPI;
    function tool(name: string) {
        const registered = tools.get(name);
        if (!registered) throw new Error(`Tool not registered: ${name}`);
        return registered;
    }
    return {
        api,
        context,
        sessionId,
        branch,
        timers,
        appendEntry,
        sendMessage,
        tool,
        run: (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
            tool(name).execute('call', params, signal, undefined, ctx),
        async emit(name: string, event: unknown) {
            for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
        },
        flush() {
            for (const fn of timers.splice(0)) fn();
        },
    };
}
