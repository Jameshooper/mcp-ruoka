import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { instagramShortcode, parseEmbedCaption } from "./instagram.ts";
import { unzipFiles } from "./zip.ts";

let dir = "";
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-ig-"));
	process.env.RUOKA_DATA_DIR = dir;
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

// The shape of Instagram's public embed page, cut down to the caption
const EMBED = `<html><body><div class="Embed"><div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/cook/" target="_blank">cook</a><br /><br />Crispy Hashbrowns 🥔<br /><br />For the Hashbrowns:<br />-5 large potatoes<br />-3 tbsps corn starch<br /><br />Instructions:<br /><br />1. Boil &amp; grate the potatoes.<br />2. Fry until golden.<br /><br /><a href="/explore/tags/recipe/">#recipe</a> <a href="/explore/tags/cooking/">#cooking</a><div class="CaptionComments">View all comments</div></div></div></body></html>`;

test("Instagram post links are recognised in their usual forms", () => {
	for (const link of [
		"https://www.instagram.com/p/DeP9EKKSqsa/",
		"https://instagram.com/reel/DeP9EKKSqsa/?igsh=abc",
		"https://www.instagram.com/reels/DeP9EKKSqsa",
		"https://www.instagram.com/cook/p/DeP9EKKSqsa/",
	]) {
		expect(instagramShortcode(new URL(link))).toBe("DeP9EKKSqsa");
	}
	expect(instagramShortcode(new URL("https://www.instagram.com/cook/"))).toBeNull();
	expect(instagramShortcode(new URL("https://example.com/p/DeP9EKKSqsa/"))).toBeNull();
});

test("the caption is read line by line, without the author link or hashtag row", () => {
	const post = parseEmbedCaption(EMBED, "https://www.instagram.com/p/X1/");
	expect(post).toEqual({
		source: "https://www.instagram.com/p/X1/",
		author: "cook",
		title: "Crispy Hashbrowns 🥔",
		lines: [
			"Crispy Hashbrowns 🥔",
			"",
			"For the Hashbrowns:",
			"-5 large potatoes",
			"-3 tbsps corn starch",
			"",
			"Instructions:",
			"",
			"1. Boil & grate the potatoes.",
			"2. Fry until golden.",
		],
	});
	expect(parseEmbedCaption("<html>Private</html>", "https://www.instagram.com/p/X1/")).toBeNull();
});

const Reply = z.object({ message: z.string() });
const RequestJson = z.object({ url: z.string() });

function share(path: string) {
	return new Request(`http://x${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url: "https://www.instagram.com/reel/DeP9EKKSqsa/?igsh=x" }),
	});
}

test("shared from Instagram: the caption goes to the Kindle, or into the inbox for Claude", async () => {
	const { handleUiRequest, setWebFetchForTests } = await import("./ui-server.ts");
	const { handleKindleRequest, resetKindleState } = await import("./kindle.ts");
	const { listDrafts, deleteDraft } = await import("./draft-book.ts");
	resetKindleState();
	const fetched: string[] = [];
	setWebFetchForTests(async (url) => {
		fetched.push(url.toString());
		return new Response(EMBED, { headers: { "Content-Type": "text/html" } });
	});

	const sent = await handleUiRequest(share("/api/kindle/open-url"));
	expect(sent.status).toBe(200);
	expect(Reply.parse(await sent.json()).message).toBe('Sent "Crispy Hashbrowns 🥔" to the Kindle');
	expect(fetched).toEqual(["https://www.instagram.com/p/DeP9EKKSqsa/embed/captioned/"]);
	const request = RequestJson.parse(
		await (await handleKindleRequest(new Request("http://kindle/kindle/request"))).json(),
	);
	const book = await handleKindleRequest(new Request(`http://kindle${request.url}`));
	const page = new TextDecoder().decode(
		unzipFiles(new Uint8Array(await book.arrayBuffer())).get("OEBPS/recipe.xhtml"),
	);
	expect(page).toContain("<h1>Crispy Hashbrowns</h1>");
	expect(page).toContain("From @cook on Instagram");
	expect(page).toContain("<h3>For the Hashbrowns</h3>");
	expect(page).toContain("<ul>\n<li>5 large potatoes</li>");
	expect(page).toContain('<ol class="method">');
	expect(page).toContain("<li>Boil &amp; grate the potatoes.</li>");

	const saved = await handleUiRequest(share("/api/recipes/import-url"));
	expect(saved.status).toBe(200);
	expect(Reply.parse(await saved.json()).message).toContain(
		'Saved "Crispy Hashbrowns 🥔" to Ruoka\'s inbox',
	);
	const drafts = await listDrafts();
	expect(drafts).toHaveLength(1);
	expect(drafts[0]).toMatchObject({
		id: "instagram-DeP9EKKSqsa",
		author: "cook",
		source: "https://www.instagram.com/p/DeP9EKKSqsa/",
	});
	expect(drafts[0]?.caption).toContain("-5 large potatoes\n-3 tbsps corn starch");

	const again = await handleUiRequest(share("/api/recipes/import-url"));
	expect(again.status).toBe(200);
	expect(Reply.parse(await again.json()).message).toContain("already in Ruoka's inbox");

	setWebFetchForTests(async () => new Response("<html>Private</html>"));
	await deleteDraft("instagram-DeP9EKKSqsa");
	const hidden = await handleUiRequest(share("/api/recipes/import-url"));
	expect(hidden.status).toBe(200);
	expect(Reply.parse(await hidden.json()).message).toBe(
		"Instagram did not share that post's caption",
	);
	setWebFetchForTests(fetch);
});

