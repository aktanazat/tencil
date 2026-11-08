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
type Result = { title: string; url: string; snippet: string };
type PageHit = { url: string; title: string; readAt: number; excerpt: string };
type Engine = 'google' | 'bing' | 'stored';
type Found = { engine: Engine; results: Result[]; notes: string[]; read: PageHit[] };
type RpcModule = {
    rpc: Invoke;
    ownCalls(pid: number): void;
    withTask<T>(task: string, run: () => Promise<T>): Promise<T>;
    quietly<T>(run: () => Promise<T>): Promise<T>;
};
type Kit = { close(): Promise<unknown> };
type KitModule = { SiteKit: new (send: Invoke) => Kit };
type SearchModule = {
    webSearch(kit: Kit): {
        search(query: string, options: { limit: number }): Promise<unknown>;
    };
};
type Pooled = { kit: Kit; signal?: AbortSignal };

// A search keeps its Google and Bing tabs for the task's next one: opening
// a tab took 1.2 s of a 1.8 s search (11-08). Searches that run at once
// each take their own kit, since two in one tab would load over each other.
const IDLE_KITS = 4;
const TASKS_KEPT = 32;
const idleKits = new Map<string, Pooled[]>();

function takeKit(task: string, make: () => Pooled): Pooled {
    const idle = idleKits.get(task);
    const pooled = idle?.pop();
    if (idle?.length === 0) idleKits.delete(task);
    return pooled ?? make();
}

function giveBack(task: string, pooled: Pooled): void {
    pooled.signal = undefined;
    const idle = idleKits.get(task) ?? [];
    idleKits.delete(task);
    idleKits.set(task, idle);
    if (idle.length < IDLE_KITS) idle.push(pooled);
    else void pooled.kit.close().catch(() => undefined);
    for (const [oldest, kits] of idleKits) {
        if (idleKits.size <= TASKS_KEPT) break;
        idleKits.delete(oldest);
        for (const k of kits) void k.kit.close().catch(() => undefined);
    }
}

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
    return record(value) && typeof value.webSearch === 'function';
}

async function loadSafari() {
    const root = join(homedir(), '.local/share/safari-harness/current/daemon');
    const [rpc, kit, search]: unknown[] = await Promise.all([
        import(pathToFileURL(join(root, 'rpc.ts')).href),
        import(pathToFileURL(join(root, 'sites/kit.ts')).href),
        import(pathToFileURL(join(root, 'sites/web-search.ts')).href),
    ]);
    if (!rpcModule(rpc) || !kitModule(kit) || !searchModule(search)) {
        throw new Error('The installed Safari helper does not expose the browser search client.');
    }
    return { rpc, kit, search };
}

function searchResult(value: unknown): value is Result {
    return (
        record(value) &&
        typeof value.title === 'string' &&
        typeof value.url === 'string' &&
        typeof value.snippet === 'string'
    );
}

function pageHit(value: unknown): value is PageHit {
    return (
        record(value) &&
        typeof value.url === 'string' &&
        typeof value.title === 'string' &&
        typeof value.readAt === 'number' &&
        typeof value.excerpt === 'string'
    );
}

