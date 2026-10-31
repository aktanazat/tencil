import { chmod, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionContext,
    MessageStartEvent,
    SessionEntry,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
} from '@oh-my-pi/pi-coding-agent';
import type { ThreadMessage, ThreadStep } from '@tencildev/protocol';
import {
    activeOmpSessions,
    type OmpComment,
    OmpCommentMeta,
    type OmpEvent,
    OmpOperation,
    OmpQueuedComment,
    type OmpSessionRegistration,
    OmpStatusRecord,
    OmpThread,
    ompSessionDirectory,
} from '@tencildev/provider-omp/session-link';

const COMMENT = 'tencil.comment.v1';
const THREAD = 'tencil.thread.v1';
const QUEUED = 'tencil.queued.v1';
const STATUS = 'tencil.status.v1';
const END = 'tencil.end.v1';
const PROJECT = 'tencil.project.v1';
type Message = MessageStartEvent['message'];
type ThreadStatus = OmpThread['status'];

interface PageCommentStatus {
    connected: boolean;
    projects: string[];
    sessionId?: string;
}

function stepDetail(args: unknown): string | undefined {
    if (typeof args !== 'object' || args === null) return undefined;
    for (const key of ['path', 'command', 'query']) {
        if (key in args) {
            const value: unknown = Reflect.get(args, key);
            if (typeof value === 'string') return value;
        }
    }
    return undefined;
}

class PageComments {
    readonly #api: ExtensionAPI;
    #ctx: ExtensionContext | undefined;
    #server: Bun.Server<undefined> | undefined;
    #registration: OmpSessionRegistration | undefined;
    readonly #roots = new Set<string>();
    readonly #threads = new Map<string, OmpThread>();
    readonly #subscribers = new Map<string, Set<(event: OmpEvent) => void>>();
    readonly #toolOwners = new Map<string, string>();
    readonly #assistantCounts = new Map<string, number>();
    readonly #pending: OmpComment[] = [];
    #active: string | undefined;
    #dispatching = false;
    #canceled = false;

