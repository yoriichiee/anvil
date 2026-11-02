// Placeholder used only when ../api/index.mjs does not exist at synth time (W6 owns the real API).
// Answers every /api/* request with 503 so the site degrades honestly instead of 502-ing.
export const handler = async (event) => ({
  statusCode: 503,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify({
    error: 'api_not_deployed',
    message: 'The hosted Anvil API is not live yet. Local mode works without it: anvil scan <url|dir|zip>.',
    path: event && event.rawPath ? String(event.rawPath).slice(0, 200) : undefined,
  }),
});
