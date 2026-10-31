import { type FSWatcher, watch } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
    CreatedThread,
    CreateThreadInput,
    Provider,
    ProviderInfo,
    ProviderProject,
    ProviderThreadSummary,
    SendMessageInput,
    ThreadSink,
} from '@tencildev/protocol';
import { z } from 'zod';
import {
    activeOmpSessions,
    type OmpEvent,
    OmpSessionRegistration,
    OmpThread,
    ompRuntimeDirectory,
    requestOmpSession,
    watchOmpSession,
} from './session-link.ts';

export interface OmpProviderOptions {
    projectRoot: string;
    log?: (message: string) => void;
}

interface Watch {
    threadId: string;
    sink: ThreadSink;
    stop?: () => void;
}

export class OmpProvider implements Provider {
    readonly id = 'omp';
    readonly label = 'OMP';
    readonly #options: OmpProviderOptions;
    #root: string;
    #info: ProviderInfo = { id: 'omp', label: 'OMP', state: 'connecting' };
    readonly #infoListeners = new Set<(info: ProviderInfo) => void>();
    readonly #watches = new Set<Watch>();
    #session: OmpSessionRegistration | undefined;
    #starting: Promise<OmpSessionRegistration> | undefined;
    #disposed = false;
    #registryWatcher: FSWatcher | undefined;
    #refreshing = false;
    #dirty = false;

    constructor(options: OmpProviderOptions) {
        this.#options = options;
        this.#root = options.projectRoot;
    }

