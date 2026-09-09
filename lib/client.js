// dsh-balance — client half (hand-authored; no build step).
//
// Sidebar footer chip ("sidebar.footer.action", bottom-left of the wide
// sidebar, above the Settings row) + click popup:
//
//   · 3 rows — today's official per-model consumption (platform console data
//     via host /api/balance/today; needs DEEPSEEK_USER_TOKEN configured)
//   · 1 row  — 上次校准 time (of the official balance /api/balance)
//   · 1 row  — 充值 button (opens https://platform.deepseek.com/usage)
//
// Update policy (simple, state-independent): the chip always shows the latest
// OFFICIAL balance. Auto calibration fires:
//   · once on load;
//   · every N seconds while the page is alive (N = 刷新间隔 in 设置 → 余额配置, default 60 s);
//   · on returning to foreground/visibility when the last update was ≥N s ago
//     (background timers may be throttled, so this is the catch-up);
//   · on opening the popup (if the last update was >20 s ago) and on 刷新数据.
// The official balance endpoint is free and never spends model credits, so
// recalibration has no token cost. No local token estimation is used — the
// number is always the calibrated official value.
//
// Bundle format follows shipped client bundles:
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
// Requires only platform static modules (react, react/jsx-runtime, react-dom).
window.__ModuleLoader__.load({
	id: "dsh-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
		//#region css
		const css = `
.dsb-chip{min-width:0;box-sizing:border-box;width:100%;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:6px;padding:6px 8px;display:flex;text-align:left}
.dsb-chip:hover,.dsb-chip[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsb-chip[data-warn=true] .dsb-amount{color:#d97706}
.dsb-label{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none}
.dsb-amount{font-weight:600;text-overflow:ellipsis;min-width:0;overflow:hidden;white-space:nowrap}
.dsb-state{margin-left:auto;align-items:center;display:inline-flex;flex:none}
.dsb-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.dsb-dot[data-ok=true]{background:#16a34a}
.dsb-dot[data-err=true]{background:#d97706}
.dsb-chip[disabled] .dsb-dot{animation:dsbPulse 1.2s ease-in-out infinite}
@keyframes dsbPulse{0%,100%{opacity:.35}50%{opacity:1}}
.dsb-pop{z-index:1200;box-sizing:border-box;width:min(320px,calc(100vw - 16px));background:var(--dsw-specific-menu,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));font-size:12px;line-height:18px;padding:10px 12px}
.dsb-pop-head{justify-content:space-between;align-items:center;gap:8px;display:flex;margin-bottom:6px}
.dsb-pop-title{font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
.dsb-pop-close{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:6px;padding:2px 6px;font-size:12px;line-height:16px}
.dsb-pop-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsb-pop-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:2px 0 4px}
.dsb-mrow{justify-content:space-between;align-items:center;gap:8px;display:flex;min-height:24px}
.dsb-mrow-name{color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.dsb-mrow-name small{display:block;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:10px;line-height:13px;font-variant-numeric:tabular-nums}
.dsb-mrow-amt{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.dsb-divider{border-top:.5px solid var(--dsw-alias-border-l2);margin:6px 0}
.dsb-cal-row{color:var(--dsw-alias-label-tertiary);justify-content:space-between;display:flex;gap:8px}
.dsb-cal-row b{color:var(--dsw-alias-label-secondary);font-weight:500;font-variant-numeric:tabular-nums}
.dsb-foot{justify-content:flex-end;align-items:center;gap:8px;display:flex;margin-top:8px}
.dsb-btn{box-sizing:border-box;cursor:pointer;font-size:12px;line-height:16px;border-radius:7px;border:none;padding:4px 10px;background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-primary)}
.dsb-btn:hover{opacity:.85}
.dsb-btn-primary{background:var(--dsw-alias-state-warn-tertiary,#4f46e5);color:var(--dsw-alias-state-warn-label,#fff)}
.dsb-err{color:#d97706;font-size:11px;line-height:16px}
@media (prefers-reduced-motion:no-preference){.dsb-chip,.dsb-pop,.dsb-btn{transition:background .12s ease,color .12s ease,opacity .12s ease}}
`;
		const tagId = "dsh-balance/chip.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		const LOW_BALANCE_THRESHOLD = 10;
		const RECHARGE_URL = "https://platform.deepseek.com/usage";

		// Official-balance auto-calibration interval (seconds), user-configurable via
		// 设置 → 余额配置 → 刷新间隔 (presets 30/60/120 s, or custom 1–86400 s).
		// Persisted server-side in the local credentials store, next to the token
		// (~/.dsh), so it survives restarts and port changes. The chip starts at the
		// 60 s default and applies the stored value once /dsh-balance/status responds.
		const REFRESH_DEFAULT_SEC = 60;
		const REFRESH_MIN_SEC = 1;
		const REFRESH_MAX_SEC = 86400;
		const REFRESH_PRESETS_SEC = [30, 60, 120];
		const clampRefreshSec = (value) => {
			const n = Math.round(Number(value));
			if (!Number.isFinite(n) || n < REFRESH_MIN_SEC || n > REFRESH_MAX_SEC) return null;
			return n;
		};
		const clampRefreshMs = (ms) => {
			const sec = clampRefreshSec(Number(ms) / 1000);
			return sec === null ? null : sec * 1000;
		};
		let refreshMsCache = REFRESH_DEFAULT_SEC * 1000;
		const refreshMsListeners = new Set();
		const getRefreshMs = () => refreshMsCache;
		const applyRefreshMs = (ms) => {
			const next = clampRefreshMs(ms);
			if (next === null || next === refreshMsCache) return refreshMsCache;
			refreshMsCache = next;
			for (const fn of refreshMsListeners) fn(next);
			return next;
		};
		const onRefreshMsChange = (fn) => {
			refreshMsListeners.add(fn);
			return () => { refreshMsListeners.delete(fn); };
		};
		/** Persist the interval next to the token (server-side); applies locally on success. */
		const saveRefreshSec = async (sec) => {
			const valid = clampRefreshSec(sec);
			if (valid === null) return { ok: false, error: "无效间隔" };
			try {
				const response = await fetch("/dsh-balance/refresh", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sec: valid })
				});
				let body = null;
				try { body = await response.json(); } catch { /* below */ }
				if (body === null || body.ok !== true) return { ok: false, error: body?.message ?? `HTTP ${response.status}` };
				applyRefreshMs(valid * 1000);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		};

		const MODEL_ORDER = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];

		const fmtMoney = (value) => {
			if (!Number.isFinite(value)) return "—";
			if (value !== 0 && Math.abs(value) < 0.01) return `¥${value.toFixed(4)}`;
			if (Math.abs(value) >= 1000) return `¥${value.toFixed(0)}`;
			return `¥${value.toFixed(2)}`;
		};
		const fmtTokens = (value) => {
			const n = Number(value) || 0;
			if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
			if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
			return String(Math.round(n));
		};
		const pad = (n) => (n < 10 ? `0${n}` : String(n));
		/** Local (machine = Beijing) "09月09日 11:24". */
		const fmtCalibrated = (iso) => {
			if (typeof iso !== "string") return "—";
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return "—";
			return `${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		};

		async function readJson(path) {
			try {
				const response = await fetch(path, { method: "GET", cache: "no-store", headers: { accept: "application/json" } });
				let body = null;
				try { body = await response.json(); } catch { /* non-JSON */ }
				if (!response.ok || body === null) return { ok: false, error: body?.error ?? body?.message ?? `HTTP ${response.status}`, code: body?.code };
				if (body.ok !== true) return { ok: false, error: body.error ?? body.message ?? "unexpected response", code: body.code };
				return { ok: true, value: body };
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		}
		const readBalance = () => readJson("/api/balance");
		const readToday = () => readJson("/api/balance/today");
		const readStatus = () => readJson("/dsh-balance/status");
		const saveToken = (token) => fetch("/dsh-balance/token", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token })
		}).then((r) => r.json()).then((body) => body ?? { ok: false, message: "HTTP 无响应" })
			.catch((error) => ({ ok: false, message: String(error) }));
		const clearToken = () => fetch("/dsh-balance/token", { method: "DELETE" })
			.then((r) => r.json()).then((body) => body ?? { ok: false, message: "HTTP 无响应" })
			.catch((error) => ({ ok: false, message: String(error) }));
		/** Load the server-stored refresh interval; stays at the 60 s default when unset. */
		async function loadServerRefresh() {
			try {
				const result = await readStatus();
				if (result.ok && result.value?.refreshSec != null) {
					const sec = clampRefreshSec(result.value.refreshSec);
					if (sec !== null) applyRefreshMs(sec * 1000);
				}
			} catch { /* keep default */ }
		}
		loadServerRefresh();
		

		/** Model row view. */
		function modelRow(model, rec) {
			const tokens = rec === null ? 0 : Number(rec.tokens) || 0;
			return {
				key: model,
				name: model,
				sub: rec === null ? null : `${fmtTokens(tokens)} tokens`,
				amount: rec === null ? "—" : fmtMoney(Number(rec.cost) || 0)
			};
		}

		/** Balance chip + popup. */
		function BalanceChip() {
			const [balanceState, setBalanceState] = react.useState({ status: "loading", value: null, error: null, fetchedAt: null });
			const [todayState, setTodayState] = react.useState({ status: "idle", data: null, error: null });
			const [open, setOpen] = react.useState(false);
			const [rect, setRect] = react.useState(null);
			const chipRef = react.useRef(null);
			const lastCalibrateRef = react.useRef(0);
			const todayLoadedAtRef = react.useRef(0);
			const [refreshMs, setRefreshMsState] = react.useState(getRefreshMs);
			react.useEffect(() => onRefreshMsChange(setRefreshMsState), []);
			const openRef = react.useRef(false);

			const calibrate = react.useCallback(async () => {
				lastCalibrateRef.current = Date.now();
				setBalanceState((prev) => (prev.value === null ? { status: "loading", value: null, error: null, fetchedAt: null } : { ...prev, status: "refreshing" }));
				const result = await readBalance();
				setBalanceState((prev) => (result.ok
					? { status: "ready", value: result.value, error: null, fetchedAt: new Date().toISOString() }
					: { status: "error", value: null, error: result.error, fetchedAt: prev.fetchedAt }));
			}, []);

			const loadToday = react.useCallback(async (force = false) => {
				if (!force && Date.now() - todayLoadedAtRef.current < 45_000 && todayState.data !== null) return;
				todayLoadedAtRef.current = Date.now();
				setTodayState((prev) => (prev.data === null ? { status: "loading", data: null, error: null } : { ...prev, status: "refreshing" }));
				const result = await readToday();
				setTodayState((prev) => (result.ok
					? { status: "ready", data: result.value, error: null }
					: { status: "error", data: null, error: result.error }));
			}, [todayState.data]);

			const togglePopup = react.useCallback((next) => {
				const willOpen = typeof next === "boolean" ? next : !openRef.current;
				openRef.current = willOpen;
				if (willOpen) {
					const el = chipRef.current;
					if (el !== null) {
						const r = el.getBoundingClientRect();
						setRect({ left: r.left, top: r.top, width: r.width, bottom: r.bottom });
					}
					loadToday(true);
				} else {
					setRect(null);
				}
				setOpen(willOpen);
			}, [calibrate, loadToday]);
			openRef.current = open;

			// Page-first-load refresh: fire once on mount.
			react.useEffect(() => {
				calibrate();
			}, [calibrate]);

			// Periodic auto calibration every refreshMs (设置 → 余额配置 → 刷新间隔)
			// + catch-up on return to foreground.
			react.useEffect(() => {
				const timer = window.setInterval(() => calibrate(), refreshMs);
				const onWake = () => {
					if (document.visibilityState !== "visible") return;
					if (Date.now() - lastCalibrateRef.current < refreshMs) return;
					calibrate();
				};
				document.addEventListener("visibilitychange", onWake);
				window.addEventListener("focus", onWake);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", onWake);
					window.removeEventListener("focus", onWake);
				};
			}, [calibrate, refreshMs]);

			// close on outside click / Escape
			react.useEffect(() => {
				if (!open) return;
				const onDown = (event) => {
					const el = chipRef.current;
					if (el !== null && el.contains(event.target)) return;
					if (event.target instanceof Element && event.target.closest(".dsb-pop") !== null) return;
					togglePopup(false);
				};
				const onKey = (event) => { if (event.key === "Escape") togglePopup(false); };
				document.addEventListener("mousedown", onDown, true);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown, true);
					document.removeEventListener("keydown", onKey);
				};
			}, [open, togglePopup]);

			// ---- derived display ----
			const ready = balanceState.status === "ready" || balanceState.status === "refreshing";
			const cny = ready ? balanceState.value?.balances?.[0] : void 0;
			const official = Number(cny?.total ?? Number.NaN);
			const amountText = ready && Number.isFinite(official) ? fmtMoney(official) : (balanceState.status === "loading" ? "余额 …" : "余额 —");
			const warn = ready && Number.isFinite(official) && official < LOW_BALANCE_THRESHOLD;

			const todayReady = todayState.status === "ready" || todayState.status === "refreshing";
			const todayModels = todayReady ? MODEL_ORDER.map((m) => {
				const rec = (todayState.data?.models ?? []).find((r) => r.model === m) ?? null;
				return modelRow(m, rec);
			}) : null;
			const todayOthers = todayReady ? (todayState.data?.otherModels ?? []).map((r) => modelRow(r.model, r)) : [];

			let hint = null;
			if (!todayReady && todayState.status === "error") {
				hint = todayState.error === "missing DEEPSEEK_USER_TOKEN"
					? "未配置平台 userToken，今日分模型显示 —（在 设置 → 余额配置 中填写）"
					: `今日数据获取失败：${todayState.error}`;
			} else if (todayReady && todayState.data?.stale) {
				hint = "今日数据为缓存结果（刷新失败）";
			}

			const popup = open && rect !== null ? (0, react_dom.createPortal)(
				(0, react_jsx_runtime.jsxs)("div", {
					className: "dsb-pop",
					role: "dialog",
					"aria-label": "DeepSeek 余额详情",
					style: {
						position: "fixed",
						left: Math.max(4, Math.min(rect.left, window.innerWidth - 330)),
						bottom: Math.max(4, window.innerHeight - rect.top + 8)
					},
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: "dsb-pop-head",
							children: [
								(0, react_jsx_runtime.jsx)("span", { className: "dsb-pop-title", children: `余额 ${amountText}` }),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsb-pop-close",
									"aria-label": "关闭",
									onClick: () => togglePopup(false),
									children: "✕"
								})
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: "dsb-pop-hint",
							children: "今日累计消耗金额"
						}),
						todayModels === null
							? (0, react_jsx_runtime.jsx)("div", {
								className: "dsb-mrow",
								children: (0, react_jsx_runtime.jsx)("span", { className: "dsb-mrow-amt", children: todayState.status === "loading" ? "加载中…" : "—" })
							})
							: todayModels.map((row) => (0, react_jsx_runtime.jsxs)("div", {
								className: "dsb-mrow",
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: "dsb-mrow-name",
										children: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
											children: [row.name, row.sub !== null ? (0, react_jsx_runtime.jsx)("small", { children: row.sub }) : null]
										})
									}),
									(0, react_jsx_runtime.jsx)("span", { className: "dsb-mrow-amt", children: row.amount })
								]
							}, row.key)),
						todayOthers.length > 0 ? todayOthers.map((row) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dsb-mrow",
							children: [
								(0, react_jsx_runtime.jsx)("span", { className: "dsb-mrow-name", children: row.name }),
								(0, react_jsx_runtime.jsx)("span", { className: "dsb-mrow-amt", children: row.amount })
							]
						}, row.key)) : null,
						hint !== null ? (0, react_jsx_runtime.jsx)("div", { className: "dsb-err", children: hint }) : null,
						(0, react_jsx_runtime.jsx)("div", { className: "dsb-divider" }),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "dsb-cal-row",
							children: [
								(0, react_jsx_runtime.jsx)("span", { children: "上次校准" }),
								(0, react_jsx_runtime.jsx)("b", { children: balanceState.fetchedAt === null ? "—" : fmtCalibrated(balanceState.fetchedAt) })
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "dsb-foot",
							children: [
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsb-btn",
									onClick: () => {
										calibrate();
										loadToday(true);
									},
									children: "刷新数据"
								}),
								(0, react_jsx_runtime.jsx)("a", {
									className: "dsb-btn dsb-btn-primary",
									href: RECHARGE_URL,
									target: "_blank",
									rel: "noreferrer",
									children: "充值"
								})
							]
						})
					]
				}),
				document.body
			) : null;

			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
				children: [
					(0, react_jsx_runtime.jsx)("button", {
						ref: chipRef,
						type: "button",
						className: "dsb-chip",
						"data-warn": warn || void 0,
						"aria-expanded": open || void 0,
						"aria-label": `DeepSeek API 余额：${amountText}。点击查看详情`,
						disabled: balanceState.status === "loading",
						onClick: () => togglePopup(!open),
						children: [
							(0, react_jsx_runtime.jsx)("span", { className: "dsb-label", children: "余额" }),
							(0, react_jsx_runtime.jsx)("span", { className: "dsb-amount", children: amountText }),
							(0, react_jsx_runtime.jsx)("span", {
								className: "dsb-state",
								children: (0, react_jsx_runtime.jsx)("span", {
									className: "dsb-dot",
									"data-ok": ready || void 0,
									"data-err": balanceState.status === "error" || void 0
								})
							})
						]
					}),
					popup
				]
			});
		}
		//#endregion

		/** Settings section（余额配置）: platform userToken + 刷新间隔。 */
		const sWrap = { maxWidth: 560 };
		const sNote = { margin: "4px 0 10px", fontSize: "12px", lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" };
		const sRow = { display: "flex", gap: "8px", alignItems: "center" };
		const sInput = {
			flex: 1, padding: "7px 10px", fontSize: "13px", borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-1, transparent)",
			color: "var(--dsw-alias-label-primary)"
		};
		const sBtn = {
			padding: "7px 14px", fontSize: "13px", borderRadius: 6, cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "var(--dsw-alias-label-primary)"
		};
		const sBtnPrimary = {
			padding: "7px 16px", fontSize: "13px", fontWeight: 600, borderRadius: 6, cursor: "pointer",
			border: "none", background: "rgb(59,130,246)", color: "#fff"
		};
		const sMsg = (tone) => ({
			padding: "8px 12px", borderRadius: 6, fontSize: "12px", whiteSpace: "pre-wrap",
			background: tone === "ok" ? "rgba(34,197,94,.12)" : "rgba(239,68,68,.12)",
			color: tone === "ok" ? "rgb(22,163,74)" : "var(--dsw-alias-state-error-primary, rgb(220,38,38))"
		});

		function TokenSettingsSection() {
			const [status, setStatus] = react.useState(null);
			const [input, setInput] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null); // {tone, text}
			const refreshStatus = react.useCallback(() => {
				readStatus().then((result) => {
					setStatus(result.ok ? result.value : { hasKey: false, hasToken: false, error: result.error });
				});
			}, []);
			react.useEffect(() => { refreshStatus(); }, [refreshStatus]);
			const onSave = async () => {
				const token = input.trim();
				if (token === "") return;
				setBusy(true);
				setMsg(null);
				const result = await saveToken(token);
				setBusy(false);
				if (result && result.ok) {
					setInput("");
					await refreshStatus();
					const shadowed = result.tokenSource === "env";
					setMsg({
						tone: "ok",
						text: shadowed
							? "已保存到本地凭据。注意：检测到环境变量里的同名 Token 优先于文件，若仍取到旧值请移除环境变量后重启 App。"
							: "已保存 ✓ 今日分模型数据会立即使用新 Token；若左下角弹窗仍显示 —，请重启 App。"
					});
				} else {
					setMsg({ tone: "err", text: `保存失败：${result?.message ?? "未知错误"}` });
				}
			};
			const onClear = async () => {
				setBusy(true);
				setMsg(null);
				const result = await clearToken();
				setBusy(false);
				await refreshStatus();
				setMsg({ tone: "ok", text: "已清除（如需彻底移除环境变量版本请自行处理）" });
			};
			const hasToken = !!status?.hasToken;
			const source = status?.tokenSource ?? null;
			return (0, react_jsx_runtime.jsx)("div", {
				style: sWrap,
				children: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							children: [
								(0, react_jsx_runtime.jsx)("b", { children: "DeepSeek 开放平台登录 Token" }),
								(0, react_jsx_runtime.jsx)("span", { children: status === null ? "（检测中…）" : `（${hasToken ? `已配置${source ? ` · ${source}` : ""}` : "未配置"}）` })
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							style: sNote,
							children: "用于读取平台官方「今日分模型消耗」。获取方法：浏览器登录 platform.deepseek.com 后按 F12 打开控制台，执行 localStorage.getItem(\"userToken\")，复制返回内容粘贴到下面。Token 仅保存在本机 ~/.dsh 凭据文件中，不会上传。"
						}),
						hasToken
							? (0, react_jsx_runtime.jsxs)("div", {
								style: sRow,
								children: [
									(0, react_jsx_runtime.jsx)("input", {
										type: "password",
										placeholder: "已配置。可在此粘贴新 Token 覆盖",
										value: input,
										onChange: (e) => setInput(e.target.value),
										style: sInput,
										autoComplete: "off"
									}),
									(0, react_jsx_runtime.jsx)("button", { style: sBtnPrimary, disabled: busy || input.trim() === "", onClick: onSave, children: "保存" }),
									(0, react_jsx_runtime.jsx)("button", { style: sBtn, disabled: busy, onClick: onClear, children: "清除" })
								]
							})
							: (0, react_jsx_runtime.jsxs)("div", {
								style: sRow,
								children: [
									(0, react_jsx_runtime.jsx)("input", {
										type: "password",
										placeholder: "粘贴 localStorage 的 userToken",
										value: input,
										onChange: (e) => setInput(e.target.value),
										style: sInput,
										autoComplete: "off"
									}),
									(0, react_jsx_runtime.jsx)("button", { style: sBtnPrimary, disabled: busy || input.trim() === "", onClick: onSave, children: "保存" })
								]
							}),
						msg !== null ? (0, react_jsx_runtime.jsx)("div", { style: sMsg(msg.tone), children: msg.text }) : null,
						(0, react_jsx_runtime.jsx)("div", { style: { borderTop: "0.5px solid var(--dsw-alias-border-l2)", margin: "14px 0" } }),
						(0, react_jsx_runtime.jsx)(RefreshIntervalSetting, {})
					]
				})
			});
		}

		function RefreshIntervalSetting() {
			const [refreshMs, setRefreshMsState] = react.useState(getRefreshMs);
			const [customOpen, setCustomOpen] = react.useState(false);
			const [draft, setDraft] = react.useState("");
			const [msg, setMsg] = react.useState(null);
			react.useEffect(() => onRefreshMsChange(setRefreshMsState), []);
			const seconds = Math.round(refreshMs / 1000);
			const isPreset = REFRESH_PRESETS_SEC.indexOf(seconds) >= 0;
			const customActive = customOpen || !isPreset;
			const segButton = (active) => ({
				flex: 1, minWidth: 0, padding: "6px 0", fontSize: "12px", borderRadius: 6,
				cursor: "pointer", textAlign: "center",
				border: active ? "none" : "1px solid var(--dsw-alias-border-l1)",
				background: active ? "rgb(59,130,246)" : "transparent",
				color: active ? "#fff" : "var(--dsw-alias-label-primary)"
			});
			const choose = async (sec) => {
				setCustomOpen(false);
				setDraft("");
				setMsg(null);
				const r = await saveRefreshSec(sec);
				setMsg(r.ok
					? { tone: "ok", text: `已保存并生效：每 ${sec} 秒自动校准一次` }
					: { tone: "err", text: `保存失败：${r.error}` });
			};
			const openCustom = () => {
				setCustomOpen(true);
				setDraft(String(seconds));
				setMsg(null);
			};
			const applyCustom = async () => {
				const num = Number(draft);
				if (!Number.isInteger(num) || num < REFRESH_MIN_SEC || num > REFRESH_MAX_SEC) {
					setMsg({ tone: "err", text: `请输入 ${REFRESH_MIN_SEC}–${REFRESH_MAX_SEC} 之间的整数（秒）` });
					return;
				}
				setMsg(null);
				const r = await saveRefreshSec(num);
				setMsg(r.ok
					? { tone: "ok", text: `已保存并生效：每 ${num} 秒自动校准一次` }
					: { tone: "err", text: `保存失败：${r.error}` });
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				children: [
					(0, react_jsx_runtime.jsx)("b", { children: "刷新间隔" }),
					(0, react_jsx_runtime.jsx)("div", { style: sNote, children: "余额芯片自动校准（官方余额接口，免费）的间隔。刷新规则：页面首次打开立即刷新；此后每 N 秒自动刷新一次（不区分状态）；从后台返回时距上次刷新已满 N 秒会立即补一次；点弹窗里「刷新数据」随时手动刷新。设置与 Token 一起保存在本机 ~/.dsh 凭据文件中，重启 App、更换端口都会保持。N 即下面的间隔。" }),
					(0, react_jsx_runtime.jsxs)("div", {
						style: { ...sRow, marginTop: 2 },
						children: REFRESH_PRESETS_SEC.map((sec) =>
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: segButton(!customActive && seconds === sec),
								onClick: () => choose(sec),
								children: `${sec}s`
							}, `preset-${sec}`)
						).concat((0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: segButton(customActive),
							onClick: openCustom,
							children: "自定义"
						}, "preset-custom"))
					}),
					customOpen ? (0, react_jsx_runtime.jsxs)("div", {
						style: { ...sRow, marginTop: 8 },
						children: [
							(0, react_jsx_runtime.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" }, children: "自定义间隔" }),
							(0, react_jsx_runtime.jsx)("input", {
								type: "number", min: REFRESH_MIN_SEC, max: REFRESH_MAX_SEC, step: 1,
								value: draft,
								onChange: (e) => setDraft(e.target.value),
								style: { ...sInput, flex: "0 0 96px" },
								autoComplete: "off"
							}),
							(0, react_jsx_runtime.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: "秒" }),
							(0, react_jsx_runtime.jsx)("button", { style: sBtnPrimary, disabled: draft.trim() === "", onClick: applyCustom, children: "应用" })
						]
					}) : null,
					msg !== null ? (0, react_jsx_runtime.jsx)("div", { style: { ...sMsg(msg.tone), marginTop: 8 }, children: msg.text }) : null
				]
			});
		}

		/** Plugin body: sidebar footer chip + settings section. */
		const inject = ["slots"];
		function apply(ctx) {
			const slots = ctx.slots;
			if (slots === void 0 || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
			slots.inject("sidebar.footer.action", () => slots.register({
				name: "sidebar.footer.action",
				id: "dsh-balance-chip",
				inject: () => ({})
			}, BalanceChip));
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "balance-token",
				order: 60,
				label: "余额配置"
			}, TokenSettingsSection));
		}
		//#endregion

		exports.BalanceChip = BalanceChip;
		exports.TokenSettingsSection = TokenSettingsSection;
		exports.apply = apply;
		exports.clearToken = clearToken;
		exports.inject = inject;
		exports.readBalance = readBalance;
		exports.readStatus = readStatus;
		exports.readToday = readToday;
		exports.saveToken = saveToken;
		return module.exports;
	}
});
