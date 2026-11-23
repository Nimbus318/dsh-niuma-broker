const MAX_RENDER_UNITS = 20_000;
const MAX_DEPTH = 64;
const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/** Check before parsing: deeply nested HTML can exhaust parsers and multiply Markdown indentation. */
export function assertRichTextComplexity(html: string): void {
	if (html.length > 200_000) throw new Error("Rich text is too large to render.");
	const ancestors: string[] = [];
	let tags = 0;
	for (const match of html.matchAll(/<(\/?)([a-z][a-z\d-]*)\b[^<>]*>/gi)) {
		if (++tags > MAX_RENDER_UNITS) throw new Error("Rich text has too many elements to render.");
		const tag = (match[2] ?? "").toLowerCase();
		if (match[1]) {
			const index = ancestors.lastIndexOf(tag);
			if (index !== -1) ancestors.length = index;
		} else if (!VOID_TAGS.has(tag) && !match[0].endsWith("/>")) {
			ancestors.push(tag);
			if (ancestors.length > MAX_DEPTH) throw new Error("Rich text is nested too deeply to render.");
		}
	}
}
