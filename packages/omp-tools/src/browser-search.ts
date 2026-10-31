import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from '@oh-my-pi/pi-coding-agent';
import { type SearchRenderDetails, webSearchToolRenderer } from '@oh-my-pi/pi-tui/tools/web-search';
import type { SearchSource } from '@oh-my-pi/pi-tui/tools/web-search-types';

const PAGE_SIZE = 10;
const RECENCY_DAYS = { day: 1, week: 7, month: 30, year: 365 };

type Invoke = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
type GoogleResult = { title: string; url: string; snippet: string };
type RpcModule = {
    rpc: Invoke;
    ownCalls(pid: number): void;
    withTask<T>(task: string, run: () => Promise<T>): Promise<T>;
    quietly<T>(run: () => Promise<T>): Promise<T>;
};
type KitModule = { SiteKit: new (send: Invoke) => object };
type SearchModule = {
    googleSearch(kit: object): {
        search(query: string, options: { limit: number }): Promise<unknown>;
    };
};

const leadOfAgent = new Map<string, string>();
const leadOfHelper = new Map<string, string>();

// The installed Safari extension keeps its task resolver private; mirror its identity tuple, not its cleanup.
function safariTask(ctx: ExtensionContext): string {
    const session = ctx.sessionManager.getSessionId();
    const agent = ctx.agent;
    const parent = agent.parentId === undefined ? undefined : leadOfAgent.get(agent.parentId);
    const lead = agent.kind === 'main' ? session : (leadOfHelper.get(session) ?? parent ?? session);
    if (agent.kind === 'sub') leadOfHelper.set(session, lead);
    leadOfAgent.set(agent.id, lead);
    return JSON.stringify(lead === session ? [session, agent.id] : [session, agent.id, lead]);
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function rpcModule(value: unknown): value is RpcModule {
    return (
        record(value) &&
        typeof value.rpc === 'function' &&
        typeof value.ownCalls === 'function' &&
        typeof value.withTask === 'function' &&
        typeof value.quietly === 'function'
    );
}

function kitModule(value: unknown): value is KitModule {
    return record(value) && typeof value.SiteKit === 'function';
}

function searchModule(value: unknown): value is SearchModule {
    return record(value) && typeof value.googleSearch === 'function';
}

async function loadSafari() {
    const root = join(homedir(), '.local/share/safari-harness/current/daemon');
    const [rpc, kit, search]: unknown[] = await Promise.all([
        import(pathToFileURL(join(root, 'rpc.ts')).href),
        import(pathToFileURL(join(root, 'sites/kit.ts')).href),
        import(pathToFileURL(join(root, 'sites/google-search.ts')).href),
    ]);
    if (!rpcModule(rpc) || !kitModule(kit) || !searchModule(search)) {
        throw new Error('The installed Safari helper does not expose the browser search client.');
    }
    return { rpc, kit, search };
}

function googleResult(value: unknown): value is GoogleResult {
    return (
        record(value) &&
        typeof value.title === 'string' &&
        typeof value.url === 'string' &&
        typeof value.snippet === 'string'
    );
}

function readResults(value: unknown): GoogleResult[] {
    if (!record(value) || !Array.isArray(value.results) || !value.results.every(googleResult)) {
        throw new Error('Safari returned an unrecognized Google search response.');
    }
    return value.results;
}

function cleanUrl(raw: string): string | undefined {
    let url: URL;
    try {
        url = new URL(raw);
        if (
            (url.hostname === 'google.com' || url.hostname.endsWith('.google.com')) &&
            url.pathname === '/url'
        ) {
            const target = url.searchParams.get('q') ?? url.searchParams.get('url');
            if (!target) return undefined;
            url = new URL(target);
        }
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.searchParams.delete('srsltid');
    const fragment = url.hash.indexOf(':~:text=');
    if (fragment !== -1) url.hash = url.hash.slice(0, fragment);
    return url.href;
}

function sourcesOf(results: GoogleResult[]): SearchSource[] {
    const seen = new Set<string>();
    const sources: SearchSource[] = [];
    for (const result of results) {
        const url = cleanUrl(result.url);
        if (!url || seen.has(url) || !result.title.trim()) continue;
        seen.add(url);
        sources.push({ title: result.title.trim(), url, snippet: result.snippet.trim() });
    }
    return sources;
}

function formatResults(sources: SearchSource[], notes: string[]): string {
    const parts = notes.map(note => `Note: ${note}`);
    for (const [index, source] of sources.entries()) {
        parts.push(`[${index + 1}] ${source.title}\n    ${source.url}`);
        if (source.snippet) {
            const snippet =
                source.snippet.length > 240 ? `${source.snippet.slice(0, 239)}…` : source.snippet;
            parts.push(`    ${snippet}`);
        }
    }
    return parts.join('\n');
}

function failureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (record(error) && typeof error.next === 'string' && !message.includes(error.next)) {
        return `${message}\nNext: ${error.next}`;
    }
    return message;
}

function cancelled(): DOMException {
    return new DOMException('Web search cancelled', 'AbortError');
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return work;
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
        return await Promise.race([work, aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

export function registerBrowserSearch(api: ExtensionAPI): void {
    const parameters = api.arktype({
        query: 'string',
        recency: "'day' | 'week' | 'month' | 'year'?",
        limit: 'number?',
        num_search_results: 'number?',
    });
    api.on('tool_call', (_event, ctx) => {
        safariTask(ctx);
    });

    const tool: ToolDefinition<typeof parameters, SearchRenderDetails> & {
        mergeCallAndResult: true;
    } = {
        name: 'web_search',
        label: 'Web Search',
        description:
            "Search Google in the owner's real Safari session. Known URLs → read. Supports site:, -site:, after: and before: YYYY-MM-DD, inurl:, intitle:, filetype:, quoted phrases, -term and OR. Prefer primary sources and cite their links. Recency adds an after: date unless one is explicit. Returns one page of up to 10 organic results; limit and num_search_results are result counts (num_search_results takes precedence). No paid provider or fallback.",
        parameters,
        approval: 'read',
        strict: true,
        loadMode: 'discoverable',
        mergeCallAndResult: true,
        renderCall: webSearchToolRenderer.renderCall,
        renderResult: webSearchToolRenderer.renderResult,
        describeCall: webSearchToolRenderer.describeCall,
        describeResult: webSearchToolRenderer.describeResult,
        async execute(
            _id,
            params,
            signal,
            _onUpdate,
            ctx,
        ): Promise<AgentToolResult<SearchRenderDetails>> {
            if (signal?.aborted) throw cancelled();
            try {
                const query = params.query.trim();
                if (!query) throw new Error('Web search needs a query.');
                const requested = params.num_search_results ?? params.limit ?? PAGE_SIZE;
                if (!Number.isFinite(requested) || requested < 1) {
                    throw new Error('The result count must be a positive finite number.');
                }
                const limit = Math.min(PAGE_SIZE, Math.floor(requested));
                const notes: string[] = [];
                if (requested > PAGE_SIZE)
                    notes.push('Google search returns one page of up to 10 organic results.');
                let effectiveQuery = query;
                if (params.recency && !/(?:^|\s)after:\d{4}-\d{2}-\d{2}\b/i.test(query)) {
                    const after = new Date(Date.now() - RECENCY_DAYS[params.recency] * 86_400_000)
                        .toISOString()
                        .slice(0, 10);
                    effectiveQuery += ` after:${after}`;
                    notes.push(`Recency was applied as after:${after}.`);
                }
                const client = await loadSafari();
                if (signal?.aborted) throw cancelled();
                client.rpc.ownCalls(process.pid);
                const task = safariTask(ctx);
                const run = client.rpc.withTask(task, () =>
                    client.rpc.quietly(async () => {
                        const kit = new client.kit.SiteKit(async (name, args) => {
                            if (signal?.aborted) throw cancelled();
                            return client.rpc.rpc(name, args);
                        });
                        return client.search.googleSearch(kit).search(effectiveQuery, { limit });
                    }),
                );
                const page = await abortable(run, signal);
                if (signal?.aborted) throw cancelled();
                const sources = sourcesOf(readResults(page));
                if (sources.length === 0) {
                    throw new Error(
                        'Google returned no readable organic results. This can mean no matches, a consent or check page, or changed result markup. No alternate provider was used.',
                    );
                }
                return {
                    content: [{ type: 'text', text: formatResults(sources, notes) }],
                    details: { response: { provider: 'google', authMode: 'Safari', sources } },
                };
            } catch (error) {
                if (signal?.aborted) throw cancelled();
                const message = failureMessage(error);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error: ${message}` }],
                    details: {
                        response: { provider: 'google', authMode: 'Safari', sources: [] },
                        error: message,
                    },
                };
            }
        },
    };
    api.registerTool(tool);
}
