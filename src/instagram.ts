import {
	cleanText,
	PAGE_HEADERS,
	readCapped,
	type WebFetch,
	WebRecipeError,
} from "./web-recipe.ts";

// Instagram posts carry no recipe data, only a caption written by hand. The post's public embed
// page (the one other sites use to show a post) gives that caption without logging in.

export interface InstagramPost {
	source: string;
	author?: string;
	title: string;
	lines: string[];
}

const HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const MAX_LINES = 400;

// /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>, optionally after the author's name
export function instagramShortcode(url: URL): string | null {
	if (!HOSTS.has(url.hostname.toLowerCase())) return null;
	const match = /^\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([\w-]{5,40})\/?/.exec(url.pathname);
	return match?.[1] ?? null;
}

export function isInstagramLink(raw: string): boolean {
	try {
		return instagramShortcode(new URL(raw.trim())) !== null;
	} catch {
		return false;
	}
}

export function parseEmbedCaption(html: string, source: string): InstagramPost | null {
	const start = html.indexOf('<div class="Caption">');
	if (start < 0) return null;
	const end = html.indexOf('<div class="CaptionComments"', start);
	let block = html.slice(start, end > start ? end : start + 60_000);
	const author = /<a class="CaptionUsername"[^>]*>([^<]*)<\/a>/.exec(block)?.[1];
	block = block.replace(/<a class="CaptionUsername"[^>]*>[^<]*<\/a>/, "");
	const lines: string[] = [];
	for (const raw of block.split(/<br\s*\/?>/i)) {
		const line = cleanText(raw);
		// Hashtag rows say nothing about the dish
		if (/^(#\S+\s*)+$/.test(line)) continue;
		if (line || (lines.length > 0 && lines[lines.length - 1] !== "")) lines.push(line);
		if (lines.length >= MAX_LINES) break;
	}
	while (lines[lines.length - 1] === "") lines.pop();
	const title = lines.find((l) => l)?.slice(0, 120);
	if (!title) return null;
	return { source, ...(author && { author: cleanText(author) }), title, lines };
}

export async function fetchInstagramPost(raw: string, fetchFn: WebFetch): Promise<InstagramPost> {
	const url = new URL(raw.trim());
	const code = instagramShortcode(url);
	if (!code) throw new WebRecipeError("That is not an Instagram post", 400);
	const source = `https://www.instagram.com/p/${code}/`;
	let response: Response;
	try {
		response = await fetchFn(new URL(`${source}embed/captioned/`), {
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
			headers: PAGE_HEADERS,
		});
	} catch {
		throw new WebRecipeError("Could not reach Instagram", 502);
	}
	if (!response.ok) {
		throw new WebRecipeError(`Instagram answered HTTP ${response.status}`, 502);
	}
	const post = parseEmbedCaption(await readCapped(response), source);
	// Private posts and ones whose owner turned off embedding come back without a caption
	if (!post) throw new WebRecipeError("Instagram did not share that post's caption", 422);
	return post;
}
