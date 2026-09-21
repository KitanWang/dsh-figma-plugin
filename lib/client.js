window.__ModuleLoader__.load({
	id: "dsh-figma",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * dsh-figma browser half: the Figma connection page under Settings.
		 *
		 * The page answers exactly one question — is Figma connected? — and
		 * offers exactly one action: sign in, or sign in again. Nothing about
		 * credentials appears anywhere in the browser: no access token, no
		 * expiry, no client id, no client secret. Those are the host half's to
		 * hold and are never sent here.
		 *
		 * The OAuth client is built into the plugin, so the user never registers
		 * an app or pastes a secret. They press the button, Figma's own consent
		 * page opens, and this page flips to "Connected" when they approve.
		 */
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { Button } = primitives;

		const NS = "figma";

		/** How often to check whether the callback has landed while the user is away. */
		const POLL_MS = 1500;

		const zh = {
			nav: "Figma",
			connectedTitle: "已连接 Figma",
			connectedDesc: "agent 现在可以读取你有权限访问的 Figma 设计稿。",
			connectedAs: "当前账号",
			notConnectedTitle: "未连接 Figma",
			notConnectedDesc: "连接后，agent 才能读取你的 Figma 设计稿。",
			connect: "连接 Figma",
			reconnect: "重新连接",
			reconnectHint: "更换账号或需要重新授权时使用。",
			waitingTitle: "等待你在浏览器中完成授权",
			waitingDesc: "已在浏览器打开 Figma 的登录与授权页面。完成授权后本页会自动更新。",
			waitingTrouble: "如果 Figma 页面显示报错，本页不会自动更新。常见两种：缺少权限（Invalid scopes for app）—— 需在 Figma 后台补齐权限；回调地址不匹配（Invalid redirect_uri）—— 你当前的回调地址如下，需原样登记到 Figma 应用：",
			waitingRedirectLabel: "当前回调地址",
			reopen: "重新打开授权页面",
			cancel: "取消",
			popupBlocked: "浏览器拦截了弹窗，请手动打开下面的链接完成授权：",
			openLink: "打开授权页面",
			checking: "正在检查连接状态…",
			error: "出错了",
			unavailable: "此版本未内置 Figma OAuth 客户端，无法登录。请联系部署者。",
			retry: "重试",
			accountUnknown: "已连接（账号信息不可读）",
			authorized: "授权成功，已连接 Figma。",
			denied: "你在 Figma 页面上拒绝了授权。",
			cancelled: "授权已取消。",
			expired: "本次授权已超时，请重新连接。",
			failed: "授权失败",
			unknownState: "回调与本次授权不匹配，请重新连接。",
		};

		const en = {
			nav: "Figma",
			connectedTitle: "Figma is connected",
			connectedDesc: "The agent can now read the Figma designs your account has access to.",
			connectedAs: "Signed in as",
			notConnectedTitle: "Figma is not connected",
			notConnectedDesc: "Connect to let the agent read your Figma designs.",
			connect: "Connect Figma",
			reconnect: "Reconnect",
			reconnectHint: "Use this to switch accounts or restore access.",
			waitingTitle: "Waiting for you to finish in the browser",
			waitingDesc: "Figma's sign-in and consent page is open in your browser. This page updates automatically once you approve.",
			waitingTrouble: "If Figma's page shows an error, this page will not update on its own. The common two: a missing scope (\"Invalid scopes for app\") — fix the app's scopes in Figma; or a redirect mismatch (\"Invalid redirect_uri\") — the exact callback URL your GUI is using is below, and it must be registered on the app:",
			waitingRedirectLabel: "Current callback URL",
			reopen: "Reopen authorization page",
			cancel: "Cancel",
			popupBlocked: "The browser blocked the popup — open this link to finish authorizing:",
			openLink: "Open authorization page",
			checking: "Checking the connection…",
			error: "Something went wrong",
			unavailable: "This build carries no Figma OAuth client, so sign-in is unavailable. Ask the deployment owner.",
			retry: "Retry",
			accountUnknown: "Connected (account details unavailable)",
			authorized: "Authorized — Figma is connected.",
			denied: "You declined the request on Figma's page.",
			cancelled: "Authorization was cancelled.",
			expired: "This authorization timed out. Please connect again.",
			failed: "Authorization failed",
			unknownState: "That callback did not match this sign-in. Please connect again.",
		};

		/** Resolve a host route against the document base, like the shell's own mount. */
		function api(path) {
			const relative = path.replace(/^\/+/, "");
			if (typeof document === "undefined") return `/${relative}`;
			return new URL(relative, document.baseURI).pathname;
		}

		const API = "figma/api/v1";

		/** One JSON call to the host half. Never throws: failures come back as `{ error }`. */
		async function call(path, options) {
			const init = { cache: "no-store" };
			if (options !== undefined && options.method !== undefined) {
				init.method = options.method;
				init.headers = { "content-type": "application/json" };
				init.body = "{}";
			}
			try {
				const response = await fetch(api(`${API}/${path}`), init);
				const text = await response.text();
				let body;
				try {
					body = text.length === 0 ? {} : JSON.parse(text);
				} catch {
					body = { error: text.slice(0, 300) };
				}
				if (!response.ok) return { error: body.error ?? `HTTP ${response.status}` };
				return body;
			} catch (error) {
				return { error: error && error.message ? error.message : String(error) };
			}
		}

		/** Localize a settled authorization attempt into a notice. */
		function settledText(t, pending) {
			switch (pending.status) {
				case "authorized":
					return { kind: "ok", text: t("authorized") };
				case "denied":
					return { kind: "warn", text: t("denied") };
				case "cancelled":
					return { kind: "warn", text: t("cancelled") };
				case "expired":
					return { kind: "warn", text: t("expired") };
				case "unknown-state":
					return { kind: "warn", text: t("unknownState") };
				case "failed":
					return { kind: "error", text: `${t("failed")}${pending.error ? ` — ${pending.error}` : ""}` };
				default:
					return null;
			}
		}

		/**
		 * Connection state plus the one action available.
		 *
		 * One store instance per activation, so every read sees the same
		 * snapshot.
		 */
		function createConnectionStore() {
			let listeners = new Set();
			let snapshot = {
				loading: true,
				status: null,
				error: null,
				busy: false,
				notice: null,
				blockedUrl: null,
			};
			let timer = null;
			let disposed = false;

			/** Active translate function, bound by apply(). */
			let tRef = (key) => key;

			function emit() {
				for (const listener of listeners) listener();
			}

			function set(patch) {
				snapshot = { ...snapshot, ...patch };
				emit();
			}

			async function refresh(options) {
				const verify = options && options.verify === true;
				const result = await call(`status${verify ? "?verify=1" : ""}`);
				if (disposed) return;
				if (result.error !== undefined) {
					set({ loading: false, error: result.error });
					return;
				}
				const pending = result.pending;
				let notice = snapshot.notice;
				if (pending !== null && pending !== undefined && pending.status !== "pending") {
					notice = settledText(tRef, pending);
					// A settled attempt is news once; a later refresh reports the
					// resulting connection state instead.
					result.pending = null;
				}
				set({ loading: false, status: result, error: null, notice });
			}

			/**
			 * Poll while an authorization is in flight, then stop.
			 *
			 * Polling exists only to notice the callback landing in this process
			 * while the user is in another tab, so an idle GUI makes no requests
			 * at all.
			 */
			function pollUntilSettled() {
				if (disposed) return;
				const pending = snapshot.status && snapshot.status.pending;
				const inFlight = pending !== null && pending !== undefined && pending.status === "pending";
				if (!inFlight) {
					stopPolling();
					return;
				}
				if (timer !== null) return;
				timer = setInterval(async () => {
					if (disposed) return;
					await refresh({});
					const next = snapshot.status && snapshot.status.pending;
					if (next === null || next === undefined || next.status !== "pending") stopPolling();
				}, POLL_MS);
			}

			function stopPolling() {
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			}

			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot() {
					return snapshot;
				},
				bindTranslate(t) {
					tRef = t;
				},
				async init() {
					await refresh({ verify: true });
					pollUntilSettled();
				},
				dispose() {
					disposed = true;
					stopPolling();
					listeners = new Set();
				},
				async refresh(options) {
					await refresh(options ?? {});
				},
				/** Begin authorization; returns the URL to open, or null on failure. */
				async connect() {
					set({ busy: true, error: null, notice: null, blockedUrl: null });
					const result = await call("connect", { method: "POST" });
					set({ busy: false });
					if (result.error !== undefined) {
						set({ error: result.error });
						return null;
					}
					return result.authorizationUrl ?? null;
				},
				async cancel() {
					set({ busy: true });
					await call("cancel", { method: "POST" });
					set({ busy: false });
					await refresh({});
				},
				/** Record a blocked popup so the page can offer the link instead. */
				notifyBlocked(url) {
					set({ blockedUrl: url });
				},
				startPolling: pollUntilSettled,
			};
		}

		/** Subscribe a component to the store. */
		function useStore(store) {
			const [, force] = React.useReducer((n) => n + 1, 0);
			React.useEffect(() => store.subscribe(force), [store]);
			return store.getSnapshot();
		}

		/**
		 * Start authorization in a new tab.
		 *
		 * Figma requires a real browser (an embedded webview is rejected), and
		 * the callback arrives at this process, so a tab is exactly right.
		 */
		async function startAuthorization(store) {
			const url = await store.connect();
			if (url === null) return;
			let opened = null;
			try {
				opened = window.open(url, "_blank", "noopener,noreferrer");
			} catch {
				opened = null;
			}
			// A blocked popup must not strand the user: surface the link instead.
			if (opened === null) store.notifyBlocked(url);
			store.startPolling();
			await store.refresh({});
		}

		/** Current state with a coloured dot. */
		function StatusLine(props) {
			return React.createElement(
				"div",
				{ className: "figma-status" },
				React.createElement("span", { className: `figma-dot${props.connected ? " is-on" : ""}` }),
				React.createElement("div", { className: "figma-status-copy" }, props.children),
			);
		}

		/**
		 * The whole page: current state, the account when known, and the action.
		 */
		function FigmaConnection(props) {
			const { t, store } = props;
			const state = useStore(store);
			const status = state.status;

			React.useEffect(() => {
				store.refresh({ verify: true });
			}, [store]);

			const children = [];

			if (status === null) {
				children.push(
					React.createElement(
						"p",
						{ className: "figma-muted", key: "loading" },
						state.error === null ? t("checking") : `${t("error")}: ${state.error}`,
					),
				);
				if (state.error !== null) {
					children.push(
						React.createElement(
							Button,
							{ key: "retry", variant: "secondary", onClick: () => store.refresh({ verify: true }) },
							t("retry"),
						),
					);
				}
				return React.createElement("div", { className: "figma-page" }, children);
			}

			const connected = status.connected === true;
			const pending = status.pending;
			const inFlight = pending !== null && pending !== undefined && pending.status === "pending";
			const account = status.account;

			children.push(
				React.createElement(
					StatusLine,
					{ connected, key: "status" },
					React.createElement("strong", null, connected ? t("connectedTitle") : t("notConnectedTitle")),
					React.createElement("span", { className: "figma-muted" }, connected ? t("connectedDesc") : t("notConnectedDesc")),
				),
			);

			// The account is the user's own identity, shown only to confirm which
			// Figma account is connected.
			if (connected) {
				children.push(
					React.createElement(
						"div",
						{ className: "figma-field", key: "account" },
						React.createElement("span", { className: "figma-field-label" }, t("connectedAs")),
						React.createElement(
							"span",
							{ className: "figma-field-value" },
							account !== undefined && account !== null && account.handle !== undefined
								? `${account.handle}${account.email ? ` <${account.email}>` : ""}`
								: t("accountUnknown"),
						),
					),
				);
			}

			if (state.notice !== null && state.notice !== undefined) {
				children.push(
					React.createElement("p", { className: `figma-notice is-${state.notice.kind}`, key: "notice" }, state.notice.text),
				);
			}

			if (state.error !== null) {
				children.push(
					React.createElement("p", { className: "figma-error", key: "error" }, `${t("error")}: ${state.error}`),
				);
			}

			if (inFlight) {
				children.push(
					React.createElement(
						"div",
						{ className: "figma-waiting", key: "waiting" },
						React.createElement(
							"div",
							{ className: "figma-waiting-head" },
							React.createElement("span", { className: "figma-spinner" }),
							React.createElement("strong", null, t("waitingTitle")),
						),
						React.createElement("p", { className: "figma-muted" }, t("waitingDesc")),
						React.createElement("p", { className: "figma-hint" }, t("waitingTrouble")),
						React.createElement(
							"div",
							{ className: "figma-redirect-row" },
							React.createElement("span", { className: "figma-field-label" }, t("waitingRedirectLabel")),
							React.createElement("code", { className: "figma-code" }, status.redirectUri ?? ""),
						),
					),
				);
			}

			// A blocked popup must stay completable, so the link remains reachable.
			if (state.blockedUrl !== null && state.blockedUrl !== undefined) {
				children.push(
					React.createElement(
						"div",
						{ className: "figma-blocked", key: "blocked" },
						React.createElement("p", { className: "figma-warn" }, t("popupBlocked")),
						React.createElement(
							Button,
							{ variant: "secondary", onClick: () => window.open(state.blockedUrl, "_blank", "noopener,noreferrer") },
							t("openLink"),
						),
					),
				);
			}

			const actions = [];
			if (status.available !== true) {
				// A deployment fault, not something the user can act on.
				children.push(React.createElement("p", { className: "figma-warn", key: "unavailable" }, t("unavailable")));
			} else if (inFlight) {
				actions.push(
					React.createElement(
						Button,
						{ key: "cancel", variant: "secondary", disabled: state.busy, onClick: () => store.cancel() },
						t("cancel"),
					),
				);
				actions.push(
					React.createElement(
						Button,
						{
							key: "reopen",
							variant: "ghost",
							disabled: state.busy,
							onClick: () => {
								if (state.blockedUrl !== null && state.blockedUrl !== undefined) {
									window.open(state.blockedUrl, "_blank", "noopener,noreferrer");
								} else {
									startAuthorization(store);
								}
							},
						},
						t("reopen"),
					),
				);
			} else {
				actions.push(
					React.createElement(
						Button,
						{
							key: "connect",
							variant: connected ? "secondary" : "primary",
							disabled: state.busy,
							onClick: () => startAuthorization(store),
						},
						connected ? t("reconnect") : t("connect"),
					),
				);
			}
			if (actions.length > 0) {
				children.push(React.createElement("div", { className: "figma-actions", key: "actions" }, actions));
			}

			if (connected && !inFlight) {
				children.push(React.createElement("p", { className: "figma-hint", key: "reconnectHint" }, t("reconnectHint")));
			}

			return React.createElement("div", { className: "figma-page" }, children);
		}

		/** Styles, injected once and owned by this plugin's fiber. */
		const CSS = `
.figma-page { display: flex; flex-direction: column; gap: .875rem; max-width: 34rem; }
.figma-status { display: flex; align-items: flex-start; gap: .625rem; }
.figma-dot { width: .5rem; height: .5rem; margin-top: .45rem; border-radius: 999px; flex: none; background: var(--dsw-alias-label-tertiary, #8a8f98); }
.figma-dot.is-on { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent); }
.figma-status-copy { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
.figma-status-copy strong { color: var(--dsw-alias-label-primary); font-size: .9375rem; }
.figma-muted { margin: 0; font-size: .8125rem; color: var(--dsw-alias-label-secondary); }
.figma-hint { margin: 0; font-size: .75rem; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.figma-warn { margin: 0; font-size: .8125rem; color: var(--dsw-alias-state-warn-primary); }
.figma-error { margin: 0; font-size: .8125rem; color: var(--dsw-alias-state-error-primary); }
.figma-notice { margin: 0; font-size: .8125rem; }
.figma-notice.is-ok { color: var(--dsw-alias-state-success-primary); }
.figma-notice.is-warn { color: var(--dsw-alias-state-warn-primary); }
.figma-notice.is-error { color: var(--dsw-alias-state-error-primary); }
.figma-field { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; font-size: .8125rem; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: .625rem; }
.figma-field-label { color: var(--dsw-alias-label-secondary); flex: none; }
.figma-field-value { color: var(--dsw-alias-label-primary); text-align: right; word-break: break-all; }
.figma-waiting { display: flex; flex-direction: column; gap: .35rem; padding: .75rem; border: 1px solid var(--dsw-alias-border-l1); border-radius: .5rem; background: var(--dsw-alias-bg-layer-1); }
.figma-waiting-head { display: flex; align-items: center; gap: .5rem; }
.figma-waiting-head strong { font-size: .875rem; color: var(--dsw-alias-label-primary); }
.figma-spinner { width: .75rem; height: .75rem; border-radius: 999px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: figma-spin .8s linear infinite; flex: none; }
@keyframes figma-spin { to { transform: rotate(360deg); } }
.figma-blocked { display: flex; flex-direction: column; gap: .5rem; align-items: flex-start; }
.figma-redirect-row { display: flex; flex-direction: column; gap: .2rem; }
.figma-code { font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, monospace); font-size: .75rem; word-break: break-all; color: var(--dsw-alias-label-primary); }
.figma-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
`;

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-figma: dictionaries");
			const t = ctx.locale.bind(NS);

			ctx.effect(() => {
				// A packaged client bundle has no `styles` builtin (that belongs to
				// the dynamic-Cordis sandbox), so the tag is owned here directly and
				// tagged with this plugin for HMR bookkeeping.
				if (typeof document === "undefined") return () => {};
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-figma";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => tag.remove();
			}, "dsh-figma: styles");

			const store = createConnectionStore();
			store.bindTranslate(t);
			ctx.effect(() => {
				store.init().catch(() => {});
				return () => store.dispose();
			}, "dsh-figma: connection store");

			// The connection page is the plugin's entire browser surface. It is
			// deliberately absent from the sidebar: connecting Figma is a one-time
			// errand, not something that needs permanent chrome.
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "figma",
						order: 45,
						label: () => t("nav"),
						locale: NS,
						inject: () => ({ t, store }),
					},
					FigmaConnection,
				),
			);
		}

		exports.name = "dsh-figma";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
