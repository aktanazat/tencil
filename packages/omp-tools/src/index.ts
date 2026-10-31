import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { registerBrowserSearch } from './browser-search.ts';
import { registerMacHarness } from './mac-harness.ts';
import { registerPageComments } from './page-comments.ts';

export default function localHarnesses(api: ExtensionAPI): void {
    registerBrowserSearch(api);
    registerMacHarness(api);
    registerPageComments(api);
}
