import {
	createAuthCode,
	exchangeAuthCode,
	isKnownClientId,
	issueAccessToken,
	validateClientCredentials,
	validateRefreshToken,
} from "./auth.ts";
import { logger } from "./logger.ts";
import { allowedRedirects, FailureLimiter } from "./security.ts";

export const limiter = new FailureLimiter();

function tooMany(): Response {
	return Response.json(
		{ error: "temporarily_unavailable" },
		{ status: 429, headers: { "Retry-After": "300" } },
	);
}

export function authorizeResponse(url: URL): Response {
	if (limiter.blocked()) return tooMany();
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
		limiter.record();
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

	const code = createAuthCode({ codeChallenge, codeChallengeMethod, redirectUri, clientId: id });
	const redirect = new URL(redirectUri);
	redirect.searchParams.set("code", code);
	if (state) redirect.searchParams.set("state", state);
	return Response.redirect(redirect.toString(), 302);
}

export function tokenResponse(bodyText: string): Response {
	if (limiter.blocked()) return tooMany();
	const params = new URLSearchParams(bodyText);
	const invalidClient = () => {
		limiter.record();
		return Response.json({ error: "invalid_client" }, { status: 401 });
	};

	switch (params.get("grant_type")) {
		case "authorization_code": {
			const code = params.get("code");
			const codeVerifier = params.get("code_verifier");
			const redirectUri = params.get("redirect_uri");
			const id = params.get("client_id");
			const secret = params.get("client_secret");
			if (!code || !codeVerifier || !redirectUri || !id) {
				return Response.json({ error: "invalid_request" }, { status: 400 });
			}
			// PKCE alone is not enough: anyone who knows the (non-secret) client id could run the flow
			if (!secret || !validateClientCredentials(id, secret)) return invalidClient();

			const token = exchangeAuthCode({ code, codeVerifier, redirectUri, clientId: id });
			if (!token) {
				limiter.record();
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			return Response.json(token);
		}

		case "client_credentials": {
			const id = params.get("client_id");
			const secret = params.get("client_secret");
			if (!id || !secret || !validateClientCredentials(id, secret)) return invalidClient();
			return Response.json(issueAccessToken());
		}

		case "refresh_token": {
			const refreshToken = params.get("refresh_token");
			if (!refreshToken || !validateRefreshToken(refreshToken)) {
				limiter.record();
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			return Response.json(issueAccessToken());
		}

		default:
			return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
	}
}
