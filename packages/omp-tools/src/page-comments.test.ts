import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type OmpEvent,
    type OmpOperation,
    ompSessionDirectory,
} from '@tencildev/provider-omp/session-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOmp } from './omp-extension.test-support.ts';
import { registerPageComments } from './page-comments.ts';

const discovery = vi.hoisted(() => ({ home: '', active: vi.fn() }));
vi.mock('node:os', async importOriginal => ({
    ...(await importOriginal<typeof import('node:os')>()),
    homedir: () => discovery.home,
}));
vi.mock('@tencildev/provider-omp/session-link', async importOriginal => ({
    ...(await importOriginal<typeof import('@tencildev/provider-omp/session-link')>()),
    activeOmpSessions: discovery.active,
}));

let omp: ReturnType<typeof fakeOmp>;
let project: string;
let fetch: (request: Request) => Promise<Response>;
const stop = vi.fn();

beforeEach(async () => {
    discovery.home = await mkdtemp(join(tmpdir(), 'tencil-page-comments-'));
    await mkdir(join(discovery.home, 'project'));
    project = await realpath(join(discovery.home, 'project'));
    discovery.active.mockReset().mockResolvedValue([]);
    stop.mockClear();
    vi.stubGlobal('Bun', {
        serve(options: { unix: string; fetch: typeof fetch }) {
            writeFileSync(options.unix, '');
            fetch = options.fetch;
            return { stop };
        },
    });
    omp = fakeOmp();
    registerPageComments(omp.api);
});

afterEach(async () => {
    try {
        await omp.emit('session_shutdown', {});
    } finally {
        vi.unstubAllGlobals();
        await rm(discovery.home, { recursive: true, force: true });
    }
});

function rpc(operation: OmpOperation) {
    return fetch(
        new Request('http://localhost/rpc', {
            method: 'POST',
            body: JSON.stringify(operation),
        }),
    );
}

function connect() {
    return omp.run('point_and_comment', { action: 'connect', projectRoot: project });
}

function create() {
    return {
        kind: 'create' as const,
        projectRoot: project,
        requestId: randomUUID(),
        title: 'Heading',
        text: 'Make the heading clearer',
        attachments: [
            {
                mimeType: 'image/png' as const,
                name: 'heading.png',
                dataUrl: 'data:image/png;base64,AA==',
            },
        ],
    };
}

async function openThread(operation = create()) {
    const response = await rpc(operation);
    expect(response.status).toBe(200);
    const { threadId } = (await response.json()) as { threadId: string };
    return threadId;
}

