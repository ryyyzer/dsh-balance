// dsh-balance — host half.
//
// Routes:
//   GET    /api/balance            official remaining balance (api.deepseek.com)
//   GET    /api/balance/today      today's per-model consumption (platform data)
//   GET    /dsh-balance/status     hasKey / hasToken / token source / refreshSec
//   PUT    /dsh-balance/token      save the platform userToken into the local
//                                  credentials store (loopback + same-origin)
//   DELETE /dsh-balance/token      clear it
//   PUT    /dsh-balance/refresh    save the balance auto-refresh interval (sec)
//   DELETE /dsh-balance/refresh    clear it (client falls back to 60 s)
// Token and refresh interval live together in the same local credentials store.
//
// The "today" + token routes follow the community usage-plugin approach: the
// platform web console (platform.deepseek.com/usage) is driven by private
// endpoints authenticated with the logged-in session's userToken (browser
// localStorage "userToken"), NOT the API key. When the credential
// DEEPSEEK_USER_TOKEN is configured we query
//   platform.deepseek.com/api/v0/usage/export?start=..&end=..&tz=0
// over the Beijing "today" window and aggregate CSV rows per model. All keys
// stay in the host process / local credential store.
//
// Loader row (id "balance") comes from this package's own cordis.patch.yml

import { inflateRawSync } from "node:zlib";

const name = "balance";
const inject = ["connection", "credentials", "webServer"];

const API_KEY_REF = "DEEPSEEK_API_KEY";
const USER_TOKEN_REF = "DEEPSEEK_USER_TOKEN";
const USER_TOKEN_REFS = [USER_TOKEN_REF, "DEEPSEEK_PLATFORM_TOKEN"];
const REFRESH_SEC_REF = "DEEPSEEK_BALANCE_REFRESH_SEC";
const REFRESH_MIN_SEC = 1;
const REFRESH_MAX_SEC = 86400;
const BALANCE_UPSTREAM = "https://api.deepseek.com/user/balance";
const EXPORT_URL = "https://platform.deepseek.com/api/v0/usage/export";
const PLATFORM_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REFERER = "https://platform.deepseek.com/usage";
const TIMEOUT_MS = 15_000;
const BALANCE_CACHE_TTL_MS = 8_000;
const TODAY_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 8192;

