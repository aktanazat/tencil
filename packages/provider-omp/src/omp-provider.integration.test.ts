import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import * as os from 'node:os';
import { join } from 'node:path';
import type { ProviderMessage, ThreadSink } from '@tencildev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OmpProvider } from './omp-provider.ts';
import {
    type OmpEvent,
    OmpOperation,
    type OmpSessionRegistration,
    type OmpThread,
    ompSessionDirectory,
} from './session-link.ts';

const location = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => ({
    ...(await importOriginal<typeof os>()),
    homedir: () => location.home,
}));
const cleanup: Array<() => Promise<void>> = [];
let root: string;

beforeEach(async () => {
    location.home = await mkdtemp(
        join(process.platform === 'darwin' ? '/private/var/tmp' : os.tmpdir(), 'o-'),
    );
    const home = location.home;
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    root = await realpath(home);
});
afterEach(async () => {
    while (cleanup.length) await cleanup.pop()?.();
});

async function connectedChat(sessionId = randomUUID()) {
    const directory = ompSessionDirectory(sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const registration: OmpSessionRegistration = {
        version: 1,
        sessionId,
        pid: process.pid,
        socketPath: join(directory, 's.sock'),
        projectRoots: [root],
    };
    const reply: ProviderMessage = {
        id: 'reply',
        role: 'assistant',
        text: 'Saved reply',
        streaming: false,
        createdAt: '2026-10-31T00:00:00.000Z',
    };
    const thread: OmpThread = {
        id: `${sessionId}:pin`,
        projectRoot: root,
        title: 'Selected heading',
        status: 'idle',
        updatedAt: '2026-10-31T00:00:00.000Z',
        steps: [],
        messages: [reply],
    };
    const subscribers = new Set<ServerResponse>();
    let requests = 0;
    const server = createServer((request, response) => {
        requests++;
        if (request.url === '/health') {
            response.end(JSON.stringify(registration));
            return;
        }
        request.setEncoding('utf8');
        let body = '';
        request.on('data', (chunk: string) => {
            body += chunk;
        });
        request.on('end', () => {
            try {
                const operation = OmpOperation.parse(JSON.parse(body));
                expect(operation.projectRoot).toBe(root);
                if (operation.kind === 'list') response.end(JSON.stringify([thread]));
                else if (operation.kind === 'watch') {
                    expect(operation.threadId).toBe(thread.id);
                    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
                    subscribers.add(response);
                    response.on('close', () => subscribers.delete(response));
                    response.write(`${JSON.stringify({ type: 'snapshot', thread })}\n`);
                } else throw new Error(`Unexpected operation: ${operation.kind}`);
            } catch (error) {
                response.writeHead(400);
                response.end(
                    JSON.stringify({
                        error: error instanceof Error ? error.message : String(error),
                    }),
                );
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(registration.socketPath, resolve);
    });
    const pending = join(directory, 'session.tmp');
    await writeFile(pending, JSON.stringify(registration), { mode: 0o600 });
    await rename(pending, join(directory, 'session.json'));
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        for (const response of subscribers) response.end();
        await new Promise<void>((resolve, reject) =>
            server.close(error => (error ? reject(error) : resolve())),
        );
        await rm(join(directory, 'session.json'));
    };
    cleanup.push(close);
    return {
        sessionId,
        thread,
        reply,
        close,
        requests: () => requests,
        subscribers: () => subscribers.size,
        emit(event: OmpEvent) {
            for (const response of subscribers) response.write(`\n${JSON.stringify(event)}\n`);
        },
    };
}

async function pageProvider() {
    const provider = new OmpProvider({ projectRoot: root });
    cleanup.push(() => provider.dispose());
    await provider.start();
    return provider;
}
function record() {
    const messages = new Map<string, ProviderMessage>();
    const statuses: string[] = [];
    const sink: ThreadSink = {
        message: message => messages.set(message.id, message),
        status: status => statuses.push(status),
        gone: () => statuses.push('gone'),
    };
    return { messages, statuses, sink };
}

describe('OMP page conversation', () => {
    it('replays saved replies to every viewer, accepts idle keepalives, and unsubscribes independently', async () => {
        const chat = await connectedChat();
        const provider = await pageProvider();
        const first = record();
        const stopFirst = provider.watch(chat.thread.id, first.sink);
        await vi.waitFor(() => expect(first.messages.get('reply')?.text).toBe('Saved reply'));
        const second = record();
        provider.watch(chat.thread.id, second.sink);
        await vi.waitFor(() =>
            expect(second.messages.get('reply')).toEqual(first.messages.get('reply')),
        );
        const update: OmpEvent = {
            type: 'message',
            threadId: chat.thread.id,
            message: { ...chat.reply, text: 'Follow-up completed' },
        };
        chat.emit(update);
        await vi.waitFor(() => {
            expect(first.messages.get('reply')?.text).toBe('Follow-up completed');
            expect(second.messages.get('reply')?.text).toBe('Follow-up completed');
        });
        stopFirst();
        await vi.waitFor(() => expect(chat.subscribers()).toBe(1));
        chat.emit({ ...update, message: { ...update.message, text: 'Remaining viewer' } });
        await vi.waitFor(() => expect(second.messages.get('reply')?.text).toBe('Remaining viewer'));
        expect(first.messages.get('reply')?.text).toBe('Follow-up completed');
        expect(first.statuses).not.toContain('error');
        expect(second.statuses).not.toContain('error');
    });

    it('discovers a newly connected chat, resumes it after restart, and never moves comments to another chat', async () => {
        const provider = await pageProvider();
        expect(provider.info().state).toBe('unavailable');
        const original = await connectedChat();
        await vi.waitFor(() => expect(provider.info().state).toBe('ready'));
        expect((await provider.listThreads()).threads.map(thread => thread.id)).toEqual([
            original.thread.id,
        ]);
        await original.close();
        await vi.waitFor(() => expect(provider.info().state).toBe('unavailable'));
        const other = await connectedChat();
        await expect(provider.listThreads()).rejects.toThrow('The connected chat is unavailable');
        expect(other.requests()).toBe(0);
        await connectedChat(original.sessionId);
        await vi.waitFor(() => expect(provider.info().state).toBe('ready'));
        expect((await provider.listThreads()).threads.map(thread => thread.id)).toEqual([
            original.thread.id,
        ]);
        expect(other.requests()).toBe(0);
    });
});
