import { logger } from "./logger.ts";
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

// Caption text as lines: hashtag rows dropped, runs of blank lines kept to one
function toPost(
	rawLines: string[],
	author: string | undefined,
	source: string,
): InstagramPost | null {
	const lines: string[] = [];
	for (const raw of rawLines) {
		const line = cleanText(raw);
		// Hashtag rows say nothing about the dish
		if (/^(#\S+\s*)+$/.test(line)) continue;
		if (line || (lines.length > 0 && lines[lines.length - 1] !== "")) lines.push(line);
		if (lines.length >= MAX_LINES) break;
	}
	while (lines[lines.length - 1] === "") lines.pop();
	const title = lines.find((l) => l)?.slice(0, 120);
	if (!title) return null;
	const name = author ? cleanText(author) : "";
	return { source, ...(name && { author: name }), title, lines };
}

export function parseEmbedCaption(html: string, source: string): InstagramPost | null {
	const start = html.indexOf('<div class="Caption">');
	if (start < 0) return null;
	const end = html.indexOf('<div class="CaptionComments"', start);
	let block = html.slice(start, end > start ? end : start + 60_000);
	const author = /<a class="CaptionUsername"[^>]*>([^<]*)<\/a>/.exec(block)?.[1];
	block = block.replace(/<a class="CaptionUsername"[^>]*>[^<]*<\/a>/, "");
	return toPost(block.split(/<br\s*\/?>/i), author, source);
}

function meta(html: string, property: string): string | undefined {
	const value = new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(
		html,
	)?.[1];
	// Quotes mark where the caption starts and ends, so they are decoded before the rest
	return value?.replace(/&quot;|&#0*34;|&#x0*22;/gi, '"');
}

// The post page's preview tags hold the whole caption, line breaks included:
// og:description is '12K likes, 108 comments - cook on October 8, 2026: "caption". '
// and og:title is 'Cook on Instagram: "caption"'
export function parseMetaCaption(html: string, source: string): InstagramPost | null {
	const description = meta(html, "og:description");
	const fromDescription = description
		? /^[^"]*?\s-\s([\w.]+)\s+on\s+[^:"]+:\s*"([\s\S]*)"\.?\s*$/.exec(description)
		: null;
	if (fromDescription?.[2]) {
		return toPost(fromDescription[2].split("\n"), fromDescription[1], source);
	}
	const title = meta(html, "og:title");
	const fromTitle = title ? /^[^"]*?\son Instagram:\s*"([\s\S]*)"\s*$/.exec(title) : null;
	return fromTitle?.[1] ? toPost(fromTitle[1].split("\n"), undefined, source) : null;
}

async function load(url: URL, fetchFn: WebFetch): Promise<string | null> {
	let response: Response;
	try {
		response = await fetchFn(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
			headers: PAGE_HEADERS,
		});
	} catch {
		return null;
	}
	return response.ok ? readCapped(response) : null;
}

// The embed page is tried first; some posts (reels especially) come back without a caption
// there, and then the post page's preview tags usually still have it
export async function fetchInstagramPost(raw: string, fetchFn: WebFetch): Promise<InstagramPost> {
	const code = instagramShortcode(new URL(raw.trim()));
	if (!code) throw new WebRecipeError("That is not an Instagram post", 400);
	const source = `https://www.instagram.com/p/${code}/`;
	const embed = await load(new URL(`${source}embed/captioned/`), fetchFn);
	const fromEmbed = embed ? parseEmbedCaption(embed, source) : null;
	if (fromEmbed) return fromEmbed;
	const postPage = await load(new URL(source), fetchFn);
	const fromPage = postPage ? parseMetaCaption(postPage, source) : null;
	if (fromPage) return fromPage;
	logger.warn(
		{ code, embed: embed !== null, page: postPage !== null },
		"Instagram caption not found",
	);
	if (embed === null && postPage === null)
		throw new WebRecipeError("Could not reach Instagram", 502);
	// Private posts, and ones Instagram shows only to logged-in viewers, have no caption to read
	throw new WebRecipeError("Instagram did not share that post's caption", 422);
}