const json = (value, status = 200) => new Response(JSON.stringify(value), {
	status,
	headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

// ---------------------------------------------------------------------------
// cached fetcher (TTL + singleflight + stale fallback + clear)
// ---------------------------------------------------------------------------
function createCached(fetcher, ttlMs) {
	let cache = null;
	let inflight = null;
	function run() {
		const now = Date.now();
		if (cache !== null && now - cache.at < ttlMs) return Promise.resolve({ payload: cache.payload, cached: true, stale: false });
		if (inflight !== null) return inflight;
		inflight = (async () => {
			try {
				const payload = await fetcher();
				cache = { payload, at: Date.now() };
				return { payload, cached: false, stale: false };
			} catch (error) {
				if (cache !== null) return { payload: cache.payload, cached: true, stale: true, staleError: error?.message ?? String(error) };
				throw error;
			} finally {
				inflight = null;
			}
		})();
		return inflight;
	}
	function clear() { cache = null; }
	return { run, clear };
}

// ---------------------------------------------------------------------------
// official balance
// ---------------------------------------------------------------------------
const balanceCache = { at: 0, payload: null, inflight: null };
async function fetchOfficialBalance(apiKey, signal) {
	const now = Date.now();
	if (balanceCache.payload !== null && now - balanceCache.at < BALANCE_CACHE_TTL_MS) return balanceCache.payload;
	if (balanceCache.inflight !== null) return balanceCache.inflight;
	const inflight = (async () => {
		const upstream = await fetch(BALANCE_UPSTREAM, {
			method: "GET",
			headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal
		});
		const text = await upstream.text();
		let parsed = null;
		try { parsed = JSON.parse(text); } catch { /* below */ }
		if (!upstream.ok || parsed === null) throw new Error(`upstream HTTP ${upstream.status}`);
		const infos = Array.isArray(parsed.balance_infos) ? parsed.balance_infos : [];
		const sums = new Map();
		for (const info of infos) {
			const currency = typeof info.currency === "string" ? info.currency : "?";
			const entry = sums.get(currency) ?? { total: 0, granted: 0, toppedUp: 0 };
			entry.total += Number(info.total_balance ?? 0);
			entry.granted += Number(info.granted_balance ?? 0);
			entry.toppedUp += Number(info.topped_up_balance ?? 0);
			sums.set(currency, entry);
		}
		const payload = {
			ok: true,
			isAvailable: parsed.is_available !== false,
			balances: Array.from(sums, ([currency, v]) => ({ currency, total: v.total, granted: v.granted, toppedUp: v.toppedUp })),
			fetchedAt: new Date().toISOString()
		};
		balanceCache.at = Date.now();
		balanceCache.payload = payload;
		return payload;
	})();
	balanceCache.inflight = inflight;
	try { return await inflight; } finally { if (balanceCache.inflight === inflight) balanceCache.inflight = null; }
}

// ---------------------------------------------------------------------------
// platform usage export (Beijing "today" window), per-model aggregation
// ---------------------------------------------------------------------------

/** Beijing wall-clock date parts via Intl (no external deps). */
function beijingParts(date = new Date()) {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
	const part = (type) => parts.find((p) => p.type === type)?.value;
	return { y: Number(part("year")), m: Number(part("month")), d: Number(part("day")) };
}

/** Epoch seconds of Beijing midnight for "today". */
function beijingTodayStartSec(now = new Date()) {
	const { y, m, d } = beijingParts(now);
	return Math.floor((Date.UTC(y, m - 1, d) - 8 * 3600e3) / 1000);
}

function parseCsv(text) {
	const lines = String(text).replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
	if (lines.length < 2) return [];
	const headers = lines[0].split(",").map((h) => h.trim());
	const rows = [];
	for (let i = 1; i < lines.length; i++) {
		const fields = [];
		let cur = "";
		let quoted = false;
		const line = lines[i];
		for (let j = 0; j < line.length; j++) {
			const ch = line[j];
			if (quoted) {
				if (ch === '"' && line[j + 1] === '"') { cur += '"'; j++; }
				else if (ch === '"') quoted = false;
				else cur += ch;
			} else if (ch === '"') quoted = true;
			else if (ch === ",") { fields.push(cur); cur = ""; }
			else cur += ch;
		}
		fields.push(cur);
		if (fields.length !== headers.length) continue;
		const row = {};
		headers.forEach((h, idx) => { row[h] = fields[idx]; });
		rows.push(row);
	}
	return rows;
}

/** Minimal zip reader: decoded text of the first entry whose name contains `needle`. */
function zipEntryText(buffer, needle) {
	const bytes = new Uint8Array(buffer);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= 0; i--) {
		if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
	}
	if (eocd < 0) throw new Error("平台响应不是有效的 ZIP（token 可能失效、过期或接口被拦截）");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint16(eocd + 10, true);
	const dirStart = view.getUint32(eocd + 16, true);
	let off = dirStart;
	for (let n = 0; n < count; n++) {
		if (off + 46 > bytes.length || view.getUint32(off, true) !== 0x02014b50) throw new Error(`zip: bad central directory @${off}/${bytes.length}`);
		const method = view.getUint16(off + 10, true);
		const compSize = view.getUint32(off + 20, true);
		const nameLen = view.getUint16(off + 28, true);
		const extraLen = view.getUint16(off + 30, true);
		const commentLen = view.getUint16(off + 32, true);
		const localOff = view.getUint32(off + 42, true);
		const entryName = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
		off += 46 + nameLen + extraLen + commentLen;
		if (!entryName.toLowerCase().endsWith(".csv") || !entryName.toLowerCase().includes(needle)) continue;
		const lhNameLen = view.getUint16(localOff + 26, true);
		const lhExtraLen = view.getUint16(localOff + 28, true);
		const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
		if (dataStart + compSize > bytes.length) throw new Error("zip: entry out of bounds");
		const compressed = bytes.subarray(dataStart, dataStart + compSize);
		const raw = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
		if (raw === null) throw new Error(`zip: unsupported compression ${method}`);
		if (raw.byteLength > MAX_BUFFER_BYTES) throw new Error("zip: entry too large");
		return new TextDecoder().decode(raw);
	}
	return null;
}

const toNum = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : 0; };

