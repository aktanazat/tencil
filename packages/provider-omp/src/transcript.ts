import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ProviderMessage } from '@tencildev/protocol';

type Role = 'user' | 'assistant';

interface Entry {
    /** The ACP `messageId` its chunks came with. */
    key: string | undefined;
    role: Role;
    text: string;
}

/**
 * A conversation folded from the text chunks OMP streams over ACP. Ids and
 * timestamps come from each message's position, so replaying the saved
 * session gives the same ids as the live turn that wrote it.
 */
export class Transcript {
    readonly #sessionId: string;
    readonly #epoch: number;
    readonly #entries: Entry[] = [];

    constructor(sessionId: string) {
        this.#sessionId = sessionId;
        this.#epoch = sessionCreatedAt(sessionId);
    }

    /** Adds a chunk to the message it belongs to; returns that message's position. */
    add(role: Role, content: ContentBlock, messageId: string | undefined): number | undefined {
        if (content.type !== 'text' || !content.text) return undefined;
        const last = this.#entries.at(-1);
        if (last && last.role === role && (messageId === undefined || messageId === last.key)) {
            last.text += content.text;
            return this.#entries.length - 1;
        }
        return this.#entries.push({ key: messageId, role, text: content.text }) - 1;
    }

    /** A message OMP doesn't stream back, like the prompt Tencil sent. */
    push(role: Role, text: string): number {
        return this.#entries.push({ key: undefined, role, text }) - 1;
    }

    message(index: number, streaming: boolean): ProviderMessage | undefined {
        const entry = this.#entries[index];
        return entry && this.#toMessage(entry, index, streaming);
    }

    messages(): ProviderMessage[] {
        return this.#entries.map((entry, index) => this.#toMessage(entry, index, false));
    }

    /**
     * OMP's replay leaves out the error a reply streamed live once that reply
     * has other text, so keep live text that extends the saved text.
     */
    keepLiveText(live: Transcript): void {
        for (const [index, entry] of this.#entries.entries()) {
            const shown = live.#entries[index];
            if (shown?.role === entry.role && shown.text.startsWith(entry.text))
                entry.text = shown.text;
        }
    }

    #toMessage(entry: Entry, index: number, streaming: boolean): ProviderMessage {
        return {
            id: `${this.#sessionId}:${index}`,
            role: entry.role,
            text: entry.text,
            streaming: streaming && entry.role === 'assistant',
            createdAt: new Date(this.#epoch + index).toISOString(),
        };
    }
}

/** OMP session ids are UUIDv7, which start with their creation time in milliseconds. */
function sessionCreatedAt(sessionId: string): number {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(sessionId)
        ? Number.parseInt(sessionId.slice(0, 8) + sessionId.slice(9, 13), 16)
        : 0;
}