describe('point_and_comment', () => {
    it('publishes the connected chat and removes its registration on disconnect', async () => {
        const { details } = await connect();
        expect(details).toEqual({ connected: true, projects: [project], sessionId: omp.sessionId });
        const registration = join(ompSessionDirectory(omp.sessionId), 'session.json');
        const expected = {
            version: 1,
            sessionId: omp.sessionId,
            pid: process.pid,
            socketPath: join(ompSessionDirectory(omp.sessionId), 's.sock'),
            projectRoots: [project],
        };
        expect(JSON.parse(await readFile(registration, 'utf8'))).toEqual(expected);
        expect(await (await fetch(new Request('http://localhost/health'))).json()).toEqual(
            expected,
        );
        expect(
            await omp.run('point_and_comment', { action: 'disconnect', projectRoot: project }),
        ).toMatchObject({
            details: { connected: false, projects: [] },
        });
        expect(stop).toHaveBeenCalledWith(true);
        await expect(readFile(registration)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses helpers, relative folders, and projects already assigned to another chat', async () => {
        omp.context.agent.kind = 'sub';
        await expect(connect()).rejects.toThrow('main chat, not a helper');
        omp.context.agent.kind = 'main';
        await expect(
            omp.run('point_and_comment', { action: 'connect', projectRoot: 'relative' }),
        ).rejects.toThrow('absolute project folder');
        discovery.active.mockResolvedValueOnce([{ sessionId: randomUUID() }]);
        await expect(connect()).rejects.toThrow('Another chat is connected to this project');
        expect(omp.appendEntry).not.toHaveBeenCalled();
    });

    it('queues and deduplicates requests while the main chat is busy, dispatching after it ends', async () => {
        await connect();
        omp.context.isIdle.mockReturnValue(false);
        const operation = create();
        const threadId = await openThread(operation);
        const retry = { ...operation, kind: 'send' as const, threadId };
        expect(await (await rpc(retry)).json()).toEqual({ accepted: true });
        omp.flush();
        expect(omp.sendMessage).not.toHaveBeenCalled();
        const threads = await (await rpc({ kind: 'list', projectRoot: project })).json();
        expect(threads).toMatchObject([
            {
                id: threadId,
                status: 'waiting',
                messages: [
                    {
                        id: `${threadId}:user:${operation.requestId}`,
                        role: 'user',
                        text: operation.text,
                    },
                ],
            },
        ]);

        omp.context.isIdle.mockReturnValue(true);
        await omp.emit('agent_end', { willContinue: true, messages: [] });
        omp.flush();
        expect(omp.sendMessage).not.toHaveBeenCalled();
        await omp.emit('agent_end', { willContinue: false, messages: [] });
        omp.flush();
        expect(omp.sendMessage).toHaveBeenCalledExactlyOnceWith(
            {
                customType: 'tencil.comment.v1',
                attribution: 'user',
                display: true,
                details: {
                    threadId,
                    projectRoot: project,
                    requestId: operation.requestId,
                    title: operation.title,
                    createdAt: expect.any(String),
                },
                content: [
                    { type: 'text', text: `project: ${project}\n\n${operation.text}` },
                    { type: 'image', data: 'AA==', mimeType: 'image/png' },
                ],
            },
            { triggerTurn: true },
        );
        await omp.emit('agent_end', { willContinue: false, messages: [] });
        omp.flush();
        expect(omp.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('streams scoped replies, approval state, steps, and disconnect to a watcher', async () => {
        await connect();
        const threadId = await openThread();
        const response = await rpc({ kind: 'watch', threadId, projectRoot: project });
        expect(response.headers.get('content-type')).toBe('application/x-ndjson');
        const reader = response.body!.getReader();
        async function event(): Promise<OmpEvent> {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Watch ended before the expected event');
            return JSON.parse(new TextDecoder().decode(chunk.value));
        }
        try {
            expect(await event()).toMatchObject({
                type: 'snapshot',
                thread: { id: threadId, status: 'waiting' },
            });
            omp.flush();
            expect(await event()).toEqual({ type: 'status', threadId, status: 'working' });
            const message = (text: string) => ({
                role: 'assistant',
                timestamp: Date.now(),
                content: [{ type: 'text', text }],
            });
            await omp.emit('message_update', { message: message('Draft') });
            expect(await event()).toMatchObject({
                type: 'message',
                threadId,
                message: { id: `${threadId}:assistant:0`, text: 'Draft', streaming: true },
            });
            await omp.emit('message_end', { message: message('Final') });
            expect(await event()).toMatchObject({
                type: 'message',
                threadId,
                message: { id: `${threadId}:assistant:0`, text: 'Final', streaming: false },
            });

            const call = { toolName: 'read', toolCallId: 'tool-1' };
            await omp.emit('tool_execution_start', { ...call, args: { path: 'heading.tsx' } });
            expect(await event()).toMatchObject({
                type: 'step',
                threadId,
                step: { id: call.toolCallId, status: 'running', detail: 'heading.tsx' },
            });
            await omp.emit('tool_approval_requested', call);
            expect(await event()).toMatchObject({
                type: 'status',
                threadId,
                status: 'waiting',
                detail: expect.stringContaining('approve'),
            });
            await omp.emit('tool_approval_resolved', call);
            expect(await event()).toEqual({ type: 'status', threadId, status: 'working' });
            await omp.emit('tool_execution_end', { ...call, isError: true });
            expect(await event()).toMatchObject({
                type: 'step',
                threadId,
                step: { id: call.toolCallId, status: 'failed' },
            });
            await omp.emit('agent_end', { willContinue: false, messages: [] });
            expect(await event()).toEqual({ type: 'status', threadId, status: 'idle' });
            const threads = await (await rpc({ kind: 'list', projectRoot: project })).json();
            expect(threads).toMatchObject([
                { messages: [{ role: 'user' }, { role: 'assistant', text: 'Final' }] },
            ]);
            await omp.run('point_and_comment', { action: 'disconnect' });
            expect(await event()).toEqual({ type: 'gone', threadId });
            expect((await reader.read()).done).toBe(true);
        } finally {
            await reader.cancel();
        }
    });

    it('rejects unrelated projects and invalid attachments, and drops an interrupted queued comment', async () => {
        await connect();
        const foreign = await rpc({ kind: 'list', projectRoot: join(discovery.home, 'other') });
        expect(foreign.status).toBe(400);
        expect(await foreign.json()).toEqual({
            error: 'This project is not connected to this chat.',
        });
        const threadId = await openThread();
        const invalid = await rpc({
            ...create(),
            kind: 'send',
            threadId,
            attachments: [
                {
                    name: 'heading.png',
                    mimeType: 'image/png',
                    dataUrl: 'data:image/jpeg;base64,AA==',
                },
            ],
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({
            error: 'The image attachment is not a supported base64 image.',
        });
        expect((await rpc({ kind: 'interrupt', threadId, projectRoot: project })).status).toBe(200);
        omp.flush();
        expect(omp.sendMessage).not.toHaveBeenCalled();
        expect(omp.context.abort).not.toHaveBeenCalled();
        expect(await (await rpc({ kind: 'list', projectRoot: project })).json()).toMatchObject([
            { id: threadId, status: 'idle', detail: 'stopped.', messages: [{ role: 'user' }] },
        ]);
    });

    it('restores saved history on session start without redispatching unfinished work', async () => {
        omp.appendEntry.mockImplementation((customType, data) => {
            omp.branch.push({
                type: 'custom',
                customType,
                data: structuredClone(data),
                timestamp: new Date().toISOString(),
            });
        });
        await connect();
        const threadId = await openThread();
        omp.flush();
        const dispatched = omp.sendMessage.mock.calls[0]?.[0];
        omp.branch.push(
            {
                type: 'custom_message',
                customType: dispatched.customType,
                details: dispatched.details,
            },
            {
                type: 'message',
                message: {
                    role: 'assistant',
                    timestamp: Date.now(),
                    content: [{ type: 'text', text: 'Saved reply' }],
                },
            },
        );
        omp.appendEntry.mockReset();
        await omp.emit('session_start', {});
        omp.flush();
        expect(omp.sendMessage).toHaveBeenCalledTimes(1);
        expect(await (await rpc({ kind: 'list', projectRoot: project })).json()).toMatchObject([
            {
                id: threadId,
                status: 'error',
                detail: expect.stringContaining('the chat stopped'),
                messages: [
                    { role: 'user', text: 'Make the heading clearer' },
                    { role: 'assistant', text: 'Saved reply' },
                ],
            },
        ]);
    });
});
