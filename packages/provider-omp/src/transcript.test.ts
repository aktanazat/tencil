import { expect, it } from 'vitest';
import { Transcript } from './transcript.ts';

it('replays the same conversation when live replies arrive in smaller chunks', () => {
    const id = '01a193b2-ac04-7661-8b8c-24ad7d25bf13';
    const live = new Transcript(id);
    live.push('user', 'change the heading');
    live.add('assistant', { type: 'text', text: 'i found ' }, 'before-edit');
    live.add('assistant', { type: 'text', text: 'the heading' }, 'before-edit');
    live.add('assistant', { type: 'text', text: 'the heading is changed' }, 'after-edit');
    live.push('user', 'restore it');
    live.add('assistant', { type: 'text', text: 'restored' }, 'restored');

    const replay = new Transcript(id);
    replay.add('user', { type: 'text', text: 'change the heading' }, 'first-request');
    replay.add('assistant', { type: 'text', text: 'i found the heading' }, 'before-edit');
    replay.add('assistant', { type: 'text', text: 'the heading is changed' }, 'after-edit');
    replay.add('user', { type: 'text', text: 'restore it' }, 'second-request');
    replay.add('assistant', { type: 'text', text: 'restored' }, 'restored');

    expect(replay.messages()).toEqual(live.messages());
    expect(replay.messages().map(({ role, text }) => ({ role, text }))).toEqual([
        { role: 'user', text: 'change the heading' },
        { role: 'assistant', text: 'i found the heading' },
        { role: 'assistant', text: 'the heading is changed' },
        { role: 'user', text: 'restore it' },
        { role: 'assistant', text: 'restored' },
    ]);
});
