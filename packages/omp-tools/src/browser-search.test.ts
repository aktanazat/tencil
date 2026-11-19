import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBrowserSearch } from './browser-search.ts';
import { fakeOmp } from './omp-extension.test-support.ts';

const location = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => ({
    ...(await importOriginal<typeof import('node:os')>()),
    homedir: () => location.home,
}));
vi.mock('@oh-my-pi/pi-tui/tools/web-search', () => ({ webSearchToolRenderer: {} }));

const safari = {
    search: vi.fn(),
    rpc: vi.fn(),
    ownCalls: vi.fn(),
    withTask: vi.fn((_task: string, run: () => unknown) => run()),
    close: vi.fn(async () => undefined),
};

beforeAll(async () => {
    location.home = await mkdtemp(join(tmpdir(), 'tencil-fake-safari-'));
    vi.stubGlobal('testSafari', safari);
    const root = join(location.home, '.local/share/safari-harness/current/daemon');
    const sites = join(root, 'sites');
    await mkdir(sites, { recursive: true });
    await Promise.all([
        writeFile(
            join(root, 'rpc.ts'),
            'export const { rpc, ownCalls, withTask } = globalThis.testSafari; export const quietly = run => run();',
        ),
        writeFile(
            join(sites, 'kit.ts'),
            'export class SiteKit { close() { return globalThis.testSafari.close(); } }',
        ),
        writeFile(
            join(sites, 'web-search.ts'),
            'export const webSearch = kit => ({ search: (query, options) => globalThis.testSafari.search(kit, query, options) });',
        ),
    ]);
});

afterAll(async () => {
    vi.unstubAllGlobals();
    await rm(location.home, { recursive: true, force: true });
});

const result = { title: 'Example', url: 'https://example.com/', snippet: 'An example' };
const found = { engine: 'google', results: [result], notes: [], read: [] };
let omp: ReturnType<typeof fakeOmp>;

beforeEach(() => {
    vi.clearAllMocks();
    safari.search.mockReset().mockResolvedValue(found);
    omp = fakeOmp();
    registerBrowserSearch(omp.api);
});

describe('web_search', () => {
    it('uses the capped result count and a UTC recency filter without replacing an explicit date', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-05-01T01:00:00Z'));
        try {
            const answer = await omp.run('web_search', {
                query: '  browser docs  ',
                recency: 'week',
                limit: 2,
                num_search_results: 12,
            });
            expect(safari.search).toHaveBeenLastCalledWith(
                expect.anything(),
                'browser docs after:2026-04-24',
                { limit: 10 },
            );
            expect(safari.ownCalls).toHaveBeenCalledWith(process.pid);
            expect(safari.withTask).toHaveBeenCalledWith(
                JSON.stringify([omp.sessionId, omp.context.agent.id]),
                expect.any(Function),
            );
            expect(answer.content[0]).toMatchObject({
                text: expect.stringContaining('up to 10 results'),
            });
            const firstKit = safari.search.mock.calls[0]?.[0];
            await omp.run('web_search', {
                query: 'docs after:2026-04-01',
                recency: 'day',
                limit: 2.9,
            });
            expect(safari.search).toHaveBeenLastCalledWith(firstKit, 'docs after:2026-04-01', {
                limit: 2,
            });
        } finally {
            clock.mockRestore();
        }
    });

    it('cleans and deduplicates links and labels fallback results and previously read pages', async () => {
        const url = 'https://example.com/docs?keep=1#section';
        safari.search.mockResolvedValueOnce({
            ...found,
            engine: 'bing',
            notes: ['Google unavailable'],
            results: [
                {
                    ...result,
                    url: `https://www.google.com/url?q=${encodeURIComponent(
                        'https://example.com/docs?keep=1&srsltid=tracker#section:~:text=highlight',
                    )}`,
                    title: ' Example ',
                },
                { ...result, url },
                { ...result, url: 'javascript:void(0)' },
                { ...result, url: 'https://example.org/', title: ' ' },
            ],
            read: [
                {
                    url,
                    title: 'Earlier read',
                    excerpt: 'Saved text',
                    readAt: Date.parse('2026-04-20'),
                },
            ],
        });
        const answer = await omp.run('web_search', { query: 'docs' });
        expect(answer.details).toEqual({
            response: {
                provider: 'public',
                authMode: 'Safari (Bing)',
                sources: [{ ...result, url }],
            },
        });
        expect(answer.content).toEqual([
            {
                type: 'text',
                text: [
                    'Note: Google unavailable',
                    'Note: These results came from Bing.',
                    '[1] Example',
                    `    ${url}`,
                    '    An example',
                    'Already read by an agent (local copy, no browser needed):',
                    '- Earlier read (read 2026-04-20)',
                    `    ${url}`,
                    '    Saved text',
                ].join('\n'),
            },
        ]);
    });

    it.fails('deduplicates a text-fragment-only link against the same link without a hash', async () => {
        safari.search.mockResolvedValueOnce({
            ...found,
            results: [{ ...result, url: `${result.url}#:~:text=highlight` }, result],
        });
        expect((await omp.run('web_search', { query: 'docs' })).details).toMatchObject({
            response: { sources: [result] },
        });
    });

    it.each([
        [{ query: ' ' }, 'Web search needs a query.'],
        [
            { query: 'docs', limit: Number.POSITIVE_INFINITY },
            'The result count must be a positive finite number.',
        ],
    ])('returns a tool error for invalid arguments: %o', async (params, error) => {
        expect(await omp.run('web_search', params)).toMatchObject({
            isError: true,
            details: { error },
        });
        expect(safari.search).not.toHaveBeenCalled();
    });

    it('returns an error for a malformed Safari result', async () => {
        safari.search.mockResolvedValueOnce({ ...found, results: [{ title: 'missing fields' }] });
        expect(await omp.run('web_search', { query: 'docs' })).toMatchObject({
            isError: true,
            details: { error: 'Safari returned an unrecognized web search response.' },
        });
    });

    it('rejects promptly on cancellation while Safari is still busy', async () => {
        const pending = Promise.withResolvers<typeof found>();
        const started = Promise.withResolvers<void>();
        safari.search.mockImplementationOnce(() => {
            started.resolve();
            return pending.promise;
        });
        const abort = new AbortController();
        const answer = omp.run('web_search', { query: 'docs' }, abort.signal);
        try {
            await started.promise;
            abort.abort();
            await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            pending.resolve(found);
        }
    });

    it('keeps only successful complete public-URL read results', async () => {
        const text = `# Reference\n${'A useful reference. '.repeat(30)}`;
        for (const [id, path, body, isError] of [
            ['good', 'https://example.com/docs', text, false],
            ['range', 'https://example.com/docs:1-20', text, false],
            ['error', 'https://example.com/failed', text, true],
            ['short', 'https://example.com/short', 'too short', false],
            ['signed-in', 'https://example.com/account', `${text}\nsafari: signed in`, false],
            ['local', '/local/file', text, false],
        ] as const) {
            await omp.emit('tool_execution_start', {
                toolName: 'read',
                toolCallId: id,
                args: { path },
            });
            await omp.emit('tool_execution_end', {
                toolCallId: id,
                isError,
                result: { content: [{ type: 'text', text: body }] },
            });
        }
        await vi.waitFor(() => expect(safari.rpc).toHaveBeenCalled());
        expect(safari.rpc.mock.calls).toEqual([
            [
                'pages',
                {
                    do: 'put',
                    url: 'https://example.com/docs',
                    title: 'Reference',
                    text,
                    source: 'read',
                },
            ],
        ]);
    });
});
