// Which food picture the dinner-menu display (the Xteink X4) shows for a dish. The names are the
// image ids in its ESPHome config without the "icon_" prefix. Deciding here instead of on the device
// means a new keyword is an app release rather than a reflash, and the meal's protein tag can fill
// in for names that don't say what is in them ("Thai green curry").

export type DishIcon =
	| "pizza"
	| "taco"
	| "burger"
	| "pot"
	| "pasta"
	| "noodles"
	| "fish"
	| "chicken"
	| "steak"
	| "egg"
	| "rice"
	| "veg"
	| "dinner";

type Rule = [DishIcon, string[]];

// What the dish is shaped like beats what is in it: salmon soup is a pot, chicken pizza a pizza
const SHAPES: Rule[] = [
	["pizza", ["pizza"]],
	["taco", ["taco", "burrito", "fajita", "quesadilla", "nacho"]],
	["burger", ["burger"]],
	[
		"pot",
		[
			"soup",
			"stew",
			"keitto",
			"chowder",
			"tagine",
			"chili",
			"chilli",
			"casserole",
			"goulash",
			"pata",
		],
	],
	[
		"pasta",
		[
			"pasta",
			"spaghetti",
			"lasagn",
			"penne",
			"macaroni",
			"gnocchi",
			"tagliatelle",
			"carbonara",
			"bolognese",
		],
	],
	["noodles", ["noodle", "ramen", "pad thai", "udon", "nuudeli"]],
];

const PROTEINS: Rule[] = [
	["fish", ["salmon", "fish", "cod", "tuna", "prawn", "shrimp", "lohi", "kala", "seafood"]],
	["chicken", ["chicken", "kana", "turkey", "wings"]],
	[
		"steak",
		["beef", "steak", "pork", "lamb", "mince", "meatball", "sausage", "liha", "nauta", "possu"],
	],
	["egg", ["egg", "omelet", "shakshuka", "frittata", "muna"]],
];

const PROTEIN_TAGS: Record<string, DishIcon> = {
	fish: "fish",
	white_meat: "chicken",
	red_meat: "steak",
	vegetarian: "veg",
};

const SIDES: Rule[] = [
	["rice", ["curry", "rice", "risotto", "stir-fry", "stir fry", "paella", "biryani", "riisi"]],
	[
		"veg",
		["salad", "vegetable", "veggie", "vegan", "chickpea", "lentil", "tofu", "halloumi", "falafel"],
	],
];

function match(rules: Rule[], name: string): DishIcon | undefined {
	return rules.find(([, words]) => words.some((w) => name.includes(w)))?.[0];
}

export function dishIcon(dish: string, protein?: string | null): DishIcon {
	const name = dish.toLowerCase();
	return (
		match(SHAPES, name) ??
		match(PROTEINS, name) ??
		(protein ? PROTEIN_TAGS[protein] : undefined) ??
		match(SIDES, name) ??
		"dinner"
	);
}
