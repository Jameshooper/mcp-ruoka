export type Chain = "k-ruoka" | "s-kaupat" | "alko";

export interface ProductLocation {
	aisle: string | null;
	floor: number | null;
}

export interface AllergenFlag {
	term: string;
	source: "declared allergens" | "ingredients";
	text: string;
	level: string | null;
	// "may_contain": a precautionary trace statement, not an ingredient
	kind: "contains" | "may_contain";
}

export interface AllergenCheck {
	status: "flagged" | "no_match" | "unknown" | "pending";
	flags: AllergenFlag[];
}

export type LocationStatus = "found" | "none" | "unknown" | "pending";

export interface Product {
	name: string;
	price: number | null;
	unitPrice: string | null;
	id: string;
	imageUrl: string | null;
	brand: string | null;
	category: string | null;
	abv?: number | null;
	url?: string | null;
	location?: ProductLocation | null;
	locationStatus?: LocationStatus;
	allergenCheck?: AllergenCheck;
}

export interface Store {
	id: string;
	name: string;
	chain: Chain;
	location: string;
}

export interface SearchResult {
	products: Product[];
	totalCount: number;
	query: string;
	storeId: string | null;
	chain: Chain;
}
