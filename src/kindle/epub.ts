import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipFiles } from "../zip.ts";

// EPUB packaging for KOReader on the Kindle: the page wrapper, the stylesheet, the cover and the
// rules that keep pages readable on its fonts. What goes on the pages is in cookbook.ts.

// KOReader shows the cover of the last book opened as the Kindle's sleep screen, so every book gets
// it, not only the cookbook: a recipe sent with Cook is usually the last one opened.
// cookbook-cover.svg is the source, drawn at the Paperwhite's 1072x1448 and saved as greyscale PNG
const COVER = readFileSync(join(import.meta.dirname, "cookbook-cover.png"));

export interface Page {
	file: string;
	title: string;
	body: string;
}

// KOReader justifies text and indents paragraphs unless told otherwise, which spreads short
// headings across the line on a narrow screen
const CSS = `
body { font-family: serif; line-height: 1.4; margin: 0 0.4em; }
h1, h2, h3, p, li, td { text-align: left; text-indent: 0; hyphens: none; }
h1 { font-size: 1.6em; line-height: 1.2; margin: 1.2em 0 0.4em 0; }
h2 { font-size: 1.2em; margin: 1.1em 0 0.3em 0; border-bottom: 1px solid #000; padding-bottom: 0.1em; }
h3 { font-size: 1.05em; margin: 0.9em 0 0.2em 0; }
p { margin: 0.3em 0; }
.meta { font-size: 0.95em; margin: 0 0 0.2em 0; }
.small { font-size: 0.85em; }
.tags { font-size: 0.85em; font-style: italic; }
ul, ol { margin: 0.3em 0 0.3em 1.3em; padding: 0; }
li { margin: 0.25em 0; }
ol.method li { margin: 0.6em 0; }
ul.toc { list-style: none; margin-left: 0; }
ul.toc li { margin: 0.55em 0; }
.sub { font-size: 0.85em; }
td { vertical-align: top; padding: 0.15em 0.4em 0.15em 0; }
td.q { white-space: nowrap; text-align: right; font-weight: bold; }
.nav { font-size: 0.9em; margin-top: 1.4em; border-top: 1px solid #000; padding-top: 0.3em; }
.note { font-size: 0.9em; border-left: 3px solid #000; padding-left: 0.5em; margin-top: 1em; }
.center, .center h1, .center p { text-align: center; }
`;

const ENCODER = new TextEncoder();

// Kindle fonts have no emoji, which would show as empty boxes. ©, ® and ™ count as pictographs but
// the fonts have them.
const EMOJI_RE =
	/(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|[\u{1F3FB}-\u{1F3FF}]/gu;

export function stripEmoji(text: string): string {
	const stripped = text.replace(EMOJI_RE, "");
	return stripped === text ? text : stripped.replace(/ {2,}/g, " ");
}

export function escapeXml(value: string | number): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function page(title: string, body: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>
`;
}

export function packageEpub(options: {
	title: string;
	pages: Page[];
	nav: Array<{ label: string; file: string; children?: Array<{ label: string; file: string }> }>;
	modified: Date;
	identifier: string;
}): Uint8Array {
	const { modified, identifier } = options;
	const title = stripEmoji(options.title);
	const pages = options.pages.map((p) => ({
		...p,
		title: stripEmoji(p.title),
		body: stripEmoji(p.body),
	}));
	const nav = options.nav.map((item) => ({
		...item,
		label: stripEmoji(item.label),
		children: item.children?.map((c) => ({ ...c, label: stripEmoji(c.label) })),
	}));
	const stamp = `${modified.toISOString().slice(0, 19)}Z`;

	const navList = nav
		.map((item) => {
			const kids = item.children?.length
				? `<ol>${item.children.map((c) => `<li><a href="${c.file}">${escapeXml(c.label)}</a></li>`).join("")}</ol>`
				: "";
			return `<li><a href="${item.file}">${escapeXml(item.label)}</a>${kids}</li>`;
		})
		.join("");
	const navDoc = page(
		"Contents",
		`<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navList}</ol></nav>`,
	);

	// KOReader and older readers take the table of contents from the NCX
	let order = 0;
	const point = (label: string, file: string, children = ""): string => {
		order += 1;
		return `<navPoint id="np${order}" playOrder="${order}"><navLabel><text>${escapeXml(label)}</text></navLabel><content src="${file}"/>${children}</navPoint>`;
	};
	const ncxPoints = nav
		.map((item) => {
			if (!item.children?.length) return point(item.label, item.file);
			order += 1;
			const parentOrder = order;
			const kids = item.children.map((c) => point(c.label, c.file)).join("");
			return `<navPoint id="np${parentOrder}" playOrder="${parentOrder}"><navLabel><text>${escapeXml(item.label)}</text></navLabel><content src="${item.file}"/>${kids}</navPoint>`;
		})
		.join("");
	const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(identifier)}"/><meta name="dtb:depth" content="2"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${ncxPoints}</navMap></ncx>
`;

	const manifest = [
		'<item id="css" href="style.css" media-type="text/css"/>',
		'<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
		'<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
		'<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>',
		...pages.map(
			(p, i) => `<item id="p${i}" href="${p.file}" media-type="application/xhtml+xml"/>`,
		),
	].join("");
	const spine = pages.map((_, i) => `<itemref idref="p${i}"/>`).join("");
	const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>Ruoka</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">${stamp}</meta><meta name="cover" content="cover-image"/></metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>
`;
	const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>
`;

	// The zip timestamp comes from the data, so unchanged recipes give byte-identical files and the
	// Kindle can tell from the ETag that nothing needs downloading
	return zipFiles(
		[
			{ name: "mimetype", data: ENCODER.encode("application/epub+zip"), stored: true },
			{ name: "META-INF/container.xml", data: ENCODER.encode(container) },
			{ name: "OEBPS/content.opf", data: ENCODER.encode(opf) },
			{ name: "OEBPS/toc.ncx", data: ENCODER.encode(ncx) },
			{ name: "OEBPS/nav.xhtml", data: ENCODER.encode(navDoc) },
			{ name: "OEBPS/style.css", data: ENCODER.encode(CSS) },
			...pages.map((p) => ({ name: `OEBPS/${p.file}`, data: ENCODER.encode(p.body) })),
			// PNG is already compressed
			{ name: "OEBPS/cover.png", data: COVER, stored: true },
		],
		modified,
	);
}
