import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ImageAttachment, ThreadMessage, ThreadStep } from '@tencildev/protocol';
import { z } from 'zod';

export const OmpSessionRegistration = z.object({
    version: z.literal(1),
    sessionId: z.uuid(),
    pid: z.number().int().positive(),
    socketPath: z.string(),
    projectRoots: z.array(z.string()),
});
export type OmpSessionRegistration = z.infer<typeof OmpSessionRegistration>;

export const OmpThreadStatus = z.enum(['working', 'waiting', 'idle', 'error']);
export const OmpThread = z.object({
    id: z.string(),
    projectRoot: z.string(),
    title: z.string(),
    messages: z.array(ThreadMessage),
    steps: z.array(ThreadStep),
    status: OmpThreadStatus,
    detail: z.string().optional(),
    updatedAt: z.string(),
});
export type OmpThread = z.infer<typeof OmpThread>;

const commentFields = {
    projectRoot: z.string(),
    requestId: z.uuid(),
    text: z.string().min(1),
    attachments: z.array(ImageAttachment),
};
export const OmpOperation = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('list'), projectRoot: z.string() }),
    z.object({ kind: z.literal('create'), title: z.string(), ...commentFields }),
    z.object({ kind: z.literal('send'), threadId: z.string(), ...commentFields }),
    z.object({ kind: z.literal('interrupt'), projectRoot: z.string(), threadId: z.string() }),
    z.object({ kind: z.literal('watch'), projectRoot: z.string(), threadId: z.string() }),
]);
export type OmpOperation = z.infer<typeof OmpOperation>;

export const OmpComment = z.object({
    ...commentFields,
    threadId: z.string(),
    title: z.string(),
    createdAt: z.string(),
});
export type OmpComment = z.infer<typeof OmpComment>;

export const OmpCommentMeta = OmpComment.omit({ text: true, attachments: true });
export type OmpCommentMeta = z.infer<typeof OmpCommentMeta>;
export const OmpQueuedComment = OmpCommentMeta.extend({
    text: z.string(),
    hasAttachments: z.boolean(),
});
export const OmpStatusRecord = z.object({
    threadId: z.string(),
    status: OmpThreadStatus,
    detail: z.string().optional(),
});

export const OmpEvent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('snapshot'), thread: OmpThread }),
    z.object({ type: z.literal('message'), threadId: z.string(), message: ThreadMessage }),
    z.object({ type: z.literal('step'), threadId: z.string(), step: ThreadStep }),
    z.object({
        type: z.literal('status'),
        threadId: z.string(),
        status: OmpThreadStatus,
        detail: z.string().optional(),
    }),
    z.object({ type: z.literal('gone'), threadId: z.string() }),
]);
export type OmpEvent = z.infer<typeof OmpEvent>;

export function ompRuntimeDirectory(): string {
    return join(homedir(), '.local', 'share', 'tencil-omp', 'runtime');
}

export function ompSessionDirectory(sessionId: string): string {
    return join(ompRuntimeDirectory(), z.uuid().parse(sessionId));
}

export async function activeOmpSessions(projectRoot?: string): Promise<OmpSessionRegistration[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(ompRuntimeDirectory(), { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
    }
    const candidates = entries.filter(
        entry => entry.isDirectory() && z.uuid().safeParse(entry.name).success,
    );
    const sessions = await Promise.all(
        candidates.map(async entry => {
            const directory = join(ompRuntimeDirectory(), entry.name);
            let registration: OmpSessionRegistration;
            try {
                registration = OmpSessionRegistration.parse(
                    JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')),
                );
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                    return undefined;
                throw error;
            }
            if (
                registration.sessionId !== entry.name ||
                registration.socketPath !== join(directory, 's.sock')
            ) {
                throw new Error('Invalid local OMP connection registration.');
            }
            if (projectRoot && !registration.projectRoots.includes(projectRoot)) return undefined;
            try {
                const current = await requestOmpSession(
                    registration,
                    undefined,
                    OmpSessionRegistration,
                );
                if (current.sessionId !== registration.sessionId) return undefined;
                return !projectRoot || current.projectRoots.includes(projectRoot)
                    ? current
                    : undefined;
            } catch {
                return undefined;
            }
        }),
    );
    return sessions.filter(session => session !== undefined);
}

export async function requestOmpSession<T>(
    session: OmpSessionRegistration,
    operation: OmpOperation | undefined,
    schema: z.ZodType<T>,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const body = operation ? JSON.stringify(operation) : undefined;
        const req = request(
            {
                socketPath: session.socketPath,
                path: operation ? '/rpc' : '/health',
                method: operation ? 'POST' : 'GET',
                headers: body ? { 'content-type': 'application/json' } : undefined,
                signal: AbortSignal.timeout(5_000),
            },
            response => {
                response.setEncoding('utf8');
                let text = '';
                response.on('data', (chunk: string) => {
                    text += chunk;
                });
                response.on('error', reject);
                response.on('end', () => {
                    try {
                        const value: unknown = JSON.parse(text);
                        if (response.statusCode !== 200) {
                            const failure = z.object({ error: z.string() }).parse(value);
                            throw new Error(failure.error);
                        }
                        resolve(schema.parse(value));
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        req.on('error', reject);
        req.end(body);
    });
}

export function watchOmpSession(
    session: OmpSessionRegistration,
    operation: Extract<OmpOperation, { kind: 'watch' }>,
    onEvent: (event: OmpEvent) => void,
    onError: (error: Error) => void,
): () => void {
    const controller = new AbortController();
    const req = request(
        {
            socketPath: session.socketPath,
            path: '/rpc',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
        },
        response => {
            response.setEncoding('utf8');
            let pending = '';
            const fail = (error: unknown) => {
                if (controller.signal.aborted) return;
                onError(error instanceof Error ? error : new Error(String(error)));
                controller.abort();
            };
            response.on('data', (chunk: string) => {
                pending += chunk;
                if (response.statusCode !== 200) return;
                let newline = pending.indexOf('\n');
                while (newline !== -1) {
                    const line = pending.slice(0, newline);
                    pending = pending.slice(newline + 1);
                    newline = pending.indexOf('\n');
                    if (line.length === 0) continue;
                    try {
                        onEvent(OmpEvent.parse(JSON.parse(line)));
                    } catch (error) {
                        fail(error);
                        return;
                    }
                }
            });
            response.on('error', fail);
            response.on('end', () => {
                if (controller.signal.aborted) return;
                if (response.statusCode !== 200) {
                    try {
                        fail(
                            new Error(
                                z.object({ error: z.string() }).parse(JSON.parse(pending)).error,
                            ),
                        );
                    } catch (error) {
                        fail(error);
                    }
                    return;
                }
                fail(
                    new Error(
                        'This chat disconnected. Reconnect it before sending another page comment.',
                    ),
                );
            });
        },
    );
    req.on('error', error => {
        if (!controller.signal.aborted) onError(error);
    });
    req.end(JSON.stringify(operation));
    return () => controller.abort();
}
