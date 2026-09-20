window.__ModuleLoader__.load({
	id: "dsh-figma",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * dsh-figma browser half: the Figma connection surface.
		 *
		 * It renders in two places, which is the whole design:
		 *
		 * - a **Figma settings page** (`settings.section`), the full control
		 *   panel: connection state, the account, connect / reconnect /
		 *   disconnect, and the OAuth client setup when none is configured;
		 * - a **sidebar status action** (`sidebar.footer.action`) beside the
		 *   Settings button, which shows the connection state at a glance and
		 *   opens a popover with the one action that matters right now.
		 *
		 * Both read one status endpoint and call one small JSON API the host
		 * half serves. The browser never sees a token: it starts an
		 * authorization, opens Figma's own page, and then observes the result.
		 */
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { Button, Tooltip } = primitives;

		const NS = "figma";
		const POLL_MS = 1500;

		/** Figma's own brand red, used only for the state dot's identity. */
		const FIGMA_ACCENT = "#a259ff";

		const zh = {
			nav: "Figma",
			sectionTitle: "Figma 连接",
			sectionDesc: "连接 Figma 账号后，agent 可以直接读取设计稿、组件与设计变量。",
			status: "连接状态",
			connected: "已连接",
			disconnected: "未连接",
			loading: "正在读取连接状态…",
			connectedAs: "已连接为",
			modeOauth: "OAuth 授权登录",
			modePat: "个人访问令牌 (PAT)",
			accountUnknown: "账号信息不可读",
			expiresAt: "访问令牌有效期至",
			expiresNever: "长期有效",
			connect: "连接 Figma",
			reconnect: "重新授权",
			disconnect: "断开连接",
			cancel: "取消授权",
			refresh: "刷新状态",
			waiting: "等待你在浏览器中完成 Figma 授权…",
			opening: "正在打开 Figma 授权页面…",
			popupBlocked: "浏览器拦截了弹窗，请手动打开下面的链接：",
			openLink: "打开授权页面",
			setupTitle: "需要先配置 OAuth 应用",
			setupDesc: "Figma 的令牌交换必须使用你自己的 OAuth 应用（Client Secret 无法内置分发）。创建一次即可长期使用。",
			setupStep1: "打开 Figma 开发者设置，创建一个 OAuth 应用。",
			setupStep2: "在该应用的 OAuth credentials 里添加下面的重定向地址（必须完全一致）。",
			setupStep3: "填入应用的 Client ID 与 Client Secret，然后点击连接。",
			openAppsPage: "打开 Figma 开发者页面",
			clientId: "Client ID",
			clientSecret: "Client Secret",
			clientSecretHint: "保存在本地凭据库，不会写入设置文件，也不会回显。",
			clientIdPlaceholder: "例如 AbCdEf123456",
			clientSecretPlaceholder: "粘贴 Client Secret",
			save: "保存",
			saved: "已保存",
			copy: "复制",
			copied: "已复制",
			redirectUri: "重定向地址 (Redirect URL)",
			redirectHint: "在 Figma OAuth 应用的 “OAuth credentials” 中添加此地址。",
			scopes: "申请的权限范围",
			advanced: "高级",
			secretConfigured: "Client Secret 已配置",
			secretMissing: "Client Secret 未配置",
			patNote: "当前使用个人访问令牌 (PAT)，由环境变量或凭据库提供。PAT 无法自动续期。",
			patConnectHint: "也可以改用 OAuth 登录，令牌将自动续期。",
			error: "出错了",
			close: "关闭",
			disconnectedHint: "未连接时 figma_* 工具会提示先连接。",
			pendingDenied: "授权被拒绝",
			pendingFailed: "授权失败",
			pendingExpired: "授权已超时",
			pendingCancelled: "授权已取消",
			pendingAuthorized: "授权成功",
			pendingUnknown: "回调状态不匹配，请重新连接",
			noStore: "当前部署未挂载凭据存储，无法保存 OAuth 令牌。",
		};

		const en = {
			nav: "Figma",
			sectionTitle: "Figma connection",
			sectionDesc: "Connect a Figma account so the agent can read designs, components, and variables.",
			status: "Connection",
			connected: "Connected",
			disconnected: "Not connected",
			loading: "Reading connection status…",
			connectedAs: "Connected as",
			modeOauth: "OAuth sign-in",
			modePat: "Personal access token",
			accountUnknown: "Account details unavailable",
			expiresAt: "Access token expires",
			expiresNever: "No expiry",
			connect: "Connect Figma",
			reconnect: "Re-authorize",
			disconnect: "Disconnect",
			cancel: "Cancel authorization",
			refresh: "Refresh",
			waiting: "Waiting for you to finish authorizing in the browser…",
			opening: "Opening Figma's authorization page…",
			popupBlocked: "The browser blocked the popup — open this link manually:",
			openLink: "Open authorization page",
			setupTitle: "An OAuth app is required first",
			setupDesc: "Figma requires your own OAuth app for the token exchange (its Client Secret cannot be shipped). Create one once and it keeps working.",
			setupStep1: "Open Figma's developer settings and create an OAuth app.",
			setupStep2: "Add the redirect URL below to that app's OAuth credentials — it must match exactly.",
			setupStep3: "Enter the app's Client ID and Client Secret, then connect.",
			openAppsPage: "Open Figma developer apps",
			clientId: "Client ID",
			clientSecret: "Client Secret",
			clientSecretHint: "Stored in the local credential store — never written to settings, never echoed back.",
			clientIdPlaceholder: "e.g. AbCdEf123456",
			clientSecretPlaceholder: "Paste the Client Secret",
			save: "Save",
			saved: "Saved",
			copy: "Copy",
			copied: "Copied",
			redirectUri: "Redirect URL",
			redirectHint: "Add this to the OAuth credentials page of your Figma app.",
			scopes: "Requested scopes",
			advanced: "Advanced",
			secretConfigured: "Client Secret is set",
			secretMissing: "Client Secret is not set",
			patNote: "Currently using a personal access token from the environment or credential store. A PAT cannot refresh itself.",
			patConnectHint: "You can switch to OAuth sign-in so the token refreshes automatically.",
			error: "Something went wrong",
			close: "Close",
			disconnectedHint: "While disconnected, the figma_* tools ask you to connect first.",
			pendingDenied: "Authorization was declined",
			pendingFailed: "Authorization failed",
			pendingExpired: "Authorization timed out",
			pendingCancelled: "Authorization was cancelled",
			pendingAuthorized: "Authorized",
			pendingUnknown: "The callback did not match this attempt; please connect again",
			noStore: "This deployment mounts no credential store, so an OAuth token cannot be saved.",
		};

		/** Resolve a host route against the document base, like the shell's own mount. */
		function api(path) {
			const relative = path.replace(/^\/+/, "");
			if (typeof document === "undefined") return `/${relative}`;
			return new URL(relative, document.baseURI).pathname;
		}

		const API = "figma/api/v1";

		/** One JSON call to the host half. Never throws: failures become `{ error }`. */
		async function call(path, options) {
			const init = { cache: "no-store" };
			if (options !== undefined) {
				init.method = options.method ?? "POST";
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(options.body ?? {});
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

		/** Format an absolute expiry for display, or the "no expiry" label. */
		function expiryText(t, expiresAt) {
			if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return t("expiresNever");
			try {
				return new Date(expiresAt).toLocaleString();
			} catch {
				return t("expiresNever");
			}
		}

		/** The status of a settled pending attempt, as a localized line. */
		function pendingText(t, pending) {
			switch (pending.status) {
				case "authorized":
					return t("pendingAuthorized");
				case "denied":
					return `${t("pendingDenied")}${pending.error ? ` — ${pending.error}` : ""}`;
				case "expired":
					return t("pendingExpired");
				case "cancelled":
					return t("pendingCancelled");
				case "unknown-state":
					return t("pendingUnknown");
				case "failed":
					return `${t("pendingFailed")}${pending.error ? ` — ${pending.error}` : ""}`;
				default:
					return null;
			}
		}

		/** Copy text to the clipboard, reporting success for the button label. */
		async function copyText(value) {
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					await navigator.clipboard.writeText(value);
					return true;
				}
			} catch {
				/* fall through to the legacy path */
			}
			try {
				const area = document.createElement("textarea");
				area.value = value;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand("copy");
				area.remove();
				return ok;
			} catch {
				return false;
			}
		}

		/**
		 * Owns the connection status and the actions every surface shares.
		 *
		 * One store instance is created per plugin activation and passed to both
		 * slots, so the settings page and the sidebar action never disagree.
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
			/** Focus handler kept outside the snapshot so dispose can remove it. */
			let onFocusRef = null;

			function emit() {
				for (const listener of listeners) listener();
			}

			function set(patch) {
				snapshot = { ...snapshot, ...patch };
				emit();
			}

			async function refresh(options) {
				const verify = options && options.verify === true;
				const result = await call(`status${verify ? "?verify=1" : ""}`, undefined);
				if (disposed) return;
				if (result.error !== undefined) {
					set({ loading: false, error: result.error });
					return;
				}
				const pending = result.pending;
				let notice = snapshot.notice;
				if (pending !== null && pending !== undefined && pending.status !== "pending") {
					notice = pendingText(tRef, pending);
					// A settled attempt is reported once, then stops being news.
					if (pending.status === "authorized") result.pending = null;
				}
				set({ loading: false, status: result, error: null, notice });
			}

			/** A reference to the active translate function, set by the panel. */
			let tRef = (key) => key;

			/**
			 * Poll while an authorization is in flight, then stop.
			 *
			 * Polling exists only to notice the callback landing in this process
			 * while the human is in another tab, so it must not run the rest of the
			 * time: an idle GUI should make no Figma requests at all.
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
					if (next === null || next === undefined || next.status !== "pending") {
						stopPolling();
					}
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
					await refresh({});
					if (disposed) return;
					// A callback can land while this tab is in the background, so
					// re-read on focus and while an attempt is in flight.
					if (typeof window !== "undefined") {
						const onFocus = () => {
							refresh({});
						};
						onFocusRef = onFocus;
						window.addEventListener("focus", onFocus);
					}
					pollUntilSettled();
				},
				dispose() {
					disposed = true;
					stopPolling();
					if (typeof window !== "undefined" && onFocusRef !== null) {
						window.removeEventListener("focus", onFocusRef);
						onFocusRef = null;
					}
					listeners = new Set();
				},
				startPolling: pollUntilSettled,
				stopPolling,
				async refresh(options) {
					await refresh(options ?? {});
				},
				async saveClient(clientId, clientSecret) {
					set({ busy: true, error: null });
					const result = await call("connect", { body: { clientId, clientSecret } });
					set({ busy: false });
					if (result.error !== undefined) {
						set({ error: result.error });
						return false;
					}
					await refresh({});
					return true;
				},
				/** Begin authorization and send the human to Figma's own page. */
				async connect(body) {
					set({ busy: true, error: null, notice: null });
					const result = await call("connect", { body: body ?? {} });
					set({ busy: false });
					if (result.error !== undefined) {
						set({ error: result.error });
						return null;
					}
					return result.authorizationUrl;
				},
				async cancel() {
					set({ busy: true });
					await call("cancel", { body: {} });
					set({ busy: false });
					await refresh({});
				},
				async disconnect() {
					set({ busy: true, error: null });
					const result = await call("disconnect", { body: {} });
					set({ busy: false });
					if (result.error !== undefined) {
						set({ error: result.error });
						return;
					}
					await refresh({});
				},
				/** Record a popup-blocked authorization URL so the panel can offer the link. */
				notifyBlocked(url) {
					set({ blockedUrl: url, notice: null });
				},
				openManually(url) {
					if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
				},
				clearNotice() {
					set({ notice: null });
				},
			};
		}

		/** Subscribe a component to the store. */
		function useStore(store) {
			const [, force] = React.useReducer((n) => n + 1, 0);
			React.useEffect(() => store.subscribe(force), [store]);
			return store.getSnapshot();
		}

		/** A labelled status row. */
		function Field(props) {
			return React.createElement(
				"div",
				{ className: "figma-field" },
				React.createElement("span", { className: "figma-field-label" }, props.label),
				React.createElement("span", { className: "figma-field-value" }, props.children),
			);
		}

		/** A small copy-to-clipboard control for a value the user must paste elsewhere. */
		function CopyButton(props) {
			const [copied, setCopied] = React.useState(false);
			return React.createElement(
				Button,
				{
					size: "small",
					variant: "secondary",
					onClick: async () => {
						const ok = await copyText(props.value);
						if (ok) {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						}
					},
				},
				copied ? props.copiedLabel : props.label,
			);
		}

		/** A read-only value with a copy affordance, used for the redirect URL. */
		function CopyField(props) {
			return React.createElement(
				"div",
				{ className: "figma-copy-row" },
				React.createElement("code", { className: "figma-code" }, props.value),
				props.onCopy === undefined
					? React.createElement(CopyButton, props)
					: React.createElement(Button, { size: "small", variant: "secondary", onClick: props.onCopy }, props.copyLabel),
			);
		}

		/**
		 * The OAuth client setup form.
		 *
		 * Shown when no Client ID/Secret pair is configured, because nothing else
		 * in the panel can work until the user creates their own Figma OAuth app.
		 * The redirect URL is presented first and verbatim: Figma matches it
		 * exactly, and getting it wrong is the most common setup failure.
		 */
		function SetupForm(props) {
			const { t, store, status } = props;
			const [clientId, setClientId] = React.useState(status.clientId ?? "");
			const [clientSecret, setClientSecret] = React.useState("");
			const [saved, setSaved] = React.useState(false);
			const busy = useStore(store).busy;

			return React.createElement(
				"div",
				{ className: "figma-setup" },
				React.createElement("h3", { className: "figma-setup-title" }, t("setupTitle")),
				React.createElement("p", { className: "figma-muted" }, t("setupDesc")),
				React.createElement(
					"ol",
					{ className: "figma-steps" },
					React.createElement("li", null, t("setupStep1")),
					React.createElement("li", null, t("setupStep2")),
					React.createElement("li", null, t("setupStep3")),
				),
				React.createElement(
					"div",
					{ className: "figma-redirect" },
					React.createElement("span", { className: "figma-field-label" }, t("redirectUri")),
					React.createElement(CopyField, {
						value: status.redirectUri,
						label: t("copy"),
						copiedLabel: t("copied"),
					}),
					React.createElement("span", { className: "figma-hint" }, t("redirectHint")),
				),
				React.createElement(
					Button,
					{
						size: "small",
						variant: "secondary",
						onClick: () => window.open("https://www.figma.com/developers/apps", "_blank", "noopener"),
					},
					t("openAppsPage"),
				),
				React.createElement(
					"div",
					{ className: "figma-form" },
					React.createElement(
						"label",
						{ className: "figma-input-row" },
						React.createElement("span", { className: "figma-field-label" }, t("clientId")),
						React.createElement("input", {
							className: "figma-input",
							type: "text",
							value: clientId,
							placeholder: t("clientIdPlaceholder"),
							spellCheck: false,
							autoComplete: "off",
							onChange: (event) => setClientId(event.target.value),
						}),
					),
					React.createElement(
						"label",
						{ className: "figma-input-row" },
						React.createElement("span", { className: "figma-field-label" }, t("clientSecret")),
						React.createElement("input", {
							className: "figma-input",
							type: "password",
							value: clientSecret,
							placeholder: t("clientSecretPlaceholder"),
							autoComplete: "off",
							onChange: (event) => setClientSecret(event.target.value),
						}),
					),
					React.createElement("span", { className: "figma-hint" }, t("clientSecretHint")),
					React.createElement(
						"div",
						{ className: "figma-actions" },
						React.createElement(
							Button,
							{
								variant: "primary",
								disabled: busy || (clientId.trim() === "" && clientSecret.trim() === ""),
								onClick: async () => {
									const ok = await store.saveClient(clientId, clientSecret);
									if (ok) {
										setSaved(true);
										setClientSecret("");
										setTimeout(() => setSaved(false), 1500);
									}
								},
							},
							saved ? t("saved") : t("save"),
						),
					),
				),
			);
		}

		/**
		 * The connection panel, shared by the settings page and the popover.
		 *
		 * `compact` drops the explanatory copy for the narrow sidebar seat.
		 */
		function ConnectionPanel(props) {
			const { t, store, compact } = props;
			const state = useStore(store);
			const status = state.status;

			if (status === null) {
				return React.createElement(
					"div",
					{ className: "figma-panel" },
					state.error === null
						? React.createElement(
								"p",
								{ className: "figma-pending" },
								React.createElement("span", { className: "figma-spinner" }),
								t("loading"),
							)
						: React.createElement("p", { className: "figma-error" }, `${t("error")}: ${state.error}`),
				);
			}

			const connected = status.connected === true;
			const pending = status.pending;
			const isPending = pending !== null && pending !== undefined && pending.status === "pending";
			const account = status.account;
			const notice = state.notice;

			const modeLabel = status.mode === "oauth" ? t("modeOauth") : status.mode === "pat" ? t("modePat") : t("disconnected");

			const children = [];

			children.push(
				React.createElement(
					"div",
					{ className: "figma-status-row", key: "head" },
					React.createElement("span", {
						className: `figma-dot ${connected ? "is-on" : "is-off"}`,
						style: connected ? { background: "var(--dsw-alias-state-success-primary)" } : undefined,
					}),
					React.createElement("span", { className: "figma-status-text" }, connected ? t("connected") : t("disconnected")),
					React.createElement("span", { className: "figma-tag" }, modeLabel),
				),
			);

			if (connected && status.mode === "oauth") {
				children.push(
					React.createElement(
						Field,
						{ label: t("connectedAs"), key: "account" },
						account === undefined || account === null
							? t("accountUnknown")
							: account.handle !== undefined
								? `${account.handle}${account.email ? ` <${account.email}>` : ""}`
								: account.note ?? t("accountUnknown"),
					),
					React.createElement(Field, { label: t("expiresAt"), key: "expiry" }, expiryText(t, status.expiresAt)),
				);
			}

			if (connected && status.mode === "pat") {
				children.push(React.createElement("p", { className: "figma-muted", key: "pat" }, t("patNote")));
			}

			if (!connected && compact !== true) {
				children.push(React.createElement("p", { className: "figma-muted", key: "hint" }, t("disconnectedHint")));
			}

			if (status.oauthSupported !== true) {
				children.push(React.createElement("p", { className: "figma-warn", key: "nostore" }, t("noStore")));
			}

			if (isPending) {
				children.push(
					React.createElement(
						"p",
						{ className: "figma-pending", key: "pending" },
						React.createElement("span", { className: "figma-spinner" }),
						t("waiting"),
					),
				);
			} else if (notice !== null) {
				children.push(
					React.createElement("p", { className: "figma-notice", key: "notice" }, notice),
				);
			}

			// A popup-blocked authorization must still be completable, so the
			// exact URL stays reachable until the user opens it.
			if (state.blockedUrl !== null && state.blockedUrl !== undefined) {
				children.push(
					React.createElement(
						"div",
						{ className: "figma-blocked", key: "blocked" },
						React.createElement("p", { className: "figma-warn" }, t("popupBlocked")),
						React.createElement(CopyField, {
							value: state.blockedUrl,
							label: t("copy"),
							copiedLabel: t("copied"),
							onCopy: () => store.openManually(state.blockedUrl),
							copyLabel: t("openLink"),
						}),
					),
				);
			}

			if (state.error !== null) {
				children.push(React.createElement("p", { className: "figma-error", key: "error" }, `${t("error")}: ${state.error}`));
			}

			// The client setup gates everything else, so it comes first when missing.
			const needsSetup = status.oauthSupported === true && status.clientConfigured !== true;
			if (needsSetup) {
				children.push(React.createElement(SetupForm, { t, store, status, key: "setup" }));
			}

			const actions = [];
			if (status.oauthSupported === true && !needsSetup) {
				if (isPending) {
					actions.push(
						React.createElement(Button, { key: "cancel", variant: "secondary", disabled: state.busy, onClick: () => store.cancel() }, t("cancel")),
					);
				} else {
					actions.push(
						React.createElement(
							Button,
							{
								key: "connect",
								variant: connected ? "secondary" : "primary",
								disabled: state.busy,
								onClick: () => startAuthorization(t, store),
							},
							connected ? t("reconnect") : t("connect"),
						),
					);
				}
			}
			if (status.canDisconnect === true) {
				actions.push(
					React.createElement(Button, { key: "disconnect", variant: "secondary", disabled: state.busy, onClick: () => store.disconnect() }, t("disconnect")),
				);
			}
			actions.push(
				React.createElement(Button, { key: "refresh", variant: "ghost", disabled: state.busy, onClick: () => store.refresh({ verify: true }) }, t("refresh")),
			);
			children.push(React.createElement("div", { className: "figma-actions", key: "actions" }, actions));

			if (connected && status.mode === "pat" && status.oauthSupported === true) {
				children.push(React.createElement("p", { className: "figma-hint", key: "pathint" }, t("patConnectHint")));
			}

			if (compact !== true) {
				children.push(
					React.createElement(
						"details",
						{ className: "figma-advanced", key: "advanced" },
						React.createElement("summary", null, t("advanced")),
						React.createElement(
							Field,
							{ label: t("redirectUri") },
							React.createElement(CopyField, { value: status.redirectUri, label: t("copy"), copiedLabel: t("copied") }),
						),
						React.createElement(Field, { label: t("clientId") }, status.clientId ?? "—"),
						React.createElement(
							Field,
							{ label: t("clientSecret") },
							status.clientSecretSet ? t("secretConfigured") : t("secretMissing"),
						),
						React.createElement(Field, { label: t("scopes") }, React.createElement("code", { className: "figma-code" }, status.scopes)),
					),
				);
			}

			return React.createElement("div", { className: "figma-panel" }, children);
		}

		/**
		 * Start authorization in a new tab.
		 *
		 * Figma's consent page must run in a real browser, and the callback
		 * arrives on this process, so opening a tab is exactly right. The store
		 * then polls until the attempt settles.
		 */
		async function startAuthorization(t, store) {
			const url = await store.connect({});
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

		/** The settings page: the full control surface. */
		function FigmaSection(props) {
			const store = props.store;
			const t = props.t;
			React.useEffect(() => {
				store.refresh({ verify: true });
			}, [store]);
			return React.createElement(
				"div",
				{ className: "figma-section" },
				React.createElement("h2", { className: "figma-section-title" }, t("sectionTitle")),
				React.createElement("p", { className: "figma-section-desc" }, t("sectionDesc")),
				React.createElement(ConnectionPanel, { t, store }),
			);
		}

		/**
		 * The sidebar status action: state at a glance, one click to act.
		 *
		 * It sits beside the Settings button so the connection state is visible
		 * from anywhere in the GUI without opening a panel.
		 */
		function FigmaStatusAction(props) {
			const store = props.store;
			const t = props.t;
			const wide = props.wide === true;
			const state = useStore(store);
			const [open, setOpen] = React.useState(false);
			const status = state.status;
			const connected = status !== null && status.connected === true;

			const label = status === null ? t("nav") : connected ? t("connected") : t("disconnected");

			const button = React.createElement(
				"button",
				{
					type: "button",
					className: `figma-sidebar-action${wide ? " is-wide" : ""}`,
					onClick: () => setOpen((value) => !value),
					"aria-label": `${t("nav")}: ${label}`,
					title: `${t("nav")} — ${label}`,
				},
				React.createElement("span", {
					className: `figma-dot ${connected ? "is-on" : "is-off"}`,
					style: connected ? { background: "var(--dsw-alias-state-success-primary)" } : undefined,
				}),
				wide ? React.createElement("span", { className: "figma-sidebar-label" }, t("nav")) : null,
			);

			if (!open) {
				return Tooltip === undefined
					? button
					: React.createElement(Tooltip, { content: `${t("nav")} — ${label}` }, button);
			}

			const popover = React.createElement(
				"div",
				{ className: "figma-popover" },
				React.createElement(
					"div",
					{ className: "figma-popover-head" },
					React.createElement("strong", null, t("nav")),
					React.createElement(
						"button",
						{ type: "button", className: "figma-popover-close", onClick: () => setOpen(false), "aria-label": t("close") },
						"×",
					),
				),
				React.createElement(ConnectionPanel, { t, store, compact: true }),
			);

			return React.createElement(
				"div",
				{ className: "figma-popover-host" },
				button,
				popover,
			);
		}

		/** Styles, injected once and owned by this plugin's fiber. */
		const CSS = `
.figma-section { display: flex; flex-direction: column; gap: .5rem; }
.figma-section-title { margin: 0; font-size: 1rem; font-weight: 600; color: var(--dsw-alias-label-primary); }
.figma-section-desc { margin: 0 0 .5rem; font-size: .8125rem; color: var(--dsw-alias-label-secondary); }
.figma-panel { display: flex; flex-direction: column; gap: .75rem; }
.figma-status-row { display: flex; align-items: center; gap: .5rem; }
.figma-status-text { font-weight: 600; color: var(--dsw-alias-label-primary); }
.figma-dot { width: .5rem; height: .5rem; border-radius: 999px; flex: none; background: var(--dsw-alias-label-tertiary, #8a8f98); }
.figma-dot.is-on { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent); }
.figma-tag { font-size: .6875rem; padding: .1rem .4rem; border-radius: .25rem; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.figma-field { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; font-size: .8125rem; }
.figma-field-label { color: var(--dsw-alias-label-secondary); flex: none; }
.figma-field-value { color: var(--dsw-alias-label-primary); text-align: right; word-break: break-all; }
.figma-muted { margin: 0; font-size: .8125rem; color: var(--dsw-alias-label-secondary); }
.figma-hint { font-size: .75rem; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.figma-warn { margin: 0; font-size: .8125rem; color: var(--dsw-alias-state-warn-primary); }
.figma-error { margin: 0; font-size: .8125rem; color: var(--dsw-alias-state-error-primary); }
.figma-notice { margin: 0; font-size: .8125rem; color: var(--dsw-alias-label-primary); }
.figma-pending { display: flex; align-items: center; gap: .5rem; margin: 0; font-size: .8125rem; color: var(--dsw-alias-label-secondary); }
.figma-spinner { width: .75rem; height: .75rem; border-radius: 999px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: figma-spin .8s linear infinite; flex: none; }
@keyframes figma-spin { to { transform: rotate(360deg); } }
.figma-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.figma-code { font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, monospace); font-size: .75rem; word-break: break-all; }
.figma-copy-row { display: flex; align-items: center; gap: .5rem; justify-content: flex-end; flex-wrap: wrap; }
.figma-copy-row .figma-code { padding: .15rem .35rem; border-radius: .25rem; background: var(--dsw-alias-markdown-inline-code, rgba(127,127,127,.14)); }
.figma-setup { display: flex; flex-direction: column; gap: .6rem; padding: .875rem; border: 1px solid var(--dsw-alias-border-l1); border-radius: .5rem; background: var(--dsw-alias-bg-layer-1); }
.figma-setup-title { margin: 0; font-size: .875rem; font-weight: 600; color: var(--dsw-alias-label-primary); }
.figma-steps { margin: 0; padding-left: 1.1rem; font-size: .8125rem; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: .25rem; }
.figma-redirect { display: flex; flex-direction: column; gap: .35rem; }
.figma-form { display: flex; flex-direction: column; gap: .5rem; }
.figma-input-row { display: flex; flex-direction: column; gap: .25rem; }
.figma-input { width: 100%; box-sizing: border-box; padding: .4rem .5rem; font-size: .8125rem; border-radius: .375rem; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.figma-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.figma-advanced { font-size: .8125rem; color: var(--dsw-alias-label-secondary); }
.figma-advanced > summary { cursor: pointer; }
.figma-advanced > * { margin-top: .4rem; }
.figma-sidebar-action { display: flex; align-items: center; gap: .5rem; width: 100%; padding: .35rem .5rem; border: 0; border-radius: .375rem; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: .8125rem; }
.figma-sidebar-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.figma-sidebar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.figma-popover-host { position: relative; }
.figma-popover { position: absolute; bottom: calc(100% + .5rem); left: 0; z-index: 40; width: 20rem; max-width: 80vw; padding: .875rem; display: flex; flex-direction: column; gap: .6rem; border-radius: .5rem; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.28)); }
.figma-popover-head { display: flex; align-items: center; justify-content: space-between; }
.figma-popover-close { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 .25rem; }
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
				store.startPolling();
				return () => store.dispose();
			}, "dsh-figma: connection store");

			// The full control surface, as its own Settings page.
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
					FigmaSection,
				),
			);

			// The at-a-glance state, beside the Settings button.
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "figma",
						order: 30,
						label: () => t("nav"),
						locale: NS,
						inject: () => ({ t, store }),
					},
					FigmaStatusAction,
				),
			);
		}

		exports.name = "dsh-figma";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