    constructor(api: ExtensionAPI) {
        this.#api = api;
        api.on('session_start', (_event, ctx) => this.#load(ctx));
        api.on('session_switch', (_event, ctx) => this.#load(ctx));
        api.on('session_branch', (_event, ctx) => this.#load(ctx));
        api.on('session_tree', (_event, ctx) => this.#load(ctx));
        api.on('session_shutdown', () => this.#close());
        api.on('message_start', (event, ctx) => {
            this.#ctx = ctx;
            this.#messageStart(event.message);
        });
        api.on('message_update', event => this.#assistant(event.message, true));
        api.on('message_end', event => this.#assistant(event.message, false));
        api.on('tool_execution_start', event => this.#toolStart(event));
        api.on('tool_execution_end', event => this.#toolEnd(event));
        api.on('tool_approval_requested', event => {
            const id = this.#toolOwners.get(event.toolCallId);
            if (id) this.#setStatus(id, 'waiting', 'approve the request in this chat to continue.');
        });
        api.on('tool_approval_resolved', event => {
            const id = this.#toolOwners.get(event.toolCallId);
            if (id && id === this.#active) this.#setStatus(id, 'working');
        });
        api.on('agent_end', (event, ctx) => {
            this.#ctx = ctx;
            if (event.willContinue) return;
            const aborted = event.messages.some(
                message => message.role === 'assistant' && message.stopReason === 'aborted',
            );
            this.#finish();
            if (!aborted) ctx.setTimeout(() => this.#flush(), 0);
        });
        api.on('agent_start', (_event, ctx) => {
            this.#ctx = ctx;
        });
    }

    async connect(ctx: ExtensionContext, projectRoot: string): Promise<OmpSessionRegistration> {
        if (ctx.agent.kind !== 'main')
            throw new Error('Page comments must connect to the main chat, not a helper.');
        if (!isAbsolute(projectRoot)) throw new Error('Use the absolute project folder.');
        this.#ctx = ctx;
        const root = await realpath(projectRoot);
        const others = (await activeOmpSessions(root)).filter(
            session => session.sessionId !== ctx.sessionManager.getSessionId(),
        );
        if (others.length)
            throw new Error(
                'Another chat is connected to this project. Disconnect it there before moving page comments here.',
            );
        await this.#start(ctx);
        this.#roots.add(root);
        await this.#publish();
        const conflicts = (await activeOmpSessions(root)).filter(
            session => session.sessionId !== ctx.sessionManager.getSessionId(),
        );
        if (conflicts.length) {
            this.#roots.delete(root);
            await this.#publish();
            throw new Error(
                'Another chat connected to this project at the same time. No page comments were redirected.',
            );
        }
        this.#api.appendEntry(PROJECT, root);
        const registration = this.#registration;
        if (!registration) throw new Error('The local page-comment connection did not start.');
        return registration;
    }

    async disconnect(projectRoot?: string): Promise<void> {
        if (projectRoot) {
            const root = await realpath(projectRoot);
            for (const thread of this.#threads.values()) {
                if (
                    thread.projectRoot === root &&
                    (thread.status === 'working' || thread.status === 'waiting')
                ) {
                    await this.#interrupt(thread.id);
                }
            }
            this.#roots.delete(root);
            this.#api.appendEntry(PROJECT, { disconnected: root });
            if (this.#roots.size) return this.#publish();
        }
        for (const root of this.#roots) this.#api.appendEntry(PROJECT, { disconnected: root });
        for (const comment of this.#pending)
            this.#setStatus(
                comment.threadId,
                'error',
                'disconnected before this request was sent.',
            );
        this.#pending.length = 0;
        await this.#close();
    }

    status(): PageCommentStatus {
        return {
            connected: this.#server !== undefined && this.#roots.size > 0,
            projects: [...this.#roots],
            sessionId: this.#registration?.sessionId,
        };
    }

    async #load(ctx: ExtensionContext): Promise<void> {
        await this.#close();
        this.#ctx = ctx;
        this.#threads.clear();
        this.#assistantCounts.clear();
        this.#toolOwners.clear();
        this.#pending.length = 0;
        this.#active = undefined;
        this.#canceled = false;
        this.#dispatching = false;
        const roots = new Set<string>();
        for (const entry of ctx.sessionManager.getBranch()) {
            this.#replay(entry, roots);
        }
        this.#active = undefined;
        for (const thread of this.#threads.values()) {
            if (thread.status === 'working' || thread.status === 'waiting') {
                this.#setStatus(
                    thread.id,
                    'error',
                    'the chat stopped before this request finished. send it again to continue.',
                );
            }
        }
        if (ctx.agent.kind !== 'main') return;
        for (const root of roots) {
            try {
                await this.connect(ctx, root);
            } catch (error) {
                this.#api.logger.warn('Could not reconnect page comments', {
                    projectRoot: root,
                    error: String(error),
                });
            }
        }
    }

    #replay(entry: SessionEntry, roots: Set<string>): void {
        if (entry.type === 'custom') {
            if (entry.customType === THREAD) {
                const thread = OmpThread.parse(entry.data);
                this.#threads.set(thread.id, thread);
            } else if (entry.customType === QUEUED) {
                const comment = OmpQueuedComment.parse(entry.data);
                this.#putUser(comment);
            } else if (entry.customType === STATUS) {
                const state = OmpStatusRecord.parse(entry.data);
                const thread = this.#threads.get(state.threadId);
                if (thread) {
                    thread.status = state.status;
                    thread.detail = state.detail;
                    thread.updatedAt = entry.timestamp;
                }
            } else if (entry.customType === END) {
                if (entry.data === this.#active) this.#active = undefined;
            } else if (entry.customType === PROJECT) {
                if (typeof entry.data === 'string') roots.add(entry.data);
                else if (
                    typeof entry.data === 'object' &&
                    entry.data !== null &&
                    'disconnected' in entry.data &&
                    typeof entry.data.disconnected === 'string'
                )
                    roots.delete(entry.data.disconnected);
            }
            return;
        }
        if (entry.type === 'custom_message') {
            if (entry.customType === COMMENT)
                this.#active = OmpCommentMeta.parse(entry.details).threadId;
            else if (entry.attribution === 'user') this.#active = undefined;
            return;
        }
        if (entry.type !== 'message') return;
        if (entry.message.role === 'user') this.#active = undefined;
        else if (entry.message.role === 'assistant') {
            this.#assistant(entry.message, false, false);
            if (this.#active) {
                for (const block of entry.message.content) {
                    if (block.type !== 'toolCall') continue;
                    this.#toolStart(
                        {
                            type: 'tool_execution_start',
                            toolCallId: block.id,
                            toolName: block.name,
                            args: block.arguments,
                        },
                        false,
                        entry.timestamp,
                    );
                }
            }
        } else if (entry.message.role === 'toolResult') {
            this.#toolEnd(
                {
                    type: 'tool_execution_end',
                    toolCallId: entry.message.toolCallId,
                    toolName: entry.message.toolName,
                    result: entry.message.content,
                    isError: entry.message.isError,
                },
                false,
                entry.timestamp,
            );
        }
    }

    async #start(ctx: ExtensionContext): Promise<void> {
        if (this.#server) return;
        const sessionId = ctx.sessionManager.getSessionId();
        const directory = ompSessionDirectory(sessionId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        const socketPath = join(directory, 's.sock');
        if ((await activeOmpSessions()).some(session => session.sessionId === sessionId)) {
            throw new Error('This chat already has a live page-comment connection.');
        }
        try {
            await unlink(socketPath);
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
        }
        this.#server = Bun.serve<undefined>({
            unix: socketPath,
            maxRequestBodySize: 32 * 1024 * 1024,
            fetch: request => this.#handle(request),
        });
        await chmod(socketPath, 0o600);
        this.#registration = {
            version: 1,
            sessionId,
            pid: process.pid,
            socketPath,
            projectRoots: [],
        };
    }

    async #publish(): Promise<void> {
        const registration = this.#registration;
        if (!registration) return;
        registration.projectRoots = [...this.#roots];
        const path = join(ompSessionDirectory(registration.sessionId), 'session.json');
        await writeFile(`${path}.tmp`, JSON.stringify(registration), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
    }

    async #close(): Promise<void> {
        for (const [id, listeners] of this.#subscribers) {
            for (const listener of listeners) listener({ type: 'gone', threadId: id });
        }
        this.#subscribers.clear();
        this.#roots.clear();
        const registration = this.#registration;
        this.#registration = undefined;
        const server = this.#server;
        this.#server = undefined;
        await server?.stop(true);
        if (registration) {
            for (const name of ['session.json', 's.sock']) {
                try {
                    await unlink(join(ompSessionDirectory(registration.sessionId), name));
                } catch (error) {
                    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                        throw error;
                }
            }
        }
    }

    async #handle(request: Request): Promise<Response> {
        try {
            if (request.method === 'GET' && new URL(request.url).pathname === '/health')
                return Response.json(this.#registration);
            if (request.method !== 'POST' || new URL(request.url).pathname !== '/rpc')
                return new Response('Not found', { status: 404 });
            const operation = OmpOperation.parse(await request.json());
            if (!this.#roots.has(operation.projectRoot))
                throw new Error('This project is not connected to this chat.');
            if (operation.kind === 'list')
                return Response.json(
                    [...this.#threads.values()].filter(
                        thread => thread.projectRoot === operation.projectRoot,
                    ),
                );
            if (operation.kind === 'create') {
                const thread: OmpThread = {
                    id: crypto.randomUUID(),
                    projectRoot: operation.projectRoot,
                    title: operation.title,
                    messages: [],
                    steps: [],
                    status: 'idle',
                    updatedAt: new Date().toISOString(),
                };
                this.#threads.set(thread.id, thread);
                this.#api.appendEntry(THREAD, thread);
                this.#enqueue(thread, operation);
                return Response.json({ threadId: thread.id });
            }
            const thread = this.#threads.get(operation.threadId);
            if (!thread || thread.projectRoot !== operation.projectRoot)
                throw new Error('This page comment does not belong to the connected project.');
            if (operation.kind === 'watch') return this.#watch(thread, request.signal);
            if (operation.kind === 'send') this.#enqueue(thread, operation);
            else await this.#interrupt(thread.id);
            return Response.json({ accepted: true });
        } catch (error) {
            return Response.json(
                { error: error instanceof Error ? error.message : String(error) },
                { status: 400 },
            );
        }
    }

    #watch(thread: OmpThread, signal: AbortSignal): Response {
        const encoder = new TextEncoder();
        const keepAlive = encoder.encode('\n');
        const listeners = this.#subscribers.get(thread.id) ?? new Set<(event: OmpEvent) => void>();
        this.#subscribers.set(thread.id, listeners);
        let remove = () => {};
        const stream = new ReadableStream<Uint8Array>({
            start: controller => {
                // Bun's Unix listener ignores per-request timeouts (oven-sh/bun#43816).
                const heartbeat = setInterval(() => controller.enqueue(keepAlive), 5_000);
                const listener = (event: OmpEvent) => {
                    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
                    if (event.type === 'gone') {
                        remove();
                        controller.close();
                    }
                };
                remove = () => {
                    clearInterval(heartbeat);
                    listeners.delete(listener);
                    signal.removeEventListener('abort', abort);
                    if (!listeners.size) this.#subscribers.delete(thread.id);
                };
                const abort = () => {
                    remove();
                    controller.close();
                };
                listeners.add(listener);
                signal.addEventListener('abort', abort, { once: true });
                listener({ type: 'snapshot', thread });
            },
            cancel: () => remove(),
        });
        return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
    }

    #enqueue(
        thread: OmpThread,
        operation: Extract<OmpOperation, { kind: 'create' | 'send' }>,
    ): void {
        if (
            thread.messages.some(
                message => message.id === `${thread.id}:user:${operation.requestId}`,
            )
        )
            return;
        for (const attachment of operation.attachments) {
            if (!attachment.dataUrl.startsWith(`data:${attachment.mimeType};base64,`))
                throw new Error('The image attachment is not a supported base64 image.');
        }
        const comment: OmpComment = {
            projectRoot: thread.projectRoot,
            threadId: thread.id,
            title: thread.title,
            requestId: operation.requestId,
            text: operation.text,
            attachments: operation.attachments,
            createdAt: new Date().toISOString(),
        };
        const queued = {
            ...OmpCommentMeta.parse(comment),
            text: comment.text,
            hasAttachments: comment.attachments.length > 0,
        };
        this.#api.appendEntry(QUEUED, queued);
        this.#putUser(queued);
        this.#pending.push(comment);
        this.#setStatus(thread.id, 'waiting', 'queued for this chat to finish its current work.');
        this.#ctx?.setTimeout(() => this.#flush(), 0);
    }

    #putUser(comment: {
        threadId: string;
        requestId: string;
        text: string;
        createdAt: string;
    }): void {
        const thread = this.#threads.get(comment.threadId);
        if (!thread) return;
        this.#putMessage(thread, {
            id: `${thread.id}:user:${comment.requestId}`,
            role: 'user',
            text: comment.text,
            createdAt: comment.createdAt,
            streaming: false,
        });
    }

    #flush(): void {
        const ctx = this.#ctx;
        if (!ctx?.isIdle() || ctx.hasPendingMessages() || this.#dispatching || this.#active) return;
        const comment = this.#pending.shift();
        if (!comment) return;
        if (!this.#roots.has(comment.projectRoot)) {
            this.#setStatus(
                comment.threadId,
                'error',
                'this project is no longer connected to this chat.',
            );
            return;
        }
        this.#dispatching = true;
        this.#canceled = false;
        this.#active = comment.threadId;
        this.#setStatus(comment.threadId, 'working');
        try {
            this.#api.sendMessage(
                {
                    customType: COMMENT,
                    attribution: 'user',
                    display: true,
                    details: OmpCommentMeta.parse(comment),
                    content: [
                        {
                            type: 'text',
                            text: `project: ${comment.projectRoot}\n\n${comment.text}`,
                        },
                        ...comment.attachments.map(attachment => ({
                            type: 'image' as const,
                            mimeType: attachment.mimeType,
                            data: attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1),
                        })),
                    ],
                },
                { triggerTurn: true },
            );
        } catch (error) {
            this.#setStatus(comment.threadId, 'error', String(error));
            this.#finish();
        } finally {
            this.#dispatching = false;
        }
    }

    #messageStart(message: Message): void {
        if (message.role === 'custom' && message.customType === COMMENT) {
            this.#active = OmpCommentMeta.parse(message.details).threadId;
        } else if (
            message.role === 'user' ||
            (message.role === 'custom' && message.attribution === 'user')
        ) {
            this.#finish('continued in the main chat.');
        }
    }

    #assistant(message: Message, streaming: boolean, emit = true): void {
        if (message.role !== 'assistant' || !this.#active) return;
        const thread = this.#threads.get(this.#active);
        if (!thread) return;
        const index = this.#assistantCounts.get(thread.id) ?? 0;
        let text = '';
        for (const block of message.content) {
            if (block.type === 'text') text += text ? `\n${block.text}` : block.text;
        }
        if (text) {
            this.#putMessage(
                thread,
                {
                    id: `${thread.id}:assistant:${index}`,
                    role: 'assistant',
                    text,
                    streaming,
                    createdAt: new Date(message.timestamp).toISOString(),
                },
                emit,
            );
        }
        if (!streaming) {
            this.#assistantCounts.set(thread.id, index + 1);
            if (emit && message.stopReason === 'error')
                this.#setStatus(
                    thread.id,
                    'error',
                    message.errorMessage ?? 'the reply failed in this chat.',
                );
        }
    }

    #putMessage(thread: OmpThread, message: ThreadMessage, emit = true): void {
        const index = thread.messages.findIndex(existing => existing.id === message.id);
        if (index === -1) thread.messages.push(message);
        else thread.messages[index] = message;
        thread.updatedAt = message.createdAt;
        if (emit) this.#emit({ type: 'message', threadId: thread.id, message });
    }

    #toolStart(
        event: ToolExecutionStartEvent,
        emit = true,
        startedAt = new Date().toISOString(),
    ): void {
        if (!this.#active) return;
        this.#toolOwners.set(event.toolCallId, this.#active);
        const thread = this.#threads.get(this.#active);
        if (!thread) return;
        const step: ThreadStep = {
            id: event.toolCallId,
            label: event.intent ?? event.toolName,
            detail: stepDetail(event.args),
            status: 'running',
            startedAt,
        };
        thread.steps.push(step);
        if (emit) this.#emit({ type: 'step', threadId: thread.id, step });
    }

    #toolEnd(event: ToolExecutionEndEvent, emit = true, endedAt = new Date().toISOString()): void {
        const id = this.#toolOwners.get(event.toolCallId);
        if (!id) return;
        const thread = this.#threads.get(id);
        const step = thread?.steps.find(candidate => candidate.id === event.toolCallId);
        if (!thread || !step) return;
        step.status = event.isError ? 'failed' : 'done';
        step.endedAt = endedAt;
        if (emit) this.#emit({ type: 'step', threadId: id, step });
        this.#toolOwners.delete(event.toolCallId);
    }

    async #interrupt(id: string): Promise<void> {
        for (let index = this.#pending.length - 1; index >= 0; index--) {
            if (this.#pending[index]?.threadId === id) this.#pending.splice(index, 1);
        }
        this.#setStatus(id, 'idle', 'stopped.');
        if (this.#active === id) {
            this.#canceled = true;
            this.#ctx?.abort();
        }
    }

    #finish(detail?: string): void {
        const id = this.#active;
        if (!id) return;
        const thread = this.#threads.get(id);
        if (thread && thread.status !== 'error' && !this.#canceled)
            this.#setStatus(id, 'idle', detail);
        this.#api.appendEntry(END, id);
        this.#active = undefined;
        this.#canceled = false;
    }

    #setStatus(id: string, status: ThreadStatus, detail?: string): void {
        const thread = this.#threads.get(id);
        if (!thread) return;
        thread.status = status;
        thread.detail = detail;
        thread.updatedAt = new Date().toISOString();
        this.#api.appendEntry(STATUS, { threadId: id, status, detail });
        this.#emit({ type: 'status', threadId: id, status, detail });
    }

    #emit(event: OmpEvent): void {
        if (event.type === 'snapshot') return;
        const listeners = this.#subscribers.get(event.threadId);
        if (listeners) for (const listener of listeners) listener(event);
    }
}