function modelKey(raw) {
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (s === "") return null;
	if (/vision/i.test(s)) return "deepseek-v4-flash-vision-exp";
	if (/v4[\s_-]?pro/i.test(s)) return "deepseek-v4-pro";
	if (/v4[\s_-]?flash/i.test(s)) return "deepseek-v4-flash";
	if (/v4/i.test(s) && !/pro/i.test(s)) return "deepseek-v4-flash";
	return s; // unknown id, kept under its own key
}

/** Fetch platform export for the Beijing "today" window and aggregate per model. */
async function fetchTodayUsage(token, signal) {
	const now = new Date();
	const start = beijingTodayStartSec(now);
	const end = Math.max(Math.ceil(Date.now() / 3600e3) * 3600, start + 3600);
	const url = `${EXPORT_URL}?start=${start}&end=${end}&tz=0`;
	const res = await fetch(url, {
		headers: { authorization: `Bearer ${token}`, accept: "application/octet-stream", "user-agent": PLATFORM_UA, referer: REFERER },
		signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal ?? AbortSignal.timeout(TIMEOUT_MS)])
	});
	if (res.status === 401 || res.status === 403) throw new Error("platform token invalid");
	if (!res.ok) {
		let detail = "";
		try { detail = ` (${(await res.text()).slice(0, 200)})`; } catch { /* ignore */ }
		throw new Error(`platform HTTP ${res.status}${detail}`);
	}
	const buffer = Buffer.from(await res.arrayBuffer());
	if (buffer.length > MAX_BUFFER_BYTES) throw new Error("export too large");

	const amountCsv = zipEntryText(buffer, "amount");
	const costCsv = zipEntryText(buffer, "cost");
	if (amountCsv === null && costCsv === null) throw new Error("export zip has no csv");

	const models = new Map();
	const seed = (key) => {
		let row = models.get(key);
		if (row === void 0) {
			row = { model: key, tokens: 0, cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, cost: 0 };
			models.set(key, row);
		}
		return row;
	};
	if (amountCsv !== null) {
		for (const row of parseCsv(amountCsv)) {
			const type = row.type || "";
			const amount = toNum(row.amount);
			const key = modelKey(row.model);
			if (key === null) continue;
			const rec = seed(key);
			if (type === "request_count") rec.requests += amount;
			else if (type === "input_cache_hit_tokens") { rec.cacheHit += amount; rec.tokens += amount; }
			else if (type === "input_cache_miss_tokens") { rec.cacheMiss += amount; rec.tokens += amount; }
			else if (type === "output_tokens") { rec.output += amount; rec.tokens += amount; }
		}
	}
	if (costCsv !== null) {
		for (const row of parseCsv(costCsv)) {
			const key = modelKey(row.model);
			if (key === null) continue;
			seed(key).cost += toNum(row.cost);
		}
	} else if (amountCsv !== null) {
		// no cost csv: price × amount is the platform's own charge basis
		for (const row of parseCsv(amountCsv)) {
			const type = row.type || "";
			if (type === "request_count") continue;
			const key = modelKey(row.model);
			if (key === null) continue;
			models.get(key).cost += toNum(row.price) * toNum(row.amount);
		}
	}

	const ordered = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];
	const list = [];
	const others = [];
	for (const [key, rec] of models) {
		if (ordered.includes(key)) list.push(rec);
		else others.push(rec);
	}
	list.sort((a, b) => ordered.indexOf(a.model) - ordered.indexOf(b.model));

	return {
		ok: true,
		source: "export",
		currency: "CNY",
		models: list,
		otherModels: others,
		totalCost: Array.from(models.values()).reduce((s, r) => s + r.cost, 0),
		window: { start, end },
		fetchedAt: new Date().toISOString()
	};
}

