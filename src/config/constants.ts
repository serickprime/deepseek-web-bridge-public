export const DEEPSEEK_BASE_URL = "https://chat.deepseek.com";
export const COMPLETION_PATH = "/api/v0/chat/completion";
export const CHALLENGE_PATH = "/api/v0/chat/create_pow_challenge";
export const SESSION_CREATE_PATH = "/api/v0/chat_session/create";
export const DEFAULT_POW_WASM_URL =
  "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";

export const DEFAULT_BASE_URL = DEEPSEEK_BASE_URL;

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 9655;

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

export const MIN_PROXY_API_KEY_LENGTH = 24;
export const SETUP_TOKEN_LENGTH = 32;

export const CLIENT_HEADERS: Record<string, string> = {
  "x-app-version": "20241129.1",
  "x-client-version": "2.3.0",
  "x-client-platform": "web",
  "x-client-locale": "en",
  "x-client-timezone-offset": "0",
  "x-client-bundle-id": "com.deepseek.chat",
};

export const UPSTREAM_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export const BROWSER_HEADERS: Record<string, string> = {
  "origin": "https://chat.deepseek.com",
  "referer": "https://chat.deepseek.com/",
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

export const LOOPBACK_ORIGINS = new Set([
  "http://127.0.0.1",
  "http://localhost",
  "http://[::1]",
]);

export const REQUEST_REF_LENGTH = 8;
export const SESSION_ID_ENTROPY_BYTES = 16;
export const MAX_UPSTREAM_RETRIES = 2;
export const SESSION_LINK_TTL_MS = 10 * 60 * 1000;
export const SESSION_LINK_MAX = 512;
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_MAX_HISTORY = 24;
export const SESSION_MAX_CHARS = 60_000;
export const SESSION_MAX_ENTRIES = 512;
export const SESSION_CREATE_INTERVAL_MS = 2_000;