// What the post page carries when the embed page leaves the caption out
const POST_PAGE = `<html><head><meta property="og:title" content="Cook on Instagram: &quot;Wraps &#x1f32f;&quot;" /><meta property="og:description" content="27K likes, 117 comments - jalal.cook on November 1, 2026: &quot;Korean BBQ Chicken Wraps &#x1f357;
Macros: 520 kcal - 45g protein

Ingredients:
- 900 g chicken thighs
- 2 tbsp gochujang

1. Air fry the chicken.

#highprotein #mealprep&quot;. " /></head></html>`;

test("when the embed page has no caption, the post page's preview tags are read instead", async () => {
	const { parseMetaCaption, fetchInstagramPost } = await import("./instagram.ts");
	expect(parseMetaCaption(POST_PAGE, "https://www.instagram.com/p/X2/")).toEqual({
		source: "https://www.instagram.com/p/X2/",
		author: "jalal.cook",
		title: "Korean BBQ Chicken Wraps 🍗",
		lines: [
			"Korean BBQ Chicken Wraps 🍗",
			"Macros: 520 kcal - 45g protein",
			"",
			"Ingredients:",
			"- 900 g chicken thighs",
			"- 2 tbsp gochujang",
			"",
			"1. Air fry the chicken.",
		],
	});
	const titleOnly = POST_PAGE.replace(/<meta property="og:description"[^>]*>/, "");
	expect(parseMetaCaption(titleOnly, "https://www.instagram.com/p/X2/")?.title).toBe("Wraps 🌯");

	const asked: string[] = [];
	const post = await fetchInstagramPost("https://www.instagram.com/reel/X2abc/", async (url) => {
		asked.push(url.toString());
		return new Response(url.pathname.includes("embed") ? "<html>video only</html>" : POST_PAGE);
	});
	expect(asked).toEqual([
		"https://www.instagram.com/p/X2abc/embed/captioned/",
		"https://www.instagram.com/p/X2abc/",
	]);
	expect(post.title).toBe("Korean BBQ Chicken Wraps 🍗");
	await expect(
		fetchInstagramPost("https://www.instagram.com/p/X3abc/", async () => {
			throw new Error("offline");
		}),
	).rejects.toThrow("Could not reach Instagram");
});

test("the app lists the inbox and removes a post from it", async () => {
	const { handleUiRequest } = await import("./ui-server.ts");
	const { addInstagramDraft } = await import("./draft-book.ts");
	await addInstagramDraft({
		source: "https://www.instagram.com/p/Inbox1/",
		title: "Soup",
		lines: ["Soup", "- 1 l stock"],
	});
	const Drafts = z.object({ drafts: z.array(z.object({ id: z.string(), title: z.string() })) });
	const listed = Drafts.parse(
		await (await handleUiRequest(new Request("http://x/api/drafts"))).json(),
	);
	expect(listed.drafts.map((d) => d.id)).toContain("instagram-Inbox1");
	const remove = () =>
		handleUiRequest(new Request("http://x/api/drafts/instagram-Inbox1", { method: "DELETE" }));
	expect((await remove()).status).toBe(200);
	expect((await remove()).status).toBe(404);
});
