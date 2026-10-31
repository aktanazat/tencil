import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { basename, isAbsolute, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import {
    type ClientConnection,
    type ContentBlock,
    client,
    ndJsonStream,
    PROTOCOL_VERSION,
    RequestError,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
    type ToolCallStatus,
    type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
    CreatedThread,
    CreateThreadInput,
    ImageAttachment,
    Provider,
    ProviderInfo,
    ProviderMessage,
    ProviderProject,
    ProviderThreadSummary,
    SendMessageInput,
    ThreadSink,
    ThreadStep,
} from '@tencildev/protocol';
import { type LeaseHolder, leaseHolders } from './session-lease.ts';
import { Transcript } from './transcript.ts';

export interface OmpProviderOptions {
    /** Directory OMP runs in; its OMP sessions are the project's threads. */
    projectRoot: string;
    /** The OMP executable. Defaults to `$OMP_COMMAND`, then `omp`. */
    command?: string;
    /** Model for new threads; OMP's configured default when absent. */
    model?: string;
    log?: (message: string) => void;
}

type RunStatus = { status: 'working' | 'idle' | 'error'; detail?: string };

interface Agent {
    readonly process: ChildProcessWithoutNullStreams;
    readonly connection: ClientConnection;
    readonly exited: Promise<string>;
    readonly loaded: Map<string, Promise<void>>;
    readonly owned: Set<string>;
}

interface Session {
    readonly id: string;
    transcript: Transcript;
    readonly shown: Map<string, ProviderMessage>;
    readonly steps: Map<string, ThreadStep>;
    readonly sinks: Set<ThreadSink>;
    status: RunStatus;
    prompts: number;
    replay?: Transcript;
    resync?: Promise<void>;
}

const STOP_GRACE_MS = 3000;

/**
 * Runs OMP through its ACP mode (`omp acp`): one OMP process for the project
 * hosts every session Tencil opens. Threads are OMP sessions, saved where OMP
 * saves them, so their history comes back from OMP after a restart.
 */
export class OmpProvider implements Provider {
    readonly id = 'omp';
    readonly label = 'OMP';

    readonly #options: OmpProviderOptions;
    #info: ProviderInfo = { id: 'omp', label: 'OMP', state: 'connecting' };
    readonly #infoListeners = new Set<(info: ProviderInfo) => void>();
    readonly #sessions = new Map<string, Session>();
    #agent: Agent | undefined;
    #starting: Promise<Agent> | undefined;
    #disposed = false;

    constructor(options: OmpProviderOptions) {
        this.#options = options;
    }

    async start(): Promise<void> {
        try {
            await this.#ready();
        } catch (error) {
            this.#log(`OMP didn't start: ${errorMessage(error)}`);
        }
    }

    info(): ProviderInfo {
        return this.#info;
    }

    onInfoChange(listener: (info: ProviderInfo) => void): () => void {
        this.#infoListeners.add(listener);
        return () => this.#infoListeners.delete(listener);
    }

    async listThreads(): Promise<{ project: ProviderProject; threads: ProviderThreadSummary[] }> {
        const agent = await this.#ready();
        const root = this.#options.projectRoot;
        const threads: ProviderThreadSummary[] = [];
        let cursor: string | undefined;
        do {
            const page = await agent.connection.agent.request('session/list', {
                cwd: root,
                cursor,
            });
            for (const info of page.sessions) {
                threads.push({
                    id: info.sessionId,
                    title: info.title || 'Untitled OMP session',
                    status: this.#sessions.get(info.sessionId)?.status.status ?? 'idle',
                    updatedAt: info.updatedAt ?? new Date(0).toISOString(),
                    agent: 'omp',
                });
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return { project: { name: basename(root) }, threads };
    }

    threadUrl(): string | undefined {
        return undefined;
    }

    async createThread(input: CreateThreadInput): Promise<CreatedThread> {
        const agent = await this.#ready();
        const { sessionId } = await agent.connection.agent.request('session/new', {
            cwd: this.#options.projectRoot,
            mcpServers: [],
        });
        const model = input.model ?? this.#options.model;
        if (model) {
            try {
                await agent.connection.agent.request('session/set_config_option', {
                    sessionId,
                    configId: 'model',
                    value: model,
                });
            } catch (error) {
                await agent.connection.agent
                    .request('session/close', { sessionId })
                    .catch((closeError: unknown) =>
                        this.#log(
                            `Couldn't close OMP session ${sessionId}: ${errorMessage(closeError)}`,
                        ),
                    );
                throw new Error(`OMP can't use model ${model}: ${errorMessage(error)}`);
            }
        }
        // Nothing else knows the new id, so nothing else can hold its lease.
        agent.loaded.set(sessionId, Promise.resolve());
        agent.owned.add(sessionId);
        await this.#send(this.#session(sessionId), input.text, input.attachments);
        return { providerThreadId: sessionId };
    }

    async sendMessage(input: SendMessageInput): Promise<void> {
        await this.#send(this.#session(input.providerThreadId), input.text, input.attachments);
    }

    async interrupt(providerThreadId: string): Promise<void> {
        const agent = this.#agent;
        if (!agent?.loaded.has(providerThreadId)) return;
        await agent.connection.agent.notify('session/cancel', { sessionId: providerThreadId });
    }

    watch(providerThreadId: string, sink: ThreadSink): () => void {
        const session = this.#session(providerThreadId);
        session.sinks.add(sink);
        void this.#load(session).then(
            () => {
                if (session.sinks.has(sink)) this.#replayTo(session, sink);
            },
            (error: unknown) => {
                if (!session.sinks.has(sink)) return;
                const message = errorMessage(error);
                if (message.startsWith('ACP session not found')) sink.gone();
                else sink.status('error', message);
            },
        );
        return () => {
            session.sinks.delete(sink);
        };
    }

    async dispose(): Promise<void> {
        this.#disposed = true;
        const agent = this.#agent;
        this.#agent = undefined;
        this.#starting = undefined;
        if (agent) await this.#stop(agent);
    }

    async #send(session: Session, text: string, attachments: ImageAttachment[]): Promise<void> {
        // Counted from here so no resync starts while this message waits for its turn.
        session.prompts++;
        this.#setStatus(session, { status: 'working' });
        const agent = await this.#claim(session).catch((error: unknown) => {
            session.prompts--;
            this.#setStatus(session, { status: 'error', detail: errorMessage(error) });
            throw error;
        });
        void this.#turn(agent, session, text, attachments);
    }

    async #claim(session: Session): Promise<Agent> {
        await session.resync;
        const agent = await this.#load(session);
        if (!agent.owned.has(session.id)) await this.#assertNotOpenElsewhere(agent, session.id);
        return agent;
    }

    async #turn(
        agent: Agent,
        session: Session,
        text: string,
        attachments: ImageAttachment[],
    ): Promise<void> {
        // OMP doesn't echo prompts over ACP; the replay after the turn has the saved copy.
        if (text) this.#show(session, session.transcript.push('user', text));
        session.steps.clear();
        const firstWrite = !agent.owned.has(session.id);
        let status: RunStatus;
        try {
            const { stopReason } = await agent.connection.agent.request('session/prompt', {
                sessionId: session.id,
                prompt: [...attachments.map(imageBlock), { type: 'text', text }],
            });
            status =
                stopReason === 'refusal'
                    ? { status: 'error', detail: 'The model refused to continue this turn' }
                    : { status: 'idle' };
        } catch (error) {
            status = { status: 'error', detail: errorMessage(error) };
        }
        await notificationsDelivered();
        session.prompts--;
        if (session.prompts > 0) return;
        for (const message of session.transcript.messages()) this.#publish(session, message);
        if (firstWrite) {
            status = (await this.#confirmOwner(agent, session)) ?? status;
            if (session.prompts > 0) return;
        }
        this.#setStatus(session, status);
        if (this.#agent === agent && agent.loaded.has(session.id)) {
            session.resync = this.#resync(agent, session);
        }
    }

    /**
     * OMP takes a session's lease on its first write. When another process
     * holds it, OMP saves to a new session instead of failing; catch that.
     */
    async #confirmOwner(agent: Agent, session: Session): Promise<RunStatus | undefined> {
        let holders: LeaseHolder[];
        try {
            holders = await leaseHolders(session.id, this.#options.projectRoot);
        } catch (error) {
            return {
                status: 'error',
                detail: `Couldn't confirm Tencil owns this OMP session: ${errorMessage(error)}`,
            };
        }
        const pid = agent.process.pid;
        if (holders.some(holder => holder.pid === pid || holder.ppid === pid)) {
            agent.owned.add(session.id);
            return undefined;
        }
        const other = holders[0];
        if (!other) return undefined;
        agent.loaded.delete(session.id);
        await agent.connection.agent
            .request('session/close', { sessionId: session.id })
            .catch((error: unknown) =>
                this.#log(`Couldn't close OMP session ${session.id}: ${errorMessage(error)}`),
            );
        return {
            status: 'error',
            detail: `This session is open in another OMP process (pid ${other.pid}), so OMP saved the reply as a separate session.`,
        };
    }

    async #resync(agent: Agent, session: Session): Promise<void> {
        try {
            await this.#replay(agent, session);
        } catch (error) {
            this.#log(`Couldn't reread OMP session ${session.id}: ${errorMessage(error)}`);
        }
    }

    async #load(session: Session): Promise<Agent> {
        const agent = await this.#ready();
        let loading = agent.loaded.get(session.id);
        if (!loading) {
            const load = this.#open(agent, session);
            loading = load;
            agent.loaded.set(session.id, load);
            load.catch(() => {
                if (agent.loaded.get(session.id) === load) agent.loaded.delete(session.id);
            });
        }
        await loading;
        return agent;
    }

    async #open(agent: Agent, session: Session): Promise<void> {
        // Loading can write to the session (OMP records an interrupted turn or a model switch).
        await this.#assertNotOpenElsewhere(agent, session.id);
        await this.#replay(agent, session);
    }

    async #replay(agent: Agent, session: Session): Promise<void> {
        const replay = new Transcript(session.id);
        session.replay = replay;
        try {
            await agent.connection.agent.request('session/load', {
                sessionId: session.id,
                cwd: this.#options.projectRoot,
                mcpServers: [],
            });
            await notificationsDelivered();
        } finally {
            if (session.replay === replay) session.replay = undefined;
        }
        replay.keepLiveText(session.transcript);
        session.transcript = replay;
        for (const message of replay.messages()) this.#publish(session, message);
    }

    async #assertNotOpenElsewhere(agent: Agent, sessionId: string): Promise<void> {
        const pid = agent.process.pid;
        const holders = await leaseHolders(sessionId, this.#options.projectRoot);
        const other = holders.find(holder => holder.pid !== pid && holder.ppid !== pid);
        if (other) {
            throw new Error(
                `This session is open in another OMP process (pid ${other.pid}). Close it there, then try again.`,
            );
        }
    }

    #route({ sessionId, update }: SessionNotification): void {
        const session = this.#sessions.get(sessionId);
        if (!session) return;
        switch (update.sessionUpdate) {
            case 'user_message_chunk':
                session.replay?.add('user', update.content, update.messageId ?? undefined);
                break;
            case 'agent_message_chunk':
                if (session.replay) {
                    session.replay.add('assistant', update.content, update.messageId ?? undefined);
                } else {
                    const index = session.transcript.add(
                        'assistant',
                        update.content,
                        update.messageId ?? undefined,
                    );
                    if (index !== undefined) this.#show(session, index);
                }
                break;
            case 'tool_call':
            case 'tool_call_update':
                if (!session.replay) this.#step(session, update);
                break;
        }
    }

    #step(session: Session, update: ToolCallUpdate): void {
        const previous = session.steps.get(update.toolCallId);
        const status = update.status ? stepStatus(update.status) : (previous?.status ?? 'running');
        const path = update.locations?.[0]?.path;
        const now = new Date().toISOString();
        this.#putStep(session, {
            id: update.toolCallId,
            label: update.title || previous?.label || 'Tool call',
            status,
            detail: previous?.detail ?? (path ? this.#relative(path) : undefined),
            startedAt: previous?.startedAt ?? now,
            endedAt: status === 'running' ? undefined : (previous?.endedAt ?? now),
        });
    }

    #permission({
        sessionId,
        toolCall,
        options,
    }: RequestPermissionRequest): RequestPermissionResponse {
        this.#log(`Declined OMP's request to approve ${toolCall.title || 'a tool call'}`);
        const session = this.#sessions.get(sessionId);
        if (session) {
            const previous = session.steps.get(toolCall.toolCallId);
            const now = new Date().toISOString();
            this.#putStep(session, {
                id: toolCall.toolCallId,
                label: toolCall.title || previous?.label || 'Tool call',
                status: 'failed',
                detail: 'OMP asked to approve this; Tencil declines tool approvals',
                startedAt: previous?.startedAt ?? now,
                endedAt: now,
            });
        }
        const reject = options.find(option => option.kind === 'reject_once');
        return reject
            ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
            : { outcome: { outcome: 'cancelled' } };
    }

    #session(id: string): Session {
        let session = this.#sessions.get(id);
        if (!session) {
            session = {
                id,
                transcript: new Transcript(id),
                shown: new Map(),
                steps: new Map(),
                sinks: new Set(),
                status: { status: 'idle' },
                prompts: 0,
            };
            this.#sessions.set(id, session);
        }
        return session;
    }

    #show(session: Session, index: number): void {
        const message = session.transcript.message(index, session.prompts > 0);
        if (message) this.#publish(session, message);
    }

    #publish(session: Session, message: ProviderMessage): void {
        const shown = session.shown.get(message.id);
        if (
            shown?.role === message.role &&
            shown.text === message.text &&
            shown.streaming === message.streaming
        ) {
            return;
        }
        session.shown.set(message.id, message);
        for (const sink of session.sinks) sink.message(message);
    }

    #putStep(session: Session, step: ThreadStep): void {
        session.steps.set(step.id, step);
        for (const sink of session.sinks) sink.step?.(step);
    }

    #setStatus(session: Session, status: RunStatus): void {
        session.status = status;
        for (const sink of session.sinks) sink.status(status.status, status.detail);
    }

    #replayTo(session: Session, sink: ThreadSink): void {
        for (const message of session.transcript.messages()) {
            sink.message(session.shown.get(message.id) ?? message);
        }
        for (const step of session.steps.values()) sink.step?.(step);
        sink.status(session.status.status, session.status.detail);
    }

    #relative(path: string): string {
        const inside = relative(this.#options.projectRoot, path);
        return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path;
    }

    #ready(): Promise<Agent> {
        if (this.#disposed) return Promise.reject(new Error('The OMP provider has shut down'));
        if (!this.#starting) {
            const starting = this.#spawn();
            this.#starting = starting;
            starting.catch(() => {
                if (this.#starting === starting) this.#starting = undefined;
            });
        }
        return this.#starting;
    }

    async #spawn(): Promise<Agent> {
        const command = this.#options.command ?? process.env.OMP_COMMAND ?? 'omp';
        const root = this.#options.projectRoot;
        this.#setInfo({ state: 'connecting' });
        const child = spawn(command, ['acp'], { cwd: root });
        let lastError = '';
        const exited = new Promise<string>(resolve => {
            child.once('exit', (code, signal) =>
                resolve(signal ? `signal ${signal}` : `exit code ${code}`),
            );
            child.on('error', error => {
                if (child.pid === undefined) resolve(`couldn't run ${command}: ${error.message}`);
                else this.#log(`OMP process: ${error.message}`);
            });
        });
        child.stdin.on('error', error => this.#log(`OMP input: ${error.message}`));
        createInterface({ input: child.stderr }).on('line', line => {
            if (line.trim()) lastError = line.trim();
            this.#log(`omp: ${line}`);
        });
        const connection = client({ name: 'tencil' })
            .onNotification('session/update', ({ params }) => this.#route(params))
            .onRequest('session/request_permission', ({ params }) => this.#permission(params))
            .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
        const agent: Agent = {
            process: child,
            connection,
            exited,
            loaded: new Map(),
            owned: new Set(),
        };
        this.#agent = agent;
        void exited.then(how =>
            this.#exited(agent, `OMP stopped (${how})${lastError ? `: ${lastError}` : ''}`),
        );
        try {
            const { agentCapabilities } = await connection.agent.request('initialize', {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            if (!agentCapabilities?.loadSession || !agentCapabilities.sessionCapabilities?.list) {
                throw new Error(`${command} can't list and load sessions over ACP; update OMP`);
            }
            if (this.#agent !== agent) throw new Error('OMP stopped while starting');
        } catch (error) {
            await this.#stop(agent);
            this.#setInfo({ state: 'unavailable', detail: errorMessage(error) });
            throw error;
        }
        this.#setInfo({ state: 'ready', target: basename(root) });
        this.#log(`OMP ready in ${root}`);
        return agent;
    }

    #exited(agent: Agent, detail: string): void {
        agent.connection.close(new Error(detail));
        if (this.#agent !== agent) return;
        this.#agent = undefined;
        this.#starting = undefined;
        this.#log(detail);
        this.#setInfo({ state: 'unavailable', detail });
    }

    async #stop(agent: Agent): Promise<void> {
        agent.connection.close();
        agent.process.stdin.end();
        if (await settlesWithin(agent.exited, STOP_GRACE_MS)) return;
        agent.process.kill('SIGTERM');
        if (await settlesWithin(agent.exited, STOP_GRACE_MS)) return;
        agent.process.kill('SIGKILL');
        await agent.exited;
    }

    #setInfo(next: Omit<ProviderInfo, 'id' | 'label'>): void {
        const info: ProviderInfo = { id: this.id, label: this.label, ...next };
        if (
            info.state === this.#info.state &&
            info.detail === this.#info.detail &&
            info.target === this.#info.target
        ) {
            return;
        }
        this.#info = info;
        for (const listener of this.#infoListeners) listener(info);
    }

    #log(message: string): void {
        this.#options.log?.(message);
    }
}

/** OMP answers a request right after its last update; the SDK hands updates to #route a few microtasks later. */
function notificationsDelivered(): Promise<void> {
    return setImmediate();
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms);
    });
    try {
        return await Promise.race([promise.then(() => true), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function imageBlock(attachment: ImageAttachment): ContentBlock {
    return {
        type: 'image',
        data: attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1),
        mimeType: attachment.mimeType,
    };
}

function stepStatus(status: ToolCallStatus): ThreadStep['status'] {
    switch (status) {
        case 'pending':
        case 'in_progress':
            return 'running';
        case 'completed':
            return 'done';
        case 'failed':
            return 'failed';
    }
}

function errorMessage(error: unknown): string {
    // OMP answers a failed request with "Internal error" and the reason in `data.details`.
    if (error instanceof RequestError) {
        const { data } = error;
        if (
            typeof data === 'object' &&
            data !== null &&
            'details' in data &&
            typeof data.details === 'string'
        ) {
            return data.details;
        }
    }
    return error instanceof Error ? error.message : String(error);
}