export function registerPageComments(api: ExtensionAPI): void {
    const comments = new PageComments(api);
    const parameters = api.zod.object({
        action: api.zod.enum(['connect', 'status', 'disconnect']),
        projectRoot: api.zod.string().optional(),
    });
    api.registerTool<typeof parameters, PageCommentStatus>({
        name: 'point_and_comment',
        label: 'page comments',
        description:
            'Connect a running web project to this same conversation so selected elements and comments arrive here. Suggest it when pointing at a visible change would be easier than describing it. Never starts another agent. Connect requires the absolute project folder; then use tencil-omp in that folder for the existing local overlay setup.',
        parameters,
        approval: 'write',
        async execute(
            _id,
            params,
            _signal,
            _onUpdate,
            ctx,
        ): Promise<AgentToolResult<PageCommentStatus>> {
            if (params.action === 'connect') {
                if (!params.projectRoot) throw new Error('Choose the project folder to connect.');
                await comments.connect(ctx, params.projectRoot);
            } else if (params.action === 'disconnect')
                await comments.disconnect(params.projectRoot);
            const status = comments.status();
            return {
                content: [
                    {
                        type: 'text',
                        text: status.connected
                            ? `page comments come to this chat.\n${status.projects.join('\n')}`
                            : 'page comments are disconnected.',
                    },
                ],
                details: status,
            };
        },
        describeResult(result) {
            return {
                tool: {
                    title: 'page comments',
                    meta: [result.details?.connected ? 'connected to this chat' : 'disconnected'],
                },
            };
        },
    });
}
