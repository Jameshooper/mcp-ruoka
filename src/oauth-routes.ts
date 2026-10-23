import {
	createAuthCode,
	exchangeAuthCode,
	isKnownClientId,
	issueAccessToken,
	TooManyCodesError,
	validateClientCredentials,
	validateRefreshToken,
} from "./auth.ts";
import { logger } from "./logger.ts";
import { alert } from "./notify.ts";
import { allowedRedirects, FailureLimiter } from "./security.ts";

export const limiter = new FailureLimiter();

// Requests whose address could not be determined share one bucket
const addressKey = (ip: string | null) => ip ?? "unknown";

function recordFailure(ip: string | null): void {
	const key = addressKey(ip);
	limiter.record(key);
	if (limiter.blocked(key)) {
		alert(
			"sign-in-limit",
			"Ruoka: sign-in attempts blocked",
			"One address made too many failed sign-ins on the public endpoint. It is paused for 5 minutes; Claude keeps working.",
		);
	}
}

function tooMany(): Response {
	return Response.json(
		{ error: "temporarily_unavailable" },
		{ status: 429, headers: { "Retry-After": "300" } },
	);
}

export function authorizeResponse(url: URL, ip: string | null = null): Response {
	if (limiter.blocked(addressKey(ip))) return tooMany();
	const responseType = url.searchParams.get("response_type");
	const id = url.searchParams.get("client_id");
	const redirectUri = url.searchParams.get("redirect_uri");
	const state = url.searchParams.get("state");
	const codeChallenge = url.searchParams.get("code_challenge");
	const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";

	if (
		responseType !== "code" ||
		!id ||
		!redirectUri ||
		!codeChallenge ||
		codeChallengeMethod !== "S256"
	) {
		return Response.json({ error: "invalid_request" }, { status: 400 });
	}
	if (!isKnownClientId(id)) {
		recordFailure(ip);
		return Response.json({ error: "invalid_client" }, { status: 401 });
	}
	// A code may only be handed to Claude's own callback, never to an address the caller picks
	if (!allowedRedirects().includes(redirectUri)) {
		logger.warn({ redirectUri }, "Refused authorize request with an unlisted redirect_uri");
		return Response.json(
			{ error: "invalid_request", error_description: "redirect_uri not allowed" },
			{ status: 400 },
		);
	}

	let code: string;
	try {
		code = createAuthCode({ codeChallenge, codeChallengeMethod, redirectUri, clientId: id });
	} catch (error) {
		if (!(error instanceof TooManyCodesError)) throw error;
		return Response.json(
			{ error: "temporarily_unavailable" },
			{ status: 503, headers: { "Retry-After": "60" } },
		);
	}
	const redirect = new URL(redirectUri);
	redirect.searchParams.set("code", code);
	if (state) redirect.searchParams.set("state", state);
	return Response.redirect(redirect.toString(), 302);
}

// client_secret_post is what discovery advertises, but HTTP Basic is accepted too (RFC 6749 2.3.1)
function clientCredentials(
	params: URLSearchParams,
	authorization: string | null,
): { id: string | null; secret: string | null } {
	const basic = /^Basic\s+(.+)$/i.exec(authorization ?? "");
	if (basic?.[1]) {
		const decoded = Buffer.from(basic[1], "base64").toString("utf8");
		const colon = decoded.indexOf(":");
		if (colon > 0) {
			return {
				id: decodeURIComponent(decoded.slice(0, colon)),
				secret: decodeURIComponent(decoded.slice(colon + 1)),
			};
		}
	}
	return { id: params.get("client_id"), secret: params.get("client_secret") };
}

export interface TokenRequest {
	body: string;
	ip?: string | null;
	authorization?: string | null;
}

export function tokenResponse({ body, ip = null, authorization = null }: TokenRequest): Response {
	const params = new URLSearchParams(body);
	let client: { id: string | null; secret: string | null };
	try {
		client = clientCredentials(params, authorization);
	} catch {
		return Response.json({ error: "invalid_request" }, { status: 400 });
	}
	const authenticated =
		client.id !== null &&
		client.secret !== null &&
		validateClientCredentials(client.id, client.secret);
	const grant = params.get("grant_type");

	// Claude's background renewals come from addresses it shares with every other Claude user, so a
	// stranger's failures there must not stop them. A valid secret plus a valid refresh token cannot
	// be guessed, so those go through even when the address is paused.
	if (grant === "refresh_token" && authenticated) {
		const authTime = validateRefreshToken(params.get("refresh_token") ?? "");
		if (authTime === null) return Response.json({ error: "invalid_grant" }, { status: 400 });
		return Response.json(issueAccessToken(authTime));
	}

	if (limiter.blocked(addressKey(ip))) return tooMany();
	const invalidClient = () => {
		recordFailure(ip);
		return Response.json({ error: "invalid_client" }, { status: 401 });
	};

	switch (grant) {
		case "authorization_code": {
			const code = params.get("code");
			const codeVerifier = params.get("code_verifier");
			const redirectUri = params.get("redirect_uri");
			if (!code || !codeVerifier || !redirectUri || !client.id) {
				return Response.json({ error: "invalid_request" }, { status: 400 });
			}
			// PKCE alone is not enough: anyone who knows the (non-secret) client id could run the flow
			if (!authenticated) return invalidClient();

			const token = exchangeAuthCode({ code, codeVerifier, redirectUri, clientId: client.id });
			if (!token) {
				recordFailure(ip);
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			return Response.json(token);
		}

		case "client_credentials":
			if (!authenticated) return invalidClient();
			return Response.json(issueAccessToken());

		// Only reached without valid client credentials: a refresh token alone is not enough
		case "refresh_token":
			logger.warn("Refused a token refresh without valid client credentials");
			return invalidClient();

		default:
			return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
	}
}