function readFound(value: unknown): Found {
    if (
        !record(value) ||
        (value.engine !== 'google' && value.engine !== 'bing' && value.engine !== 'stored') ||
        !Array.isArray(value.results) ||
        !value.results.every(searchResult) ||
        !Array.isArray(value.notes) ||
        !value.notes.every(note => typeof note === 'string') ||
        !Array.isArray(value.read) ||
        !value.read.every(pageHit)
    ) {
        throw new Error('Safari returned an unrecognized web search response.');
    }
    return { engine: value.engine, results: value.results, notes: value.notes, read: value.read };
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

function sourcesOf(results: Result[]): SearchSource[] {
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

const ENGINE_NAMES: Record<Engine, string> = {
    google: 'Google',
    bing: 'Bing',
    stored: 'the local page store',
};

function formatResults(sources: SearchSource[], notes: string[], read: PageHit[]): string {
    const parts = notes.map(note => `Note: ${note}`);
    for (const [index, source] of sources.entries()) {
        parts.push(`[${index + 1}] ${source.title}\n    ${source.url}`);
        if (source.snippet) {
            const snippet =
                source.snippet.length > 240 ? `${source.snippet.slice(0, 239)}…` : source.snippet;
            parts.push(`    ${snippet}`);
        }
    }
    if (read.length) parts.push('Already read by an agent (local copy, no browser needed):');
    for (const page of read) {
        const day = new Date(page.readAt).toISOString().slice(0, 10);
        parts.push(
            `- ${page.title || page.url} (read ${day})\n    ${page.url}\n    ${page.excerpt}`,
        );
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

function responseOf(engine: Engine, sources: SearchSource[]): SearchRenderDetails['response'] {
    if (engine === 'google') return { provider: 'google', authMode: 'Safari', sources };
    return {
        provider: 'public',
        authMode: engine === 'bing' ? 'Safari (Bing)' : 'local page store',
        sources,
    };
}

// A read of a web page, kept so a later search finds it without a browser.
// A ranged or raw read is part of a page, and a result the Safari helper
// appended to (walls.ts: lines starting "safari:") holds what his signed-in
// Safari saw. The store refuses addresses that are not public.
const SELECTOR = /:(?:raw|img|conflicts|-?\d[\d,+-]*)(?::raw)?$/;
const READ_MIN = 500;
const READS_KEPT = 200;

function webUrl(path: unknown): string | undefined {
    return typeof path === 'string' && /^https?:\/\//i.test(path) && !SELECTOR.test(path)
        ? path
        : undefined;
}

function textOf(result: unknown): string | undefined {
    const content = record(result) ? result.content : undefined;
    if (!Array.isArray(content)) return undefined;
    const text = content
        .flatMap(block =>
            record(block) && block.type === 'text' && typeof block.text === 'string'
                ? [block.text]
                : [],
        )
        .join('\n');
    return text.length < READ_MIN || /^safari: /m.test(text) ? undefined : text;
}

function captureReads(api: ExtensionAPI): void {
    const asked = new Map<string, string>();
    api.on('tool_execution_start', event => {
        if (event.toolName !== 'read' || !record(event.args)) return;
        const url = webUrl(event.args.path);
        if (url === undefined) return;
        asked.set(event.toolCallId, url);
        for (const id of asked.keys()) {
            if (asked.size <= READS_KEPT) break;
            asked.delete(id);
        }
    });
    api.on('tool_execution_end', event => {
        const url = asked.get(event.toolCallId);
        asked.delete(event.toolCallId);
        const text = url === undefined || event.isError ? undefined : textOf(event.result);
        if (url === undefined || text === undefined) return;
        const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim().slice(0, 300) ?? '';
        void loadSafari()
            .then(client =>
                client.rpc.quietly(() =>
                    client.rpc.rpc('pages', { do: 'put', url, title, text, source: 'read' }),
                ),
            )
            .catch(() => undefined);
    });
}

export function registerBrowserSearch(api: ExtensionAPI): void {
    captureReads(api);
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
            "Search Google in the owner's real Safari session; Bing answers when Google is busy or shows a bot check, and a repeat of a search in the last 10 minutes comes from the local store. Also lists matching pages agents already read, with an excerpt. Known URLs → read. Supports site:, -site:, after: and before: YYYY-MM-DD, inurl:, intitle:, filetype:, quoted phrases, -term and OR. Prefer primary sources and cite their links. Recency adds an after: date unless one is explicit. Returns one page of up to 10 results; limit and num_search_results are result counts (num_search_results takes precedence). No paid provider.",
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
                    notes.push('Web search returns one page of up to 10 results.');
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
                const pooled = takeKit(task, () => {
                    const made: Pooled = {
                        kit: new client.kit.SiteKit(async (name, args) => {
                            if (made.signal?.aborted) throw cancelled();
                            return client.rpc.rpc(name, args);
                        }),
                    };
                    return made;
                });
                pooled.signal = signal;
                const run = client.rpc.withTask(task, () =>
                    client.rpc.quietly(() =>
                        client.search.webSearch(pooled.kit).search(effectiveQuery, { limit }),
                    ),
                );
                let found: Found;
                try {
                    found = readFound(await abortable(run, signal));
                } finally {
                    run.then(
                        () => giveBack(task, pooled),
                        () => void pooled.kit.close().catch(() => undefined),
                    );
                }
                if (signal?.aborted) throw cancelled();
                const sources = sourcesOf(found.results);
                if (sources.length === 0 && found.read.length === 0) {
                    throw new Error(
                        `${ENGINE_NAMES[found.engine]} returned no readable results. This can mean no matches, a consent or check page, or changed result markup.`,
                    );
                }
                notes.push(...found.notes);
                if (found.engine !== 'google')
                    notes.push(`These results came from ${ENGINE_NAMES[found.engine]}.`);
                return {
                    content: [{ type: 'text', text: formatResults(sources, notes, found.read) }],
                    details: { response: responseOf(found.engine, sources) },
                };
            } catch (error) {
                if (signal?.aborted) throw cancelled();
                const message = failureMessage(error);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error: ${message}` }],
                    details: {
                        response: responseOf('google', []),
                        error: message,
                    },
                };
            }
        },
    };
    api.registerTool(tool);
}
