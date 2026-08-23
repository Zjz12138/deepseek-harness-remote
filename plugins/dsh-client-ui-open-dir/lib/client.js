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
		//#region dsh-desktop: 按钮文案（occupant 组件没有稳定 t seat，直接按语言硬编码）
		const zh = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "");
		const OPEN_DIR_LABEL = zh ? "打开当前工作区文件夹" : "Open current workspace folder";
		const OPEN_DIR_TEXT = zh ? "打开文件夹" : "Open folder";
		//#endregion
		//#region lib/types/client/index.js
		/** Services required by this plugin. */
		const inject = ["slots", "sessions"];
		/**
		 * Sidebar footer action button: opens the current session's workspace
		 * folder on the host machine. The button only needs to read state at
		 * click time, so it stays a plain component fed a closure over ctx.
		 */
		function FooterButton(props) {
			const { wide, openDir } = props;
			return react_jsx_runtime.jsx(_primitives.Tooltip, {
				label: OPEN_DIR_LABEL,
				delayMs: 500,
				disabled: wide,
				children: react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dshOpenDirBtn" + (wide ? " dshOpenDirBtnWide" : ""),
					"aria-label": OPEN_DIR_LABEL,
					title: OPEN_DIR_LABEL,
					onClick: openDir,
					children: [
						react_jsx_runtime.jsx(_primitives.IconFolderOpenOutline16, { size: wide ? 14 : 18 }),
						wide && react_jsx_runtime.jsx("span", { children: OPEN_DIR_TEXT })
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
		/**
		 * Client plugin body: contribute into the sidebar footer action list slot.
		 * The occupant pattern (per dsh-client-ui-directory-picker-native):
		 *   - slots.inject(<declared slot name>, generator) waits for the slot
		 *     declaration (the sidebar entry) to exist, then runs the registration;
		 *   - slots.register's `name` MUST be the already-declared slot name
		 *     ("sidebar.footer.action"), never a fresh name — registering a new
		 *     name that no parent children table declares fails with
		 *     'slot "…" is not declared'.
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", function* () {
				yield ctx.slots.register({
					name: "sidebar.footer.action",
					// kind "list" slot 的 occupant 必须带 id（在列表里标识自己）
					id: "dsh-client-ui-open-dir",
					inject: () => ({
						openDir: () => openCurrentWorkspaceDir(ctx)
					})
				}, FooterButton);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
