window.__ModuleLoader__.load({
	id: "dsh-client-ui-open-dir",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region dsh-desktop: 侧边栏"打开当前工作区文件夹"按钮样式
		const css = ".dshOpenDirBtn{display:flex;align-items:center;justify-content:center;gap:6px;width:28px;height:28px;margin:0 auto;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:20px}.dshOpenDirBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshOpenDirBtnWide{width:100%;margin:0 2px;justify-content:flex-start;padding:0 8px}";
		const tagId = "dsh-client-ui-open-dir/style.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-client-ui-open-dir";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** `openDir` namespace dictionaries. */
		const zh = {
			"open.dir": "打开文件夹",
			"open.dir.label": "打开当前工作区文件夹"
		};
		const en = {
			"open.dir": "Open folder",
			"open.dir.label": "Open current workspace folder"
		};
		//#endregion
		//#region lib/types/client/index.js
		const NS = "openDir";
		/** Services required by this plugin. */
		const inject = ["slots", "sessions", "locale"];
		/**
		 * Sidebar footer action button: opens the current workspace folder on the
		 * host machine. The button only needs to read state at click time, so it
		 * stays a plain component fed a closure over the client ctx.
		 */
		function FooterButton(props) {
			const { wide, openDir, t } = props;
			return react_jsx_runtime.jsx(_primitives.Tooltip, {
				label: t("open.dir.label"),
				delayMs: 500,
				disabled: wide,
				children: react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dshOpenDirBtn" + (wide ? " dshOpenDirBtnWide" : ""),
					"aria-label": t("open.dir.label"),
					title: t("open.dir.label"),
					onClick: openDir,
					children: [
						react_jsx_runtime.jsx(_primitives.IconFolderOpenOutline16, { size: wide ? 14 : 18 }),
						wide && react_jsx_runtime.jsx("span", { children: t("open.dir") })
					]
				})
			});
		}
		/** Open the current session's workspace directory via the desktop shell. */
		function openCurrentWorkspaceDir(ctx) {
			try {
				const list = ctx.sessions.list.getSnapshot();
				const currentId = list.current;
				const entry = currentId === void 0 ? void 0 : list.byId[currentId];
				const cwd = entry && entry.cwd;
				if (cwd) {
					// dsh-desktop shell listens in preload.js → ipcRenderer('open-session-dir')
					// → main.js shell.openPath. In a plain browser there is no listener; no-op.
					window.dispatchEvent(new CustomEvent("dsh-open-session-dir", { detail: { path: cwd } }));
				}
			} catch {}
		}
		/** Registers the sidebar footer contribution. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "open-dir: dictionaries");
			ctx.effect(() => ctx.slots.register({
				name: "dsh-client-ui-open-dir",
				locale: NS,
				children: {
					"sidebar.footer.action": {
						kind: "list",
						scope: "root"
					}
				},
				inject: () => ({
					openDir: () => openCurrentWorkspaceDir(ctx)
				})
			}, FooterButton), "open-dir: slot registration");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