// ---------------------------------------------------------------------------
// plugin body
// ---------------------------------------------------------------------------
function apply(ctx) {
	const connection = Reflect.get(ctx, "connection");
	const credentials = Reflect.get(ctx, "credentials");
	const webServer = Reflect.get(ctx, "webServer");
	if (connection === void 0 || connection.fetch === void 0 || webServer === void 0) return;

	const resolveRef = async (ref) => {
		if (credentials !== void 0 && typeof credentials.resolve === "function") {
			try {
				const hit = await credentials.resolve(ref);
				if (hit !== void 0 && typeof hit.value === "string" && hit.value.length > 0) {
					return { value: hit.value, source: typeof hit.source === "string" ? hit.source : "file" };
				}
			} catch { /* env fallback below */ }
		}
		const envValue = typeof process !== "undefined" ? process.env[ref] : void 0;
		return typeof envValue === "string" && envValue.length > 0 ? { value: envValue, source: "env" } : null;
	};
	const resolveApiKey = async () => {
		const hit = await resolveRef(API_KEY_REF);
		return hit;
	};
	/** userToken may be a plain string or a JSON object {"value":"..."} (browser localStorage shape). */
	const normalizeToken = (raw) => {
		if (typeof raw !== "string") return null;
		const trimmed = raw.trim();
		if (trimmed === "") return null;
		if (trimmed.startsWith("{")) {
			try {
				const parsed = JSON.parse(trimmed);
				if (parsed !== null && typeof parsed === "object" && typeof parsed.value === "string" && parsed.value !== "") return parsed.value.trim();
			} catch { /* not json, use raw */ }
		}
		return trimmed;
	};
	const resolveToken = async () => {
		for (const ref of USER_TOKEN_REFS) {
			const hit = await resolveRef(ref);
			if (hit === null) continue;
			const token = normalizeToken(hit.value);
			if (token !== null) return { token, source: hit.source };
		}
		return null;
	};
	/** Stored auto-refresh interval in seconds (null = use client default 60). */
	const resolveRefreshSec = async () => {
		const hit = await resolveRef(REFRESH_SEC_REF);
		if (hit === null) return null;
		const n = Number.parseInt(hit.value, 10);
		if (!Number.isInteger(n) || n < REFRESH_MIN_SEC || n > REFRESH_MAX_SEC) return null;
		return { sec: n, source: hit.source };
	};


	const todayFetcher = createCached(async () => {
		const resolved = await resolveToken();
		if (resolved === null) throw Object.assign(new Error("missing DEEPSEEK_USER_TOKEN"), { code: "missing_token" });
		return fetchTodayUsage(resolved.token, void 0);
	}, TODAY_CACHE_TTL_MS);

	// ---- /api GET routes (browser session auth via the /api bridge) ----
	connection.fetch.register({
		path: "/api/balance",
		methods: ["GET"],
		fetch: async (request) => {
			const apiKey = await resolveApiKey();
			if (apiKey === null) return json({ ok: false, code: "missing_key", error: `missing ${API_KEY_REF}` }, 502);
			try {
				const payload = await fetchOfficialBalance(apiKey.value, request.signal);
				return json(payload);
			} catch (error) {
				return json({ ok: false, code: "balance_error", error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	});
	connection.fetch.register({
		path: "/api/balance/today",
		methods: ["GET"],
		fetch: async () => {
			try {
				const result = await todayFetcher.run();
				return json({ ok: true, cached: result.cached, stale: !!result.stale, ...result.payload });
			} catch (error) {
				const code = typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : "usage_error";
				const message = error instanceof Error ? error.message : String(error);
				return json({ ok: false, code, error: message, cached: false, stale: false }, code === "missing_token" ? 200 : 502);
			}
		}
	});

	// ---- token management routes (plain webserver; loopback + same-origin) ----
	const isLoopbackSocket = (req) => {
		const addr = req.socket?.remoteAddress;
		return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
	};
	const isLocalHost = (req) => {
		const host = typeof req.headers?.host === "string" ? req.headers.host : "";
		if (host === "") return false;
		try {
			const hostname = new URL(`http://${host}`).hostname;
			return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
		} catch {
			return false;
		}
	};
	const sameOrigin = (req) => {
		const origin = req.headers?.origin;
		if (typeof origin !== "string" || origin === "") return false;
		try { return new URL(origin).host === req.headers.host; } catch { return false; }
	};
	const guard = (req, res, method, requireOrigin) => {
		if (!isLoopbackSocket(req) || !isLocalHost(req) || (requireOrigin && !sameOrigin(req)) || req.headers["sec-fetch-site"] === "cross-site") {
			sendJson(res, 403, { ok: false, code: "forbidden", message: "forbidden" });
			return false;
		}
		if (req.method !== method) {
			sendJson(res, 405, { ok: false, code: "method_not_allowed", message: "method not allowed" });
			return false;
		}
		return true;
	};
	const sendJson = (res, status, body) => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};
	const readBodyJson = async (req) => {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) return null;
			chunks.push(chunk);
		}
		try {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	};

	const webRoutes = [
		{
			kind: "exact",
			path: "/dsh-balance/status",
			handler: async (req, res) => {
				if (!guard(req, res, "GET", false)) return;
				const [apiKey, token, refresh] = await Promise.all([resolveApiKey(), resolveToken(), resolveRefreshSec()]);
				sendJson(res, 200, { ok: true, hasKey: apiKey !== null, hasToken: token !== null, tokenSource: token?.source ?? null, refreshSec: refresh?.sec ?? null, refreshSource: refresh?.source ?? null });
			}
		},
		{
			kind: "exact",
			path: "/dsh-balance/token",
			handler: async (req, res) => {
				if (req.method === "PUT") {
					if (!guard(req, res, "PUT", true)) return;
					const body = await readBodyJson(req);
					const raw = typeof body?.token === "string" ? body.token : "";
					const token = normalizeToken(raw);
					if (token === null || token.length > MAX_TOKEN_LENGTH) {
						sendJson(res, 400, { ok: false, code: "invalid_token", message: "token 不能为空或过长" });
						return;
					}
					try {
						await credentials.set(USER_TOKEN_REF, token);
						todayFetcher.clear();
						const resolved = await resolveToken();
						sendJson(res, 200, { ok: true, hasToken: resolved !== null, tokenSource: resolved?.source ?? null });
					} catch (error) {
						sendJson(res, 502, { ok: false, code: "save_failed", message: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (req.method === "DELETE") {
					if (!guard(req, res, "DELETE", true)) return;
					try {
						if (credentials.unset !== void 0) await credentials.unset(USER_TOKEN_REF);
						todayFetcher.clear();
						sendJson(res, 200, { ok: true, hasToken: false });
					} catch (error) {
						sendJson(res, 502, { ok: false, code: "clear_failed", message: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				sendJson(res, 405, { ok: false, code: "method_not_allowed", message: "method not allowed" });
			}
		},
		{
			kind: "exact",
			path: "/dsh-balance/refresh",
			handler: async (req, res) => {
				if (req.method === "PUT") {
					if (!guard(req, res, "PUT", true)) return;
					const body = await readBodyJson(req);
					const raw = typeof body?.sec === "number" ? body.sec : Number(body?.sec);
					const n = Math.round(raw);
					if (!Number.isInteger(n) || n < REFRESH_MIN_SEC || n > REFRESH_MAX_SEC) {
						sendJson(res, 400, { ok: false, code: "invalid_interval", message: "刷新间隔需为 1–86400 之间的整数（秒）" });
						return;
					}
					try {
						await credentials.set(REFRESH_SEC_REF, String(n));
						sendJson(res, 200, { ok: true, refreshSec: n, refreshSource: "file" });
					} catch (error) {
						sendJson(res, 502, { ok: false, code: "save_failed", message: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (req.method === "DELETE") {
					if (!guard(req, res, "DELETE", true)) return;
					try {
						if (credentials.unset !== void 0) await credentials.unset(REFRESH_SEC_REF);
						sendJson(res, 200, { ok: true, refreshSec: null });
					} catch (error) {
						sendJson(res, 502, { ok: false, code: "clear_failed", message: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				sendJson(res, 405, { ok: false, code: "method_not_allowed", message: "method not allowed" });
			}
		},

	];
	ctx.effect(() => {
		const disposers = webRoutes.map((route) => webServer.register(route));
		return () => { for (const disposer of disposers) disposer(); };
	}, "balance: token routes");
}

export { apply, inject, name };