    async start(): Promise<void> {
        if (!this.#registryWatcher) {
            const directory = ompRuntimeDirectory();
            await mkdir(directory, { recursive: true, mode: 0o700 });
            this.#registryWatcher = watch(directory, { recursive: true }, () => {
                void this.#refresh();
            });
            this.#registryWatcher.on('error', error => {
                this.#setInfo({
                    state: 'unavailable',
                    detail: `Cannot watch the connected chat: ${error.message}`,
                });
            });
        }
        await this.#refresh();
    }

    info(): ProviderInfo {
        return this.#info;
    }

    onInfoChange(listener: (info: ProviderInfo) => void): () => void {
        this.#infoListeners.add(listener);
        return () => this.#infoListeners.delete(listener);
    }

    async listThreads(): Promise<{ project: ProviderProject; threads: ProviderThreadSummary[] }> {
        const session = await this.#ready();
        const threads = await requestOmpSession(
            session,
            { kind: 'list', projectRoot: this.#root },
            z.array(OmpThread),
        );
        return {
            project: { name: basename(this.#root) },
            threads: threads.map(thread => ({
                id: thread.id,
                title: thread.title,
                status: thread.status,
                updatedAt: thread.updatedAt,
                agent: 'omp',
            })),
        };
    }

    threadUrl(): undefined {
        return undefined;
    }

    async createThread(input: CreateThreadInput): Promise<CreatedThread> {
        const session = await this.#ready();
        const result = await requestOmpSession(
            session,
            {
                kind: 'create',
                projectRoot: this.#root,
                title: input.title,
                requestId: crypto.randomUUID(),
                text: input.text,
                attachments: input.attachments,
            },
            z.object({ threadId: z.string() }),
        );
        return { providerThreadId: result.threadId };
    }

    async sendMessage(input: SendMessageInput): Promise<void> {
        const session = await this.#ready();
        await requestOmpSession(
            session,
            {
                kind: 'send',
                projectRoot: this.#root,
                threadId: input.providerThreadId,
                requestId: crypto.randomUUID(),
                text: input.text,
                attachments: input.attachments,
            },
            z.object({ accepted: z.literal(true) }),
        );
    }

    async interrupt(providerThreadId: string): Promise<void> {
        const session = await this.#ready();
        await requestOmpSession(
            session,
            {
                kind: 'interrupt',
                projectRoot: this.#root,
                threadId: providerThreadId,
            },
            z.object({ accepted: z.literal(true) }),
        );
    }

    watch(providerThreadId: string, sink: ThreadSink): () => void {
        const watch: Watch = { threadId: providerThreadId, sink };
        this.#watches.add(watch);
        void this.#ready().catch((error: unknown) => {
            if (this.#watches.has(watch))
                sink.status('error', error instanceof Error ? error.message : String(error));
        });
        return () => {
            this.#watches.delete(watch);
            watch.stop?.();
        };
    }

    async dispose(): Promise<void> {
        this.#disposed = true;
        this.#registryWatcher?.close();
        for (const watch of this.#watches.values()) watch.stop?.();
        this.#watches.clear();
        this.#infoListeners.clear();
    }

    async #refresh(): Promise<void> {
        this.#dirty = true;
        if (this.#refreshing || this.#disposed) return;
        this.#refreshing = true;
        try {
            do {
                this.#dirty = false;
                try {
                    await this.#ready();
                } catch (error) {
                    this.#options.log?.(
                        `OMP is unavailable: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            } while (this.#dirty && !this.#disposed);
        } finally {
            this.#refreshing = false;
        }
    }

    async #ready(): Promise<OmpSessionRegistration> {
        if (this.#disposed) throw new Error('This page-comment connection is closed.');
        this.#starting ??= this.#connect().finally(() => {
            this.#starting = undefined;
        });
        const session = await this.#starting;
        if (this.#disposed) throw new Error('This page-comment connection is closed.');
        for (const watch of this.#watches) this.#attach(session, watch);
        return session;
    }

    async #connect(): Promise<OmpSessionRegistration> {
        try {
            this.#root = await realpath(this.#options.projectRoot);
            let session = this.#session;
            if (session) {
                session = await requestOmpSession(session, undefined, OmpSessionRegistration);
                if (!session.projectRoots.includes(this.#root))
                    throw new Error('This project is disconnected from its chat.');
            } else {
                const sessions = await activeOmpSessions(this.#root);
                if (sessions.length > 1)
                    throw new Error(
                        'More than one chat is connected to this project. Disconnect the extra connection before sending a comment.',
                    );
                session = sessions[0];
                if (!session)
                    throw new Error(
                        'Connect this project with point_and_comment in the OMP chat you want to use. Page comments never start a separate agent.',
                    );
            }
            this.#session = session;
            this.#setInfo({ state: 'ready', target: basename(this.#root) });
            return session;
        } catch (error) {
            const detail = this.#session
                ? 'The connected chat is unavailable. Open that same conversation and reconnect page comments.'
                : error instanceof Error
                  ? error.message
                  : String(error);
            this.#setInfo({ state: 'unavailable', detail });
            throw new Error(detail, { cause: error });
        }
    }

    #attach(session: OmpSessionRegistration, watch: Watch): void {
        if (watch.stop || !this.#watches.has(watch)) return;
        watch.stop = watchOmpSession(
            session,
            { kind: 'watch', projectRoot: this.#root, threadId: watch.threadId },
            event => {
                this.#event(watch.sink, event);
            },
            error => {
                watch.stop?.();
                watch.stop = undefined;
                this.#setInfo({ state: 'unavailable', detail: error.message });
                watch.sink.status('error', error.message);
            },
        );
    }

    #event(sink: ThreadSink, event: OmpEvent): void {
        if (event.type === 'snapshot') {
            for (const message of event.thread.messages) sink.message(message);
            for (const step of event.thread.steps) sink.step?.(step);
            sink.status(event.thread.status, event.thread.detail);
        } else if (event.type === 'message') sink.message(event.message);
        else if (event.type === 'step') sink.step?.(event.step);
        else if (event.type === 'status') sink.status(event.status, event.detail);
        else
            sink.status(
                'error',
                'This chat disconnected. Reopen the same conversation to continue.',
            );
    }

    #setInfo(next: Omit<ProviderInfo, 'id' | 'label'>): void {
        if (
            next.state === this.#info.state &&
            next.detail === this.#info.detail &&
            next.target === this.#info.target
        )
            return;
        this.#info = { id: this.id, label: this.label, ...next };
        for (const listener of this.#infoListeners) listener(this.#info);
    }
}
