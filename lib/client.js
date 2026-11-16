window.__ModuleLoader__.load({
	id: "dsh-floating-assistant",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/shared/protocol.ts
		/** 插件自有 HTTP 路由前缀（host half 注册，client half fetch）。 */
		const API_PREFIX = "/api/dsh-floating-assistant";
		/** 一次划词请求允许的最大字符数（超出直接拒绝，避免意外把整篇文档塞给模型）。 */
		const MAX_SELECTION_LENGTH = 12e3;
		/** 上下文段落允许的最大字符数（系统级取词用 UIA 读选区所在段落，超长直接截断）。 */
		const MAX_CONTEXT_LENGTH = 4e3;
		/** 解析一帧 SSE 的 data 负载；不是本协议的帧返回 undefined。 */
		function parseRunEvent(raw) {
			try {
				const value = JSON.parse(raw);
				if (value === null || typeof value !== "object") return void 0;
				if (typeof value.type !== "string") return void 0;
				return value;
			} catch {
				return;
			}
		}
		/** "跟随原文自动"（中文→英文，其余→中文）——保留旧行为的那个选项。 */
		const AUTO_LANGUAGE_ID = "auto";
		/** 可选语言（覆盖常用语种；加语言只需在这里加一行）。 */
		const LANGUAGES = [
			{
				id: "zh-Hans",
				label: "简体中文",
				prompt: "Simplified Chinese"
			},
			{
				id: "zh-Hant",
				label: "繁體中文",
				prompt: "Traditional Chinese"
			},
			{
				id: "en",
				label: "English",
				prompt: "English"
			},
			{
				id: "ja",
				label: "日本語",
				prompt: "Japanese"
			},
			{
				id: "ko",
				label: "한국어",
				prompt: "Korean"
			},
			{
				id: "fr",
				label: "Français",
				prompt: "French"
			},
			{
				id: "de",
				label: "Deutsch",
				prompt: "German"
			},
			{
				id: "es",
				label: "Español",
				prompt: "Spanish"
			},
			{
				id: "pt",
				label: "Português",
				prompt: "Portuguese"
			},
			{
				id: "ru",
				label: "Русский",
				prompt: "Russian"
			},
			{
				id: "it",
				label: "Italiano",
				prompt: "Italian"
			},
			{
				id: "nl",
				label: "Nederlands",
				prompt: "Dutch"
			},
			{
				id: "pl",
				label: "Polski",
				prompt: "Polish"
			},
			{
				id: "sv",
				label: "Svenska",
				prompt: "Swedish"
			},
			{
				id: "tr",
				label: "Türkçe",
				prompt: "Turkish"
			},
			{
				id: "uk",
				label: "Українська",
				prompt: "Ukrainian"
			},
			{
				id: "ar",
				label: "العربية",
				prompt: "Arabic"
			},
			{
				id: "he",
				label: "עברית",
				prompt: "Hebrew"
			},
			{
				id: "fa",
				label: "فارسی",
				prompt: "Persian"
			},
			{
				id: "hi",
				label: "हिन्दी",
				prompt: "Hindi"
			},
			{
				id: "bn",
				label: "বাংলা",
				prompt: "Bengali"
			},
			{
				id: "th",
				label: "ไทย",
				prompt: "Thai"
			},
			{
				id: "vi",
				label: "Tiếng Việt",
				prompt: "Vietnamese"
			},
			{
				id: "id",
				label: "Bahasa Indonesia",
				prompt: "Indonesian"
			},
			{
				id: "ms",
				label: "Bahasa Melayu",
				prompt: "Malay"
			}
		];
		/** 取语言选项（未知 id 返回 undefined）。 */
		function languageById(id) {
			return LANGUAGES.find((item) => item.id === id);
		}
		/** 解释规则默认文本。 */
		const DEFAULT_EXPLAIN_RULES = [
			"- 结合语境解释选中的文本：它指什么、在这里起什么作用。",
			"- 先用一两句话说明它的含义，再分小节说明关键概念与背景；如果是代码，说明它的作用与执行过程。",
			"- 用 Markdown 组织回答，简洁准确，不要整段复述选中的文本或上文。",
			"- 不要评论有没有提供上文、也不要说明你是怎么判断语境的，直接给出解释。",
			"- 这是一次独立请求：只解释选中的文本，不要提及或评论任何先前的对话内容。"
		].join("\n");
		/**
		* 翻译规则默认文本。
		*
		* 词/短语按词典条目给（最佳翻译 + 音标 + 其他翻译 + 术语说明），句子/段落给整段译文
		* 并额外解释其中的关键术语与缩写——这些都靠规则驱动，模型自己判断是词还是句。
		*/
		const DEFAULT_TRANSLATE_RULES = [
			"- 先判断选中的是「词/短语」还是「句子/段落」，按对应格式输出。",
			"- 词或短语：按词典条目排版——",
			"  - 第一行：**最佳翻译**（最贴合当前语境的那一个译法）。",
			"  - 第二行：读音，写成 `英 /…/　美 /…/`（国际音标；中文等非表音文字可省略这一行）。",
			"  - 空一行后给 `其他翻译`：2~4 个其他义项，每条一行，写成 `- 译法 — 词性/领域，什么时候用`。",
			"  - 如果它是关键术语或缩写：再给一小节 `术语说明`，缩写先写全称，再用一句话说明它指什么。",
			"- 句子或段落：先给完整译文；如果句中出现了关键术语、缩写或专有名词，再追加小节 `关键术语`，逐条给出全称与一句解释（没有就不写这一节，不要硬凑）。",
			"- 只输出译文与上述小节：不要前言、不要复述原文、不要说明你是怎么判断词还是句子的。",
			"- 保留原文的格式、换行、行内代码与专有名词；如果原文已经是目标语言，原样返回。"
		].join("\n");
		/** 总结规则默认文本。 */
		const DEFAULT_SUMMARIZE_RULES = [
			"- 先用一句话给出核心结论，再分「要点」小节逐条列出关键信息（每条一行，最多 5 条）。",
			"- 如果原文有明确的结构（章节、列表、对话轮次），保留它的大致层次再压缩。",
			"- 只保留原文真正说了的内容：不要补充背景知识，不要评价好坏，不要给建议。",
			"- 数字、专有名词、结论性判断必须原样保留，不要模糊成「一些」「若干」。",
			"- 用 Markdown 组织回答；原文很短时直接给一句话总结，不要硬凑要点。",
			"- 这是一次独立请求：只总结选中的文本，不要提及或评论任何先前的对话内容。"
		].join("\n");
		/** 默认设置。 */
		const DEFAULT_SETTINGS = {
			engine: "direct",
			targetLanguage: AUTO_LANGUAGE_ID,
			fallbackLanguage: AUTO_LANGUAGE_ID,
			explainRules: DEFAULT_EXPLAIN_RULES,
			translateRules: DEFAULT_TRANSLATE_RULES,
			summarizeRules: DEFAULT_SUMMARIZE_RULES,
			translateModel: null,
			explainModel: null,
			summarizeModel: null,
			crossProviderFallback: true,
			/** 兜底模型默认留空，由用户自己选；为空时不跨 provider 兜底。 */
			fallbackModel: null,
			askIncludeContext: true,
		answerStyle: "standard",
		customPersona: "",
			/** 翻译通道：bing / google 走匿名机译，llm 走下面的模型座位。 */
			translateEngine: "bing"
		};
		/** 规则文本上限（避免把提示词撑爆）。 */
		const MAX_RULES_LENGTH = 4e3;
		/**
		* 把任意输入规整成合法设置（缺项补默认、非法值丢弃）。
		* 主客两边共用：客户端在提交前也用它做一次本地校验。
		*/
		function normalizeSettings(input) {
			const raw = input ?? {};
			const language = (value, fallback) => {
				const id = typeof value === "string" ? value : "";
				if (id === "auto") return id;
				return languageById(id) === void 0 ? fallback : id;
			};
			const rules = (value, fallback) => {
				if (typeof value !== "string") return fallback;
				const text = value.replace(/\r\n/g, "\n").trim();
				if (text === "") return fallback;
				return text.length > 4e3 ? text.slice(0, MAX_RULES_LENGTH) : text;
			};
			const seat = (value) => {
				if (value === null || value === void 0 || typeof value !== "object") return null;
				const candidate = value;
				const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
				const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
				if (provider === "" || model === "") return null;
				const effort = typeof candidate.reasoningEffort === "string" ? candidate.reasoningEffort.trim() : "";
				return {
					provider,
					model,
					...effort === "" ? {} : { reasoningEffort: effort }
				};
			};
			const number = (value, fallback, range) => {
				const parsed = typeof value === "number" ? value : NaN;
				if (!Number.isFinite(parsed)) return fallback;
				return Math.max(range.min, Math.min(range.max, Math.round(parsed)));
			};
			return {
				engine: raw.engine === "agent" ? "agent" : "direct",
				targetLanguage: language(raw.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
				fallbackLanguage: language(raw.fallbackLanguage, DEFAULT_SETTINGS.fallbackLanguage),
				explainRules: rules(raw.explainRules, DEFAULT_SETTINGS.explainRules),
				translateRules: rules(raw.translateRules, DEFAULT_SETTINGS.translateRules),
				summarizeRules: rules(raw.summarizeRules, DEFAULT_SETTINGS.summarizeRules),
				translateModel: seat(raw.translateModel),
				explainModel: seat(raw.explainModel),
				summarizeModel: seat(raw.summarizeModel),
				crossProviderFallback: raw.crossProviderFallback !== false,
				fallbackModel: raw.fallbackModel === null ? null : seat(raw.fallbackModel) ?? seat(DEFAULT_SETTINGS.fallbackModel),
				askIncludeContext: raw.askIncludeContext !== false,
		answerStyle: raw.answerStyle === "concise" || raw.answerStyle === "detailed" ? raw.answerStyle : "standard",
		customPersona: typeof raw.customPersona === "string" ? raw.customPersona.replace(/\r\n/g, "\n").trim().slice(0, 500) : "",
				translateEngine: raw.translateEngine === "llm" || raw.translateEngine === "google" ? raw.translateEngine : "bing"
			};
		}
		//#endregion
		//#region src/client/api.ts
		/**
		* 浏览器半边对宿主插件路由的调用层：同源 fetch + SSE 帧解析，
		* 外加从官方 client 服务读取「当前会话/当前模型」的只读快照。
		*/
		/** 从字符串里取第一个非空字符串字段。 */
		function pickString(value) {
			return typeof value === "string" && value !== "" ? value : void 0;
		}
		/**
		* 读取当前会话的 cwd 与生效模型（与 DSH 输入框模型座位同源）。
		* 任何一步缺席都安静降级——宿主会回落到部署默认模型。
		* @param ctx - 客户端 Cordis 上下文。
		*/
		function readCurrentContext(ctx) {
			const result = {};
			try {
				const snapshot = (ctx.get?.("sessions"))?.list?.getSnapshot?.();
				const current = pickString(snapshot?.current);
				if (current === void 0) return result;
				result.sessionId = current;
				result.cwd = pickString(snapshot?.byId?.[current]?.cwd);
				const selection = ctx.get?.("modelDirectories")?.directoryFor?.(current)?.store?.getSnapshot?.()?.current;
				result.provider = pickString(selection?.provider);
				result.model = pickString(selection?.model);
			} catch {}
			return result;
		}
		/** 界面语言：与宿主 html lang / 浏览器语言一致。 */
		function detectLocale() {
			try {
				const lang = String(document?.documentElement?.lang ?? "");
				if (lang.toLowerCase().startsWith("zh")) return "zh";
				if (lang !== "") return "en";
				return String(navigator?.language ?? "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
			} catch {
				return "zh";
			}
		}
		/**
		 * 非 2xx 响应转成可读错误：优先 JSON 的 message/error，其次原始文本，最后 HTTP 状态。
		 */
		async function responseError(response) {
			let raw = "";
			try {
				raw = await response.text();
			} catch {
				raw = "";
			}
			if (raw !== "") {
				try {
					const parsed = JSON.parse(raw);
					const message = typeof parsed?.message === "string" ? parsed.message : typeof parsed?.error === "string" ? parsed.error : "";
					if (message.trim() !== "") return message.trim();
				} catch {}
				const text = raw.trim();
				if (text !== "") return text.slice(0, 300);
			}
			return `HTTP ${response.status}`;
		}


		/**
		* 发起一轮划词翻译/解释。
		* @param action - 菜单动作。
		* @param text - 选中文本。
		* @param ctx - 客户端上下文（读取当前会话）。
		* @param context - 选中文本所在的上下文段落（页内路径取块级元素文本；没有就传空串）。
		* @returns abort：中止本次流（宿主侧仍会跑完，除非另行调用 stop）。
		*/
		function startRun(action, text, ctx, context, handlers) {
			const controller = new AbortController();
			let sessionId;
			const session = readCurrentContext(ctx);
			const trimmed = typeof context === "string" ? context.trim() : "";
			const request = {
				action,
				text,
				locale: detectLocale(),
				...trimmed === "" ? {} : { context: trimmed.slice(0, MAX_CONTEXT_LENGTH) },
				...session.cwd === void 0 ? {} : { cwd: session.cwd },
				...session.provider === void 0 ? {} : { provider: session.provider },
				...session.model === void 0 ? {} : { model: session.model }
			};
			(async () => {
				try {
					const response = await fetch(`${API_PREFIX}/run`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(request),
						signal: controller.signal
					});
					if (!response.ok) {
						handlers.onError(await responseError(response));
						return;
					}
					if (response.body === null) {
						handlers.onError("response body is not streamable");
						return;
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					for (;;) {
						const { value, done } = await reader.read();
						if (done === true) break;
						buffer += decoder.decode(value, { stream: true });
						let boundary = buffer.indexOf("\n\n");
						while (boundary !== -1) {
							const frame = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);
							const payload = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
							const event = payload === "" ? void 0 : parseRunEvent(payload);
							if (event?.type === "session") {
								sessionId = event.sessionId;
								handlers.onSession?.(event.sessionId);
							} else if (event?.type === "delta") handlers.onDelta(event.text);
							else if (event?.type === "done") {
								sessionId = event.sessionId;
								handlers.onDone(event.text, event.sessionId, event);
							} else if (event?.type === "error") handlers.onError(event.message);
							boundary = buffer.indexOf("\n\n");
						}
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					handlers.onError(error instanceof Error ? error.message : String(error));
				}
			})();
			return {
				abort: () => controller.abort(),
				sessionId: () => sessionId
			};
		}
		/** 请求宿主停止某条会话上正在跑的一轮（与官方 Stop 走同一条 agent.cancel）。 */
		async function stopRun(sessionId) {
			if (sessionId === void 0) return;
			try {
				await fetch(`${API_PREFIX}/stop`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				});
			} catch {}
		}
		/** 「问问」引用里上文的最大长度：输入框不是阅读器，带一个自然段就够。 */
		const ASK_CONTEXT_LIMIT = 1500;
		/**
		* 这次「问问」该不该附带上文、附多少。
		*
		* 会话里的 agent 看不到你刚在哪儿读的这段文字，碎片（术语、半句代码、代词）
		* 没有上文就只能反问。但两种情况带上反而是噪音：
		* - 选区本身就覆盖了整段（上文 ≈ 选区）；
		* - 上文只比选区多几个字（比如只多了一个句号）。
		* 其余情况截到 {@link ASK_CONTEXT_LIMIT}，避免把输入框撑得太长。
		* @param text - 选中的原文。
		* @param context - 选区所在的段落（没有就传空）。
		* @returns 要附上的上文；空串表示不附。
		*/
		function contextForQuote(text, context) {
			const plain = typeof context === "string" ? context.replace(/\r\n?/g, "\n").trim() : "";
			if (plain === "") return "";
			const source = String(text).replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
			if (plain === source) return "";
			if (source !== "" && plain.length <= source.length * 1.15 + 16) return "";
			return plain.length > ASK_CONTEXT_LIMIT ? plain.slice(0, ASK_CONTEXT_LIMIT) : plain;
		}
		/**
		* 把选中的文字包成"引用"放进输入框的形式。
		*
		* 每行加 `> ` 前缀、末尾空一行：用户接在引用下面直接提问，读起来就是
		* 一条引用 + 一个问题（DSH 输入框是纯文本，没有引用块，这是最接近的形态）。
		* 上下文（选区所在的段落）作为第二段引用附在后面，并显式标注"仅作语境"，
		* 免得模型把它当成要回答的内容。
		* @param text - 选中的原文。
		* @param context - 选区所在的段落（没有就传空，行为与旧版一致）。
		* @returns 可直接填进输入框的草稿。
		*/
		function quoteForInput(text, context) {
			const normalized = String(text).replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
			const quoted = normalized.split("\n").map((line) => line === "" ? ">" : `> ${line}`).join("\n");
			const extra = contextForQuote(normalized, context);
			if (extra === "") return `${quoted}\n\n`;
			const quotedExtra = extra.split("\n").map((line) => line === "" ? ">" : `> ${line}`).join("\n");
			return `${quoted}\n\n> 上文（仅作语境，不必回答）：\n${quotedExtra}\n\n`;
		}
		//#endregion
		//#region src/client/icons.tsx
		/** 统一的 20px 线性图标，不依赖宿主图标版本。 */
		const paths = {
			selection: "M7 3H4a1 1 0 0 0-1 1v3m10-4h3a1 1 0 0 1 1 1v3M3 13v3a1 1 0 0 0 1 1h3m10-4v3a1 1 0 0 1-1 1h-3M7 7h6M10 7v6m-2 0h4",
			language: "M3 5h10M8 3v2m3 0c-1 5-4 8-8 10m2-7c1 3 3 5 6 6m1 3 3-8 3 8m-5-3h4",
			model: "M6 5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm2 3h4v4H8V8ZM8 2v3m4-3v3M8 15v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3",
			rules: "M5 3h8l3 3v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v4h4M7 10h6m-6 3h4",
			sparkle: "m10 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z",
			list: "M7 5h10M7 10h10M7 15h7M3.5 5h.01M3.5 10h.01M3.5 15h.01",
			check: "m5 10 3 3 7-7",
			chevron: "m7 8 3 3 3-3",
			arrow: "M4 10h12m-4-4 4 4-4 4"
		};
		function ToolIcon({ name, size = 20 }) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 20 20",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: paths[name] }));
		}
		//#endregion
		//#region src/client/overlay.tsx
		/**
		* 划词菜单 + 悬浮窗（注册进 shell.overlay 的那一个 React 组件）。
		*
		* 交互：
		* - 页面里选中文字（拖选 / 双击 / 键盘扩选）→ 以选区右下角为锚点，在锚点
		*   第四象限（右下）弹出菜单，两项：「DeepSeek Harness 解释」「…翻译」。
		* - 同一份选区只弹一次：菜单以任何方式收起（Esc / 点别处 / 滚轮 / 点了菜单项）之后，
		*   页面里那份旧选区不会让菜单再弹出来——只有重新划词（选区变了）才会再弹。
		* - 点击菜单项 → 打开悬浮窗（默认屏幕右下角，可拖动、可八向缩放，可收起为
		*   悬浮球，可关闭），窗内流式渲染 Harness agent 的回答。
		* - 回答用官方 Markdown 原语渲染（与 DSH 对话里的排版一致）。
		*/
		/** 是否是 React 能渲染的组件（函数组件 / memo / forwardRef / class）。 */
		function isComponent(value) {
			if (typeof value === "function") return true;
			if (typeof value === "object" && value !== null) {
				const candidate = value;
				return typeof candidate.$$typeof === "symbol" || typeof candidate.render === "function";
			}
			return false;
		}
		/** 载入官方原语；模块表缺席时返回空对象而不是抛错。 */
		function loadPrimitives() {
			try {
				if (typeof require !== "function") return {};
				return require("@deepseek-ai/dsh-client-ui-primitives") ?? {};
			} catch {
				return {};
			}
		}
		const primitives = loadPrimitives();
		/** Markdown 渲染的界面文案（官方原语用它给代码块加复制按钮）。 */
		function markdownLabels(locale) {
			return locale === "zh" ? {
				code: {
					copyLabel: "复制",
					copiedLabel: "已复制"
				},
				footnotes: "脚注"
			} : {
				code: {
					copyLabel: "Copy",
					copiedLabel: "Copied"
				},
				footnotes: "Footnotes"
			};
		}
				/** 界面文案。 */
		const COPY$1 = {
			zh: {
				explain: "解释",
				translate: "翻译",
				summarize: "总结",
				ask: "问问",
				toolbar: "划词工具",
				askHint: "打开侧卡提问（Alt+Q）",
				askPlaceholder: "输入你的问题，Enter 发送，Shift+Enter 换行",
				askIntro: "在下方输入问题，就选中的文字提问。",
				defaultQuestion: "解释这段文字，并列出关键概念。",
				send: "发送",
				awaiting: "等待提问",
				panelExplain: "解释",
				panelTranslate: "翻译",
				panelSummarize: "总结",
				panelAsk: "问问",
				expand: "展开原文",
				collapse: "收起原文",
				running: "生成中…",
				done: "完成",
				failed: "失败",
				copy: "复制",
				copied: "已复制",
				copyCode: "复制代码",
				copiedCode: "代码已复制",
				noCode: "答案里没有代码块",
				copyFailed: "复制失败",
				insert: "插入输入框",
				inserted: "已插入输入框",
				insertFailed: "没找到可插入的输入框",
				handoffCopied: "没有可填入的输入框，引用已复制到剪贴板",
				locate: "定位原文",
				locateFailed: "找不到原文位置",
				followUp: "继续追问",
				close: "关闭",
				stop: "停止",
				fold: "折叠",
				unfold: "展开",
				minimize: "最小化",
				restore: "恢复",
				selection: "选中内容",
				selectionEmpty: "（这次没有携带选中内容）",
				empty: "（没有文本输出）"
			},
			en: {
				explain: "Explain",
				translate: "Translate",
				summarize: "Summarize",
				ask: "Ask",
				toolbar: "Selection tools",
				askHint: "Open the side card to ask (Alt+Q)",
				askPlaceholder: "Ask anything — Enter to send, Shift+Enter for a new line",
				askIntro: "Type a question below to ask about the selected text.",
				defaultQuestion: "Explain this passage and list the key concepts.",
				send: "Send",
				awaiting: "Waiting for a question",
				panelExplain: "Explain",
				panelTranslate: "Translate",
				panelSummarize: "Summarize",
				panelAsk: "Ask",
				expand: "Show source",
				collapse: "Hide source",
				running: "Generating…",
				done: "Done",
				failed: "Failed",
				copy: "Copy",
				copied: "Copied",
				copyCode: "Copy code",
				copiedCode: "Code copied",
				noCode: "No code block in the answer",
				copyFailed: "Copy failed",
				insert: "Insert",
				inserted: "Inserted into the composer",
				insertFailed: "Could not find the composer",
				handoffCopied: "No composer available — quote copied to clipboard",
				locate: "Locate",
				locateFailed: "Could not locate the source",
				followUp: "Follow up",
				close: "Close",
				stop: "Stop",
				fold: "Collapse",
				unfold: "Expand",
				minimize: "Minimize",
				restore: "Restore",
				selection: "Selected text",
				selectionEmpty: "(no selected text was carried over)",
				empty: "(no text output)"
			}
		};
		/** 浮出条触发/几何参数（契约 §3.2）。 */
		const FLOAT_DEBOUNCE_MS = 200;
		const FLOAT_DEDUPE_MS = 400;
		const FLOAT_GAP = 8;
		const FLOAT_INSET = 8;
		/** 浮出条估算尺寸：渲染后还会按真实矩形再夹一次（见 Overlay 里的测量校正）。 */
		const FLOAT_EST_W = 252;
		const FLOAT_EST_H = 40;
		/** 侧卡宽度（契约 §3.1）与定位高亮时长（契约 §3.1/§3.3）。 */
		const CARD_WIDTH = 380;
		/** 侧卡最小尺寸（拖动/拉伸用，契约 §3.1 的交互补丁）。 */
		const CARD_MIN_WIDTH = 340;
		const CARD_MIN_HEIGHT = 260;
		const LOCATE_HIGHLIGHT_MS = 2e3;
		const TOAST_MS = 2e3;
		const viewport = () => ({
			w: typeof window === "undefined" ? 1280 : window.innerWidth,
			h: typeof window === "undefined" ? 800 : window.innerHeight
		});
		function clamp(value, min, max) {
			return Math.min(Math.max(value, min), Math.max(min, max));
		}
		/**
		* 选区签名：判断"这是不是已经弹过菜单的那一份选区"。
		*
		* 为什么需要它：菜单收起之后，页面的选区**还在**。用户随后在任何地方按下鼠标再松开
		* （mouseup 事件照样进来、选区也没变），旧实现会拿这份旧选区再弹一次菜单——表现就是
		* "选中一次之后，到哪里拖菜单都会冒出来"。所以菜单只认**新的**选区：同一份选区弹过一次
		* 就不再弹，直到选区变了（用户重新划词）。
		*
		* 签名取"起点/终点在 DOM 里的位置 + 文本"，因此同一处同样的文字算同一份选区。
		*/
		function selectionSignature(range, text) {
			const pathOf = (node, offset) => {
				const parts = [];
				let current = node;
				while (current !== null && current.parentNode !== null) {
					parts.push(Array.prototype.indexOf.call(current.parentNode.childNodes, current));
					current = current.parentNode;
				}
				return parts.reverse().join(".") + ":" + offset;
			};
			const snippet = text.slice(0, 120);
			return pathOf(range.startContainer, range.startOffset) + "-" + pathOf(range.endContainer, range.endOffset) + "|" + text.length + "|" + snippet;
		}
		/** 选区矩形：优先整段选区的包围盒（即「文字右下角」），退化时取最后一行的矩形。 */
		function selectionRect(range) {
			const box = range.getBoundingClientRect();
			if (box.width > 0 || box.height > 0) return {
				right: box.right,
				bottom: box.bottom
			};
			const rects = range.getClientRects();
			const last = rects.length > 0 ? rects[rects.length - 1] : void 0;
			return last === void 0 ? null : {
				right: last.right,
				bottom: last.bottom
			};
		}
		/** 输入类元素：在这些地方划词不弹菜单（避免和编辑器/输入框打架）。 */
		function isEditableTarget(node) {
			let element = node instanceof Element ? node : node?.parentElement ?? null;
			while (element !== null) {
				const tag = element.tagName.toLowerCase();
				if (tag === "input" || tag === "textarea" || tag === "select") return true;
				if (element.isContentEditable) return true;
				element = element.parentElement;
			}
			return false;
		}
		/**
		* 页内划词的"上下文"：选区所在的块级元素文本。
		*
		* 与系统级取词（伴生进程用 UIA 读段落）对齐：解释/翻译时一起交给 agent，
		* 让回答落在语境里；块级元素抓不到或与选区等价时返回空串。
		*/
		function contextForRange(range, selected) {
			try {
				const node = range.commonAncestorContainer;
				const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
				if (element === null) return "";
				const text = ((element.closest("p, li, td, th, pre, blockquote, dd, dt, figcaption, article, section") ?? element).textContent ?? "").replace(/\s+/gu, " ").trim();
				const needle = selected.trim();
				if (text === "" || needle === "" || text === needle || !text.includes(needle)) return "";
				return text.slice(0, MAX_CONTEXT_LENGTH);
			} catch {
				return "";
			}
		}
		/**
		* 选区所在的可高亮元素：优先段落级块（p/li/pre…），退化为最近的元素。
		* 定位只给这一块加高亮——选区可能横跨整篇文章，用 commonAncestor 会把整页刷上颜色。
		*/
		function elementForRange(range) {
			try {
				const node = range.commonAncestorContainer;
				const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement ?? null;
				if (element === null) return null;
				return element.closest("p, li, td, th, pre, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption") ?? element;
			} catch {
				return null;
			}
		}
		/**
		* 读取当前选区，并做契约 §3.2 的基础校验（折叠 / trim 后不足 2 字 / 无矩形）。
		* @returns 选区信息；不满足触发条件时返回 null。
		*/
		function readSelection() {
			try {
				const selection = window.getSelection?.();
				if (selection === null || selection === void 0 || selection.rangeCount === 0 || selection.isCollapsed) return null;
				const text = selection.toString().trim();
				if (text.length < 2) return null;
				const range = selection.getRangeAt(0);
				const rect = range.getBoundingClientRect();
				const box = rect.width === 0 && rect.height === 0 ? (range.getClientRects?.()[0] ?? null) : rect;
				if (box === null) return null;
				return {
					text: text.slice(0, MAX_SELECTION_LENGTH),
					context: contextForRange(range, text),
					element: elementForRange(range),
					node: range.commonAncestorContainer,
					signature: selectionSignature(range, text),
					rect: {
						left: box.left,
						top: box.top,
						right: box.right,
						bottom: box.bottom,
						width: box.width,
						height: box.height
					}
				};
			} catch {
				return null;
			}
		}
		/**
		* 浮出条落点：选区外接矩形下方 8px；纵向放不下就翻到选区上方；
		* 水平居中，先按估算宽度夹进视口（渲染后按真实尺寸再校一次）。
		*/
		function placeFloat(rect) {
			const box = viewport();
			const half = FLOAT_EST_W / 2;
			const center = rect.left + rect.width / 2;
			const x = clamp(center, FLOAT_INSET + half, box.w - FLOAT_INSET - half);
			const below = rect.bottom + FLOAT_GAP;
			const above = rect.top - FLOAT_GAP - FLOAT_EST_H;
			let y = below;
			if (below + FLOAT_EST_H > box.h - FLOAT_INSET) y = above >= FLOAT_INSET ? above : Math.max(FLOAT_INSET, box.h - FLOAT_INSET - FLOAT_EST_H);
			return { x, y };
		}
		/** 提取 Markdown 里的 ``` 代码块正文（按出现顺序；没有则返回空数组）。 */
		function extractCodeBlocks(markdown) {
			const blocks = [];
			if (typeof markdown !== "string" || markdown === "") return blocks;
			const pattern = /```[^\n]*\n([\s\S]*?)```/g;
			let match = pattern.exec(markdown);
			while (match !== null) {
				const body = match[1];
				if (typeof body === "string" && body.trim() !== "") blocks.push(body.replace(/\s+$/, ""));
				match = pattern.exec(markdown);
			}
			return blocks;
		}
		/**
		* 找 DSH 当前的输入框：优先 Lexical 编辑器（data-lexical-editor），
		* 其次取视口里面积最大的可见 textarea / contenteditable。
		*/
		function findComposer() {
			try {
				const nodes = document.querySelectorAll("textarea, [contenteditable=\"true\"], [contenteditable=\"\"]");
				let best = null;
				let bestScore = -Infinity;
				for (const node of nodes) {
					if (node.closest("[data-dst-role], .dst-root, .dst-set-section") !== null) continue;
					if (node.disabled === true || node.readOnly === true) continue;
					if (node.getAttribute("aria-hidden") === "true") continue;
					const rect = node.getBoundingClientRect();
					if (rect.width < 80 || rect.height < 18) continue;
					const style = window.getComputedStyle(node);
					if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
					const lexical = node.getAttribute("data-lexical-editor") === "true";
					const bottom = rect.bottom > window.innerHeight * 0.55 ? 1 : 0;
					const score = (lexical ? 1e6 : 0) + bottom * 1e4 + Math.min(rect.width * rect.height, 1e5) / 1e3;
					if (score > bestScore) {
						best = node;
						bestScore = score;
					}
				}
				return best;
			} catch {
				return null;
			}
		}
		/**
		* 把文本插入 DSH 当前输入框（只写值 + 派发 input 事件，绝不发送）。
		* Lexical 富文本不认直接改 DOM（会被编辑器状态覆盖），只认 paste（与 quote 插入同一策略）。
		* @returns 成功插入 true；找不到输入框或插入失败 false。
		*/
		function insertIntoComposer(text) {
			const value = String(text);
			if (value === "") return false;
			const element = findComposer();
			if (element === null) return false;
			try {
				element.focus();
			} catch {}
			if (element.tagName === "TEXTAREA") {
				try {
					const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
					const current = element.value;
					const start = typeof element.selectionStart === "number" ? element.selectionStart : current.length;
					const end = typeof element.selectionEnd === "number" ? element.selectionEnd : current.length;
					const before = current.slice(0, start);
					const after = current.slice(end);
					const glue = before === "" || before.endsWith("\n") ? "" : "\n\n";
					const next = before + glue + value + after;
					if (typeof setter === "function") setter.call(element, next);
					else element.value = next;
					const caret = before.length + glue.length + value.length;
					element.setSelectionRange(caret, caret);
					element.dispatchEvent(new Event("input", { bubbles: true }));
					return true;
				} catch {
					return false;
				}
			}
			if (element.isContentEditable === true) {
				try {
					const range = document.createRange();
					range.selectNodeContents(element);
					range.collapse(false);
					const selection = window.getSelection?.();
					selection?.removeAllRanges();
					selection?.addRange(range);
					if (element.getAttribute("data-lexical-editor") === "true") {
						const data = new DataTransfer();
						data.setData("text/plain", value);
						element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
						return true;
					}
					element.textContent = (element.textContent ?? "") + value;
					element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
					return true;
				} catch {
					return false;
				}
			}
			return false;
		}
		/**
		* 侧卡问答的一轮流：POST /ask/side（首轮）或 /ask/side/followup（追问）。
		* 事件与 /run 同构：session → delta... → done | error（契约 §2）。
		* @returns {{ abort: () => void }}
		*/
		function startAskSide(payload, followUp, handlers) {
			const controller = new AbortController();
			const path = followUp === true ? `${API_PREFIX}/ask/side/followup` : `${API_PREFIX}/ask/side`;
			(async () => {
				try {
					const response = await fetch(path, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
						signal: controller.signal
					});
					if (!response.ok) {
						handlers.onError(await responseError(response));
						return;
					}
					if (response.body === null) {
						handlers.onError("response body is not streamable");
						return;
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					for (;;) {
						const { value, done } = await reader.read();
						if (done === true) break;
						buffer += decoder.decode(value, { stream: true });
						let boundary = buffer.indexOf("\n\n");
						while (boundary !== -1) {
							const frame = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);
							const text = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
							const event = text === "" ? void 0 : parseRunEvent(text);
							if (event?.type === "session") handlers.onSession?.(event.sessionId);
							else if (event?.type === "delta") handlers.onDelta(event.text);
							else if (event?.type === "done") handlers.onDone(event.text, event.sessionId);
							else if (event?.type === "error") handlers.onError(event.message);
							boundary = buffer.indexOf("\n\n");
						}
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					handlers.onError(error instanceof Error ? error.message : String(error));
				}
			})();
			return { abort: () => controller.abort() };
		}
		/** 释放侧卡的 ask 会话（关闭卡片时尽力而为，失败不打扰用户）。 */
		function closeAskSide(sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return;
			try {
				fetch(`${API_PREFIX}/ask/side/close`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				}).catch(() => void 0);
			} catch {}
		}
		/** 内置图标兜底（官方原语缺席时使用）。 */
		function fallbackIcon(path, size) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: path }));
		}
		const FALLBACK_PATHS = {
			lens: "M7 2.6a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zM10 9.8 13.9 13.7",
			doc: "M4.2 2.4h4.4l3.2 3.2v7.6H4.2zM8.6 2.4v3.2h3.2M6 8.2h4M6 10.6h4M6 12.8h2.4",
			translate: "M2.6 5.6h9.8M9.9 3.3l2.5 2.3-2.5 2.3M13.4 10.4H3.6M6.1 8.1 3.6 10.4l2.5 2.3",
			sparkle: "M8 2.2 9.3 6 13 7.3 9.3 8.6 8 12.4 6.7 8.6 3 7.3 6.7 6z",
			ask: "M3.6 3.2h8.8a1.4 1.4 0 0 1 1.4 1.4v5a1.4 1.4 0 0 1-1.4 1.4H7.6L4.4 13.4v-2.4H3.6a1.4 1.4 0 0 1-1.4-1.4v-5a1.4 1.4 0 0 1 1.4-1.4z",
			globe: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2.6 8h10.8M8 2.2c1.6 1.6 2.4 3.6 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.2 5.6 8S6.4 3.8 8 2.2z",
			list: "M6 4h8M6 8h8M6 12h5.5M3 4h.01M3 8h.01M3 12h.01",
			copy: "M6 2.8h5.2a1 1 0 0 1 1 1V9M4.8 5.2h5.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z",
			close: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6",
			chevronUp: "M4 9.6 8 5.8l4 3.8",
			minus: "M4 8h8",
			chevronDown: "M4 6.4 8 10.2l4-3.8",
			stop: "M5 5h6v6H5z"
		};
		function icon(name, size = 16) {
			let official;
			switch (name) {
				case "sparkle":
					official = primitives.IconSparkle16;
					break;
				case "globe":
					official = primitives.IconGlobeOutline14;
					break;
				case "list": break;
				case "copy":
					official = primitives.IconCopyOutline16;
					break;
				case "close":
					official = primitives.IconCloseOutline16;
					break;
				case "chevronDown":
					official = primitives.IconChevronDownOutline14;
					break;
				case "stop": official = primitives.IconStopFill16;
			}
			if (isComponent(official)) return (0, react.createElement)(official, { size });
			return fallbackIcon(FALLBACK_PATHS[name], size);
		}
		/** 复制文本：优先官方剪贴板工具，其次 navigator.clipboard。 */
		async function copyText(text) {
			if (typeof primitives.writeClipboard === "function") {
				await primitives.writeClipboard(text);
				return;
			}
			await navigator.clipboard.writeText(text);
		}
/**
		* 本地 Markdown 渲染兜底：官方 MarkdownText 缺席时，按原生面板的排版风格
		* 渲染标题 / 粗体 / 行内代码与行内公式 / 代码块 / 列表 / 引用 / 表格 / 分隔线。
		* 只是"够用"的子集，不追求完整 CommonMark。
		*/
const mdH = react.createElement;
function parseMdBlocks(text) {
	const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
	const blocks = [];
	const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
	const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
	let i = 0;
	while (i < lines.length) {
		const trimmed = lines[i].trim();
		if (trimmed === "") { i++; continue; }
		const fence = trimmed.match(/^\`\`\`([^\`]*)$/);
		if (fence !== null) {
			const body = [];
			i++;
			while (i < lines.length && lines[i].trim() !== "\`\`\`") { body.push(lines[i]); i++; }
			i++;
			blocks.push({ kind: "code", text: body.join("\n") });
			continue;
		}
		const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
		if (heading !== null) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); i++; continue; }
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { blocks.push({ kind: "hr" }); i++; continue; }
		if (trimmed.startsWith(">")) {
			const parts = [];
			while (i < lines.length && lines[i].trim().startsWith(">")) { parts.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
			blocks.push({ kind: "quote", text: parts.join("\n") });
			continue;
		}
		if (/^[-*+]\s+/.test(trimmed)) {
			const items = [];
			while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*+]\s+/, "")); i++; }
			blocks.push({ kind: "bullet", items });
			continue;
		}
		if (/^\d{1,3}[.)]\s+/.test(trimmed)) {
			const items = [];
			while (i < lines.length && /^\d{1,3}[.)]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d{1,3}[.)]\s+/, "")); i++; }
			blocks.push({ kind: "ordered", items });
			continue;
		}
		if (trimmed.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
			const head = splitRow(trimmed);
			i += 2;
			const rows = [];
			while (i < lines.length && lines[i].trim().includes("|")) { rows.push(splitRow(lines[i].trim())); i++; }
			blocks.push({ kind: "table", head, rows });
			continue;
		}
		const paragraph = [trimmed];
		i++;
		while (i < lines.length) {
			const next = lines[i].trim();
			if (next === "" || /^\`\`\`/.test(next) || /^#{1,6}\s/.test(next) || /^[-*+]\s+/.test(next) || /^\d{1,3}[.)]\s+/.test(next) || next.startsWith(">") || /^(-{3,}|\*{3,}|_{3,})$/.test(next)) break;
			paragraph.push(next);
			i++;
		}
		blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
	}
	return blocks;
}
function renderInlineMd(text) {
	const out = [];
	const pattern = /(\*\*[^*]+\*\*|\`[^\`]+\`|\$[^$\n]+\$|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
	let last = 0;
	let seq = 0;
	let match = pattern.exec(text);
	const pushText = (value) => {
		if (value === "") return;
		const parts = value.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) out.push(mdH("br", { key: "md-br-" + seq++ }));
			if (part !== "") out.push(part);
		});
	};
	while (match !== null) {
		pushText(text.slice(last, match.index));
		const token = match[0];
		if (token.startsWith("**")) out.push(mdH("strong", { key: "md-b-" + seq++ }, token.slice(2, -2)));
		else if (token.startsWith("\`")) out.push(mdH("code", { key: "md-c-" + seq++, className: "dst-md-inline-code" }, token.slice(1, -1)));
		else if (token.startsWith("\$")) out.push(mdH("code", { key: "md-m-" + seq++, className: "dst-md-inline-math" }, token.slice(1, -1)));
		else {
			const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
			if (link === null) out.push(token);
			else out.push(mdH("a", { key: "md-a-" + seq++, href: link[2], target: "_blank", rel: "noreferrer noopener", className: "dst-md-link" }, link[1]));
		}
		last = match.index + token.length;
		match = pattern.exec(text);
	}
	pushText(text.slice(last));
	return out;
}
function renderLocalMarkdown(text, streaming) {
	const blocks = parseMdBlocks(text);
	const nodes = blocks.map((block, index) => {
		const key = "md-" + index;
		if (block.kind === "code") return mdH("pre", { key, className: "dst-md-code" }, mdH("code", null, block.text));
		if (block.kind === "heading") {
			const level = Math.max(1, Math.min(4, block.level));
			return mdH("h" + level, { key, className: "dst-md-h dst-md-h" + level }, ...renderInlineMd(block.text));
		}
		if (block.kind === "hr") return mdH("hr", { key, className: "dst-md-hr" });
		if (block.kind === "quote") return mdH("blockquote", { key, className: "dst-md-quote" }, ...renderInlineMd(block.text));
		if (block.kind === "bullet") return mdH("ul", { key, className: "dst-md-list" }, ...block.items.map((item, itemIndex) => mdH("li", { key: itemIndex }, ...renderInlineMd(item))));
		if (block.kind === "ordered") return mdH("ol", { key, className: "dst-md-list" }, ...block.items.map((item, itemIndex) => mdH("li", { key: itemIndex }, ...renderInlineMd(item))));
		if (block.kind === "table") return mdH("div", { key, className: "dst-md-tablewrap" }, mdH("table", { className: "dst-md-table" }, mdH("thead", null, mdH("tr", null, ...block.head.map((cell, cellIndex) => mdH("th", { key: cellIndex }, ...renderInlineMd(cell))))), mdH("tbody", null, ...block.rows.map((row, rowIndex) => mdH("tr", { key: rowIndex }, ...row.map((cell, cellIndex) => mdH("td", { key: cellIndex }, ...renderInlineMd(cell))))))));
		return mdH("p", { key, className: "dst-md-p" }, ...renderInlineMd(block.text));
	});
	if (streaming) nodes.push(mdH("span", { key: "md-caret", className: "dst-caret" }));
	return mdH("div", { className: "dst-md" }, ...nodes);
}
		/** 渲染 Markdown 回答：优先官方 MarkdownText，缺席时用本地渲染兜底。 */
		function renderMarkdown(text, streaming, locale) {
			if (isComponent(primitives.MarkdownText)) return (0, react.createElement)(primitives.MarkdownText, {
				text,
				streaming,
				labels: markdownLabels(locale)
			});
			return renderLocalMarkdown(text, streaming);
		}
		/** 面板标题：按动作取文案。 */
		function actionTitle(action, copy) {
			if (action === "translate") return copy.panelTranslate;
			if (action === "summarize") return copy.panelSummarize;
			return copy.panelExplain;
		}
		/** 面板标题旁的小图标：与菜单项保持一致。 */
		function actionIcon(action) {
			if (action === "translate") return "translate";
			if (action === "summarize") return "doc";
			return "lens";
		}
		/**
		* 选区浮出条 + 侧卡（注册进 shell.overlay 的那一个 React 组件）。
		*
		* 交互（契约 docs/ask-side-contract.md §3）：
		* - 页面里选中文字（selectionchange 去抖 200ms）→ 选区下方 8px 浮出小工具条：
		*   `解释 | 总结 | 翻译 | 问问`；越界翻到上方，水平居中并夹在视口内。
		* - 解释/总结/翻译 → 右上角侧卡流式作答（复用 POST /run）；问问 / Alt+Q →
		*   侧卡打开提问框，走 POST /ask/side 与 /ask/side/followup（SSE）。
		* - 结果操作：复制、复制代码块、插入 DSH 当前输入框（只写值不发送）、定位原文高亮 2 秒。
		* - 滚动 / resize / 点到别处收起浮出条；Esc 关闭侧卡。
		* @param props.ctx - 客户端 Cordis 上下文。
		*/
		function Overlay(props) {
			const { ctx } = props;
			const locale = (0, react.useMemo)(() => detectLocale(), []);
			const copy = COPY$1[locale];
			const [float, setFloat] = (0, react.useState)(null);
			const [card, setCard] = (0, react.useState)(null);
			const [toast, setToast] = (0, react.useState)(null);
			const [cardBox, setCardBox] = (0, react.useState)(null);
			const [cardCollapsed, setCardCollapsed] = (0, react.useState)(false);
			const [cardMinimized, setCardMinimized] = (0, react.useState)(false);
			const [quoteOpen, setQuoteOpen] = (0, react.useState)(false);
			const [input, setInput] = (0, react.useState)("");
			/** 多窗口并存：被新动作顶下去的卡片存成冻结快照（content + 几何 + 视图状态）。 */
			const [stack, setStack] = (0, react.useState)([]);
			const stackRef = (0, react.useRef)([]);
			stackRef.current = stack;
			const stackSeqRef = (0, react.useRef)(0);
			const cardRef = (0, react.useRef)(null);
			const dragRef = (0, react.useRef)(null);
			const rootRef = (0, react.useRef)(null);
			const floatRef = (0, react.useRef)(null);
			const answerRef = (0, react.useRef)(null);
			const inputRef = (0, react.useRef)(null);
			const streamRef = (0, react.useRef)(null);
			const tokenRef = (0, react.useRef)(0);
			const turnSeqRef = (0, react.useRef)(0);
			/** 最近一次合法选区：动作按钮与「定位原文」都取这一份。 */
			const selectionRef = (0, react.useRef)(null);
			/** 卡片最新值（事件监听里读，避免闭包拿到旧 state）。 */
			const cardStateRef = (0, react.useRef)(null);
			cardStateRef.current = card;
			const copyRef = (0, react.useRef)(copy);
			copyRef.current = copy;
			const closeCardRef = (0, react.useRef)(null);
			const openAskCardRef = (0, react.useRef)(null);
			/**
			* 系统级浮层递过来的「问问」：长轮询宿主的信箱，取到就把原文引用进会话。
			*
			* 伴生进程在别的进程里，点菜单时它碰不到这个页面——它只往宿主投一条请求，
			* 由这里取走并落到界面上。轮询挂起 20 秒（宿主那边到点回空），断了就退避重连。
			*/
			(0, react.useEffect)(() => {
				let stopped = false;
				let cursor = null;
				let controller = null;
				const sleep = (ms) => new Promise((resolve) => {
					const timer = window.setTimeout(resolve, ms);
					controller?.signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
				});
				const loop = async () => {
					// 桌面端（`window.dshDesktop` 是桌面壳 preload 暴露的桥）与浏览器标签会同时
					// 轮询同一个信箱：带上角色，宿主才会让桌面端优先取件、并且只投一次。
					const clientRole = typeof window !== "undefined" && window.dshDesktop !== void 0 ? "desktop" : "web";
					while (!stopped) {
						controller = new AbortController();
						try {
							// cursor = null 表示"还没对齐过"：这一次只问当前游标，取走零条。
							const url = cursor === null ? `${API_PREFIX}/handoff?client=${clientRole}` : `${API_PREFIX}/handoff?since=${cursor}&client=${clientRole}`;
							const response = await fetch(url, {
								signal: controller.signal,
								cache: "no-store"
							});
							if (!response.ok) {
								await sleep(2e3);
								continue;
							}
							const payload = await response.json();
							if (typeof payload?.cursor === "number") cursor = payload.cursor;
							const items = Array.isArray(payload?.items) ? payload.items : [];
							for (const entry of items) {
								if (stopped) return;
								// 契约 §1.5 / §4.1：handoff 只把引用填进当前可见输入框（只写不发），
								// 找不到输入框就复制到剪贴板并 toast —— 绝不新建会话。
								const quoteText = typeof entry?.text === "string" ? entry.text.trim() : "";
								if (quoteText !== "") {
									const quoteDraft = quoteForInput(quoteText.slice(0, MAX_SELECTION_LENGTH), typeof entry?.context === "string" ? entry.context : "");
									if (!insertIntoComposer(quoteDraft)) {
										void copyText(quoteDraft);
										showToast(copyRef.current.handoffCopied);
									}
								}
							}
							if (items.length === 0) await sleep(300);
						} catch {
							if (stopped) return;
							await sleep(2e3);
						}
					}
				};
				void loop();
				return () => {
					stopped = true;
					controller?.abort();
				};
			}, [ctx]);
			/** 所有插件 UI 都挂在这个根节点里：点它不算「点击别处」。 */
			const insideOwnUi = (node) => {
				if (node === null || node === void 0) return false;
				const element = node instanceof Element ? node : node.parentElement ?? null;
				if (element === null) return false;
				if (rootRef.current !== null && rootRef.current.contains(element)) return true;
				return element.closest("[data-dst-role], .dst-root, .dst-float, .dst-card, .dst-toast") !== null;
			};
			/** 轻提示：2 秒后自动消失（复制成功/插入失败等）。 */
			const showToast = (text) => {
				setToast({
					text,
					at: Date.now()
				});
			};
			(0, react.useEffect)(() => {
				if (toast === null) return void 0;
				const timer = window.setTimeout(() => setToast(null), TOAST_MS);
				return () => window.clearTimeout(timer);
			}, [toast]);
			/** 作废当前流（旧请求的 delta/done 不再落到新卡片上）。 */
			const invalidateStream = () => {
				tokenRef.current += 1;
				streamRef.current?.abort?.();
				streamRef.current = null;
			};
			const releaseAskSession = () => {
				const current = cardStateRef.current;
				if (current !== null && current.mode === "ask") closeAskSide(current.sessionId);
			};

			/** 解释 / 总结 / 翻译：侧卡里复用 POST /run 的 SSE。 */
			const openRunCard = (action, selection) => {
				const info = selection ?? selectionRef.current;
				if (info === null) return;
				if (snapshotActiveCard()) setCardBox(cascadeCardBox(stackRef.current.length + 1));
				selectionRef.current = info;
				setFloat(null);
				setInput("");
				setCardCollapsed(false);
				setCardMinimized(false);
				setQuoteOpen(false);

				invalidateStream();
				const token = tokenRef.current;
				const alive = () => tokenRef.current === token;
				setCard({
					mode: "run",
					action,
					status: "running",
					text: "",
					error: "",
					via: "",
					source: info.text,

					context: info.context,
					sessionId: void 0,
					turns: [],
					showInput: false
				});
				streamRef.current = startRun(action, info.text, ctx, info.context, {
					onSession: (sessionId) => {
						if (!alive()) return;
						setCard((current) => current === null ? current : {
							...current,
							sessionId
						});
					},
					onDelta: (chunk) => {
						if (!alive()) return;
						setCard((current) => current === null ? current : {
							...current,
							text: current.text + chunk
						});
					},
					onDone: (final, sessionId, event) => {
						if (!alive()) return;
						setCard((current) => current === null ? current : {
							...current,
							status: "done",
							sessionId,
							via: typeof event?.via === "string" ? event.via : current.via,
							text: final === "" ? current.text : final
						});
					},
					onError: (message) => {
						if (!alive()) return;
						setCard((current) => current === null ? current : {
							...current,
							status: "error",
							error: message
						});
					}
				});
			};
			/** 问问：在侧卡里打开提问框（聚焦输入框），不新建 DSH 会话。 */
			const openAskCard = (selection) => {
				const info = selection ?? selectionRef.current;
				if (info === null) return;
				if (snapshotActiveCard()) setCardBox(cascadeCardBox(stackRef.current.length + 1));
				selectionRef.current = info;
				setFloat(null);
				setInput("");
				setCardCollapsed(false);
				setCardMinimized(false);
				setQuoteOpen(false);

				invalidateStream();
				setCard({
					mode: "ask",
					action: "ask",
					status: "idle",
					text: "",
					error: "",
					via: "",
					source: info.text,

					context: info.context,
					sessionId: void 0,
					turns: [],
					showInput: true
				});
				window.setTimeout(() => inputRef.current?.focus(), 60);
			};
			/** 关闭侧卡：先释放 ask 会话（若有），再清 DOM。 */
			const closeCard = () => {
				invalidateStream();
				const current = cardStateRef.current;
				if (current !== null && current.mode === "ask") closeAskSide(current.sessionId);
				setCard(null);
				setInput("");
				setCardCollapsed(false);
				setCardMinimized(false);
				setQuoteOpen(false);
				setCard(null);
				setInput("");
				setFloat(null);
			};
			closeCardRef.current = closeCard;
			openAskCardRef.current = openAskCard;
			/** 把当前卡片冻结成快照（保留内容/几何/视图状态），并停掉它的流与 ask 会话。 */
			const snapshotActiveCard = () => {
				const current = cardStateRef.current;
				if (current === null) return false;
				const node = cardRef.current;
				const rect = node === null ? null : node.getBoundingClientRect();
				const box = rect === null ? cardBox : { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
				const frozen = {
					key: stackSeqRef.current += 1,
					card: {
						...current,
						sessionId: void 0,
						showInput: false,
						status: current.status === "running" ? "done" : current.status
					},
					box,
					collapsed: cardCollapsed,
					minimized: cardMinimized,
					quoteOpen,
					selection: selectionRef.current
				};
				setStack((prev) => [...prev, frozen].slice(-3));
				invalidateStream();
				if (current.mode === "ask") closeAskSide(current.sessionId);
				return true;
			};
			/** 把冻结卡片恢复为当前卡片（当前卡片先冻结）。 */
			const promoteStackItem = (key) => {
				const item = stackRef.current.find((value) => value.key === key);
				if (item === void 0) return;
				snapshotActiveCard();
				setStack((prev) => prev.filter((value) => value.key !== key));
				selectionRef.current = item.selection;
				setCard(item.card);
				setCardBox(item.box);
				setCardCollapsed(item.collapsed === true);
				setCardMinimized(false);
				setQuoteOpen(item.quoteOpen === true);
				if (item.card.mode === "ask") window.setTimeout(() => inputRef.current?.focus(), 60);
			};

			/** 卡片几何：默认右上角 380 宽；拖动/拉伸后固定下来；始终保证整卡在视口内。 */
			const clampCardBox = (box) => {
				const view = viewport();
				const maxWidth = Math.max(CARD_MIN_WIDTH, view.w - 32);
				const maxHeight = Math.max(CARD_MIN_HEIGHT, view.h - 32);
				const width = Math.min(Math.max(Math.round(box.w), CARD_MIN_WIDTH), maxWidth);
				const height = Math.min(Math.max(Math.round(box.h), CARD_MIN_HEIGHT), maxHeight);
				const x = Math.min(Math.max(box.x, 8), Math.max(8, view.w - width - 8));
				const y = Math.min(Math.max(box.y, 8), Math.max(8, view.h - height - 8));
				return { w: width, h: height, x, y };
			};
			/** 新卡片并排落位：先往左排，排不下换一行；并排不开才叠放。 */
			const cascadeCardBox = (index) => {
				const view = viewport();
				const width = CARD_WIDTH;
				const height = Math.min(560, view.h - 64);
				const gap = 12;
				const step = width + gap;
				const slots = Math.max(1, Math.floor((view.w - 24) / step));
				let slot = Math.max(0, index) % slots;
				let row = Math.floor(Math.max(0, index) / slots);
				let x = view.w - 16 - width - slot * step;
				let y = 16 + row * 40;
				if (y + height > view.h - 16) y = Math.max(16, view.h - 16 - height);
				return clampCardBox({ x, y, w: width, h: height });
			};
			const currentCardBox = () => {
				const node = cardRef.current;
				if (node !== null) {
					const rect = node.getBoundingClientRect();
					return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
				}
				if (cardBox !== null) return cardBox;
				const view = viewport();
				return { x: view.w - CARD_WIDTH - 16, y: 16, w: CARD_WIDTH, h: Math.min(560, view.h - 64) };
			};
			const beginPointerFor = (event, mode, dir, getBox, setBox) => {
				if (event.button !== 0) return;
				if (mode === "move" && event.target instanceof Element && event.target.closest("button, textarea, input, a, [data-dst-result]")) return;
				event.preventDefault();
				const box = getBox();
				dragRef.current = { mode, dir, startX: event.clientX, startY: event.clientY, box };
				const onMove = (moveEvent) => {
					const drag = dragRef.current;
					if (drag === null) return;
					const dx = moveEvent.clientX - drag.startX;
					const dy = moveEvent.clientY - drag.startY;
					const base = drag.box;
					let next = base;
					if (drag.mode === "move") next = { ...base, x: base.x + dx, y: base.y + dy };
					else {
						const view = viewport();
						let { x, y, w, h } = base;
						if (drag.dir.includes("e")) w = Math.min(base.w + dx, view.w - base.x - 8);
						if (drag.dir.includes("s")) h = Math.min(base.h + dy, view.h - base.y - 8);
						if (drag.dir.includes("w")) {
							x = Math.min(Math.max(base.x + dx, 8), base.x + base.w - CARD_MIN_WIDTH);
							w = base.x + base.w - x;
						}
						if (drag.dir.includes("n")) {
							y = Math.min(Math.max(base.y + dy, 8), base.y + base.h - CARD_MIN_HEIGHT);
							h = base.y + base.h - y;
						}
						next = { x, y, w, h };
					}
					setBox(clampCardBox(next));
				};
				const onUp = () => {
					dragRef.current = null;
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			};
			const beginCardPointer = (event, mode, dir) => beginPointerFor(event, mode, dir, currentCardBox, setCardBox);
			const startCardDrag = (event) => beginCardPointer(event, "move", "");
			const startCardResize = (event, dir) => beginCardPointer(event, "resize", dir);
			const resetCardBox = () => setCardBox(null);
			/** 冻结卡片的几何：写回 stack 项。 */
			const updateStackItem = (key, patch) => {
				setStack((prev) => prev.map((item) => item.key === key ? { ...item, ...(typeof patch === "function" ? patch(item) : patch) } : item));
			};
			const removeStackItem = (key) => setStack((prev) => prev.filter((item) => item.key !== key));
			const stackBoxOf = (item) => item.box === null || item.box === void 0 ? { x: viewport().w - CARD_WIDTH - 16, y: 16, w: CARD_WIDTH, h: Math.min(560, viewport().h - 64) } : item.box;

			/** 卸载清理：中止流式请求并释放 ask 会话（宿主页面卸载也要收尾）。 */
			(0, react.useEffect)(() => () => {
				tokenRef.current += 1;
				streamRef.current?.abort?.();
				streamRef.current = null;
				const current = cardStateRef.current;
				if (current !== null && current.mode === "ask") closeAskSide(current.sessionId);
			}, []);
			/** 结果操作的目标文本：ask 模式取最近一轮有内容的回答。 */
			const latestAnswer = () => {
				const current = cardStateRef.current;
				if (current === null) return "";
				if (current.mode === "run") return current.text;
				for (let index = current.turns.length - 1; index >= 0; index -= 1) {
					const turn = current.turns[index];
					if (turn.answer !== "") return turn.answer;
				}
				return "";
			};
			const onResultCopy = () => {
				const text = latestAnswer();
				if (text.trim() === "") {
					showToast(copyRef.current.empty);
					return;
				}
				copyText(text).then(() => showToast(copyRef.current.copied), () => showToast(copyRef.current.copyFailed));
			};
			const onResultCopyCode = () => {
				const blocks = extractCodeBlocks(latestAnswer());
				if (blocks.length === 0) {
					showToast(copyRef.current.noCode);
					return;
				}
				copyText(blocks.join("\n\n")).then(() => showToast(copyRef.current.copiedCode), () => showToast(copyRef.current.copyFailed));
			};
			const onResultInsert = () => {
				const text = latestAnswer();
				if (text.trim() === "") {
					showToast(copyRef.current.empty);
					return;
				}
				showToast(insertIntoComposer(text) ? copyRef.current.inserted : copyRef.current.insertFailed);
			};
			const onResultLocate = () => {
				const info = selectionRef.current;
				const target = info === null ? null : info.element;
				if (target === null || target === void 0 || target.isConnected !== true) {
					showToast(copyRef.current.locateFailed);
					return;
				}
				try {
					target.scrollIntoView({
						behavior: "smooth",
						block: "center"
					});
				} catch {
					try {
						target.scrollIntoView();
					} catch {}
				}
				const previousOutline = target.style.outline;
				const previousOutlineOffset = target.style.outlineOffset;
				const previousBackground = target.style.background;
				target.style.outline = "2px solid #6f5bd8";
				target.style.outlineOffset = "2px";
				target.style.background = "rgba(111, 91, 216, 0.12)";
				window.setTimeout(() => {
					target.style.outline = previousOutline;
					target.style.outlineOffset = previousOutlineOffset;
					target.style.background = previousBackground;
				}, LOCATE_HIGHLIGHT_MS);
			};
			/** 追问：ask 模式直接聚焦输入框；run 模式把已有回答转成首轮，再复用同一输入框。 */
			const beginFollowUp = () => {
				const current = cardStateRef.current;
				if (current === null) return;
				if (current.mode === "ask") {
					setCard((value) => value === null ? value : {
						...value,
						showInput: true
					});
					window.setTimeout(() => inputRef.current?.focus(), 40);
					return;
				}
				invalidateStream();
				const answer = current.text;
				const error = current.error;
				const turn = answer === "" && error === "" ? null : {
					id: turnSeqRef.current += 1,
					question: actionTitle(current.action, copyRef.current),
					answer,
					state: error === "" ? "done" : "error",
					error
				};
				setCard({
					...current,
					mode: "ask",
					text: "",
					error: "",
					status: turn === null ? "idle" : error === "" ? "done" : "error",
					turns: turn === null ? [] : [turn],
					seed: answer === "" ? void 0 : answer,
					showInput: true,
					// run 会话不是 ask 会话：追问必须重新开一条 /ask/side（否则宿主侧查不到 sessionId）。
					sessionId: void 0
				});
				setInput("");
				window.setTimeout(() => inputRef.current?.focus(), 40);
			};
			/** 提交追问：首轮 POST /ask/side，之后 POST /ask/side/followup。 */
			const submitAsk = () => {
				const current = cardStateRef.current;
				if (current === null || current.mode !== "ask" || current.status === "running") return;
				const question = input.trim();
				const sessionId = current.sessionId;
				const display = question === "" ? copyRef.current.defaultQuestion : question;
				const seed = typeof current.seed === "string" ? current.seed.trim() : "";
				const firstQuestion = seed === "" ? display : "上一轮回答（供参考）：" + seed.slice(0, 2000) + "\n\n新问题：" + display;
				invalidateStream();
				const token = tokenRef.current;
				const alive = () => tokenRef.current === token;
				const turnId = turnSeqRef.current + 1;
				turnSeqRef.current = turnId;
				setCard((value) => {
					if (value === null) return value;
					return {
						...value,
						status: "running",
						error: "",
						showInput: true,
						turns: [...value.turns, {
							id: turnId,
							question: display,
							answer: "",
							state: "running",
							error: ""
						}]
					};
				});
				setInput("");
				const payload = sessionId === void 0 ? {
					question: firstQuestion,
					text: current.source,
					...(current.context === "" ? {} : {
						context: current.context
					}),
					locale
				} : {
					sessionId,
					question: display
				};
				streamRef.current = startAskSide(payload, sessionId !== void 0, {
					onSession: (nextSession) => {
						if (!alive()) return;
						setCard((value) => value === null ? value : {
							...value,
							sessionId: nextSession
						});
					},
					onDelta: (chunk) => {
						if (!alive()) return;
						setCard((value) => {
							if (value === null) return value;
							return {
								...value,
								turns: value.turns.map((turn) => turn.id === turnId ? {
									...turn,
									answer: turn.answer + chunk
								} : turn)
							};
						});
					},
					onDone: (final) => {
						if (!alive()) return;
						setCard((value) => {
							if (value === null) return value;
							return {
								...value,
								status: "done",
								turns: value.turns.map((turn) => turn.id === turnId ? {
									...turn,
									state: "done",
									answer: final === "" ? turn.answer : final
								} : turn)
							};
						});
					},
					onError: (message) => {
						if (!alive()) return;
						const expired = typeof message === "string" && /session\s*expired/i.test(message);
						setCard((value) => {
							if (value === null) return value;
							return {
								...value,
								status: "error",
								error: message,
								...(expired ? { sessionId: void 0 } : {}),
								turns: value.turns.map((turn) => turn.id === turnId ? {
									...turn,
									state: "error",
									error: message
								} : turn)
							};
						});
					}
				});
			};
			const onInputKeyDown = (event) => {
				if (event.key !== "Enter" || event.shiftKey === true) return;
				if (event.isComposing === true || event.nativeEvent?.isComposing === true) return;
				event.preventDefault();
				submitAsk();
			};
			/**
			* 浮出条触发（契约 §3.2）：selectionchange 去抖 200ms；
			* trim 后 ≥2 字；输入框里 / 插件自身 DOM 里不出现；同选区 400ms 去重。
			*/
			(0, react.useEffect)(() => {
				let timer = null;
				let lastSignature = "";
				let lastAt = 0;
				const clearTimer = () => {
					if (timer !== null) {
						window.clearTimeout(timer);
						timer = null;
					}
				};
				const inspect = () => {
					clearTimer();
					const info = readSelection();
					if (info === null) {
						setFloat(null);
						return;
					}
					if (insideOwnUi(info.node) || isEditableTarget(info.node)) {
						setFloat(null);
						return;
					}
					const now = Date.now();
					if (info.signature === lastSignature && now - lastAt < FLOAT_DEDUPE_MS) return;
					lastSignature = info.signature;
					lastAt = now;
					selectionRef.current = info;
					const point = placeFloat(info.rect);
					setFloat({
						x: point.x,
						y: point.y,
						signature: info.signature
					});
				};
				const onSelectionChange = () => {
					clearTimer();
					timer = window.setTimeout(inspect, FLOAT_DEBOUNCE_MS);
				};
				const onPointerDown = (event) => {
					if (insideOwnUi(event.target)) return;
					setFloat(null);
				};
				const onKeyDown = (event) => {
					const key = typeof event.key === "string" ? event.key : "";
					if (key === "Escape") {
						setFloat(null);
						closeCardRef.current?.();
						return;
					}
					if (event.altKey !== true || (key !== "q" && key !== "Q" && event.code !== "KeyQ")) return;
					const info = readSelection();
					if (info === null) return;
					if (insideOwnUi(info.node) || isEditableTarget(info.node)) return;
					event.preventDefault();
					selectionRef.current = info;
					setFloat(null);
					openAskCardRef.current?.(info);
				};
				const onViewportChange = () => {
					clearTimer();
					setFloat(null);
				};
				document.addEventListener("selectionchange", onSelectionChange);
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("resize", onViewportChange);
				window.addEventListener("scroll", onViewportChange, true);
				return () => {
					clearTimer();
					document.removeEventListener("selectionchange", onSelectionChange);
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("resize", onViewportChange);
					window.removeEventListener("scroll", onViewportChange, true);
				};
			}, []);
			/** 浮出条渲染后用真实尺寸再夹一次视口（估算宽度只用于首帧）。 */
			(0, react.useLayoutEffect)(() => {
				if (float === null) return;
				const node = floatRef.current;
				if (node === null) return;
				const rect = node.getBoundingClientRect();
				const box = viewport();
				let dx = 0;
				let dy = 0;
				if (rect.left < FLOAT_INSET) dx = FLOAT_INSET - rect.left;
				else if (rect.right > box.w - FLOAT_INSET) dx = box.w - FLOAT_INSET - rect.right;
				if (rect.top < FLOAT_INSET) dy = FLOAT_INSET - rect.top;
				else if (rect.bottom > box.h - FLOAT_INSET) dy = box.h - FLOAT_INSET - rect.bottom;
				if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
				setFloat((current) => current === null ? current : {
					...current,
					x: current.x + dx,
					y: current.y + dy
				});
			}, [float]);
			/** 答案区跟随流式输出滚到底部。 */
			(0, react.useEffect)(() => {
				const node = answerRef.current;
				if (node === null) return;
				node.scrollTop = node.scrollHeight;
			}, [card]);
			/** 状态行文案。 */
			const statusTextOf = (state) => state.status === "running" ? copy.running : state.status === "error" ? copy.failed : state.status === "idle" ? copy.awaiting : copy.done;
			const titleOf = (state) => state.mode === "ask" ? copy.ask : actionTitle(state.action, copy);
			const viaOf = (state) => state.via === "bing" ? "Bing" : state.via === "google" ? "Google" : "";
			/** 答案区：run 模式渲染一段 Markdown；ask 模式按轮次渲染问答。 */
			const renderAnswerFor = (state) => {
				if (state === null) return null;
				if (state.mode === "run") {
					if (state.text === "") {
						if (state.status === "running") return (0, react.createElement)("span", { className: "dst-caret" });
						if (state.status === "error") return (0, react.createElement)("span", { className: "dst-error" }, state.error === "" ? copy.failed : state.error);
						return (0, react.createElement)("span", { className: "dst-card-hint" }, copy.empty);
					}
					return renderMarkdown(state.text, state.status === "running", locale);
				}
				if (state.turns.length === 0) return (0, react.createElement)("span", { className: "dst-card-hint" }, copy.askIntro);
				return state.turns.map((turn) => (0, react.createElement)("div", {
					key: turn.id,
					className: "dst-turn"
				}, (0, react.createElement)("div", { className: "dst-card-q" }, turn.question), turn.answer === "" && turn.state === "running" ? (0, react.createElement)("span", { className: "dst-caret" }) : renderMarkdown(turn.answer, turn.state === "running", locale), turn.state === "error" ? (0, react.createElement)("div", { className: "dst-error" }, turn.error === "" ? copy.failed : turn.error) : null));
			};
			/** 浮出条（契约 §3.1/§3.2）。 */
			const floatNode = float === null ? null : (0, react.createElement)("div", {
				ref: floatRef,
				className: "dst-float",
				"data-dst-role": "float",
				role: "toolbar",
				"aria-label": copy.toolbar,
				style: {
					left: float.x,
					top: float.y
				}
			}, ...([
				["explain", copy.explain, "lens"],
				["summarize", copy.summarize, "doc"],
				["translate", copy.translate, "translate"]
			].map(([action, label, iconName]) => (0, react.createElement)("button", {
				key: action,
				type: "button",
				className: "dst-float-btn",
				"data-dst-action": action,
				onMouseDown: (event) => event.preventDefault(),
				onClick: () => openRunCard(action, selectionRef.current)
			}, (0, react.createElement)("span", { className: "dst-float-btn-icon" }, icon(iconName, 14)), (0, react.createElement)("span", null, label)))), (0, react.createElement)("span", {
				className: "dst-float-sep",
				"aria-hidden": true
			}), (0, react.createElement)("button", {
				type: "button",
				className: "dst-float-btn dst-float-ask",
				"data-dst-action": "ask",
				title: copy.askHint,
				onMouseDown: (event) => event.preventDefault(),
				onClick: () => openAskCard(selectionRef.current)
			}, (0, react.createElement)("span", { className: "dst-float-btn-icon" }, icon("ask", 14)), (0, react.createElement)("span", null, copy.ask), (0, react.createElement)("span", { className: "dst-float-kbd" }, "Alt Q")));
			/** 一扇卡片（当前卡 active=true；冻结卡 active=false）。 */
			const buildCardView = (view, active) => {
				const state = view.card;
				const title = titleOf(state);
				const box = view.box;
				const style = box === null || box === void 0 ? { width: CARD_WIDTH, zIndex: active ? 40 : 30 } : {
					left: box.x,
					top: box.y,
					right: "auto",
					width: box.w,
					height: box.h,
					maxHeight: "none",
					zIndex: active ? 40 : 30
				};
				const answerText = state.mode === "run" ? state.text : (() => {
					for (let index = state.turns.length - 1; index >= 0; index -= 1) {
						const turn = state.turns[index];
						if (turn.answer !== "") return turn.answer;
					}
					return "";
				})();
				const selectionAt = active ? selectionRef.current : view.selection;
				const collapse = () => active ? setCardCollapsed((value) => value !== true) : updateStackItem(view.key, (item) => ({ collapsed: item.collapsed !== true }));
				const minimize = () => active ? setCardMinimized(true) : updateStackItem(view.key, { minimized: true });
				const close = () => active ? closeCard() : removeStackItem(view.key);
				const toggleQuote = () => active ? setQuoteOpen((value) => value !== true) : updateStackItem(view.key, (item) => ({ quoteOpen: item.quoteOpen !== true }));
				const drag = (event) => active ? startCardDrag(event) : beginPointerFor(event, "move", "", () => stackBoxOf(view), (next) => updateStackItem(view.key, { box: next }));
				const resize = (event, dir) => active ? startCardResize(event, dir) : beginPointerFor(event, "resize", dir, () => stackBoxOf(view), (next) => updateStackItem(view.key, { box: next }));
				const copyResult = (withCode) => {
					if (answerText.trim() === "") { showToast(copyRef.current.empty); return; }
					const payload = withCode ? extractCodeBlocks(answerText).join("\n\n") : answerText;
					if (withCode && payload === "") { showToast(copyRef.current.noCode); return; }
					copyText(payload).then(() => showToast(withCode ? copyRef.current.copiedCode : copyRef.current.copied), () => showToast(copyRef.current.copyFailed));
				};
				const insertResult = () => {
					if (answerText.trim() === "") { showToast(copyRef.current.empty); return; }
					showToast(insertIntoComposer(answerText) ? copyRef.current.inserted : copyRef.current.insertFailed);
				};
				const locateResult = () => {
					const target = selectionAt === null || selectionAt === void 0 ? null : selectionAt.element;
					if (target === null || target === void 0 || target.isConnected !== true) { showToast(copyRef.current.locateFailed); return; }
					try { target.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { try { target.scrollIntoView(); } catch {} }
					const previousOutline = target.style.outline;
					const previousOutlineOffset = target.style.outlineOffset;
					const previousBackground = target.style.background;
					target.style.outline = "2px solid #6f5bd8";
					target.style.outlineOffset = "2px";
					target.style.background = "rgba(111, 91, 216, 0.12)";
					window.setTimeout(() => {
						target.style.outline = previousOutline;
						target.style.outlineOffset = previousOutlineOffset;
						target.style.background = previousBackground;
					}, LOCATE_HIGHLIGHT_MS);
				};
				const followUp = () => active ? beginFollowUp() : promoteStackItem(view.key);
				const quoteText = String(state.source ?? state.text ?? "");
				const collapsed = view.collapsed === true;
				return (0, react.createElement)("aside", {
					ref: active ? cardRef : null,
					className: "dst-card" + (collapsed === true ? " dst-card-collapsed" : "") + (active ? "" : " dst-card-frozen"),
					"data-dst-role": "card",
					"data-dst-active": active ? "true" : "false",
					role: "dialog",
					"aria-label": title,
					style
				}, ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((dir) => (0, react.createElement)("div", {
					key: dir,
					className: "dst-resize dst-resize-" + dir,
					"data-dst-resize": dir,
					onPointerDown: (event) => resize(event, dir)
				})), (0, react.createElement)("header", {
					className: "dst-card-head",
					onPointerDown: drag,
					onDoubleClick: (event) => {
						if (event.target !== event.currentTarget) return;
						if (active) resetCardBox();
					}
				}, (0, react.createElement)("span", { className: "dst-card-title" }, title), (0, react.createElement)("span", { className: "dst-card-actions" }, (0, react.createElement)("button", {
					type: "button",
					className: "dst-icon-btn",
					title: collapsed === true ? copy.unfold : copy.fold,
					"aria-label": collapsed === true ? copy.unfold : copy.fold,
					onClick: collapse
				}, icon(collapsed === true ? "chevronUp" : "chevronDown", 16)), (0, react.createElement)("button", {
					type: "button",
					className: "dst-icon-btn",
					title: copy.minimize,
					"aria-label": copy.minimize,
					onClick: minimize
				}, icon("minus", 16)), (0, react.createElement)("button", {
					type: "button",
					className: "dst-icon-btn",
					title: copy.close,
					"aria-label": copy.close,
					onClick: close
				}, icon("close", 16)))), collapsed === true ? null : (0, react.createElement)("div", {
					className: "dst-card-status",
					"data-dst-role": "status"
				}, (0, react.createElement)("span", {
					className: "dst-dot",
					"data-state": state.status
				}), (0, react.createElement)("span", null, statusTextOf(state)), viaOf(state) === "" ? null : (0, react.createElement)("span", { className: "dst-card-via" }, "\u00b7 " + viaOf(state))), collapsed === true ? null : (0, react.createElement)("div", {
					className: "dst-card-quote" + (view.quoteOpen === true ? "" : " dst-card-quote-clamped"),
					"data-dst-role": "selection",
					title: copy.selection,
					onClick: toggleQuote
				}, (0, react.createElement)("span", { className: "dst-card-quote-label" }, copy.selection), (0, react.createElement)("span", { className: "dst-card-quote-text" }, quoteText === "" ? copy.selectionEmpty : quoteText)), collapsed === true ? null : (0, react.createElement)("div", {
					ref: active ? answerRef : null,
					className: "dst-card-answer",
					"data-dst-role": "answer"
				}, renderAnswerFor(state)), collapsed === true ? null : state.showInput === true ? (0, react.createElement)("div", { className: "dst-card-compose" }, (0, react.createElement)("textarea", {
					ref: active ? inputRef : null,
					className: "dst-card-input",
					"data-dst-role": "input",
					rows: 1,
					value: active ? input : "",
					placeholder: copy.askPlaceholder,
					onChange: active ? (event) => setInput(String(event.target.value)) : void 0,
					onKeyDown: active ? onInputKeyDown : void 0
				}), (0, react.createElement)("button", {
					type: "button",
					className: "dst-card-send",
					disabled: state.status === "running" || (active && input.trim() === ""),
					onClick: active ? submitAsk : void 0
				}, copy.send)) : null, collapsed === true ? null : (0, react.createElement)("footer", { className: "dst-card-foot" }, (0, react.createElement)("button", {
					type: "button",
					className: "dst-result",
					"data-dst-result": "copy",
					disabled: state.status === "running",
					onClick: () => copyResult(false)
				}, copy.copy), (0, react.createElement)("button", {
					type: "button",
					className: "dst-result",
					"data-dst-result": "copy-code",
					disabled: state.status === "running",
					onClick: () => copyResult(true)
				}, copy.copyCode), (0, react.createElement)("button", {
					type: "button",
					className: "dst-result",
					"data-dst-result": "insert",
					disabled: state.status === "running",
					onClick: insertResult
				}, copy.insert), (0, react.createElement)("button", {
					type: "button",
					className: "dst-result",
					"data-dst-result": "locate",
					disabled: state.status === "running",
					onClick: locateResult
				}, copy.locate), (0, react.createElement)("span", { className: "dst-foot-spacer" }), (0, react.createElement)("button", {
					type: "button",
					className: "dst-result dst-card-followup",
					onClick: followUp
				}, copy.followUp), (0, react.createElement)("button", {
					type: "button",
					className: "dst-result",
					onClick: close
				}, copy.close)));
			};
			const cardNodes = card !== null && cardMinimized !== true ? [buildCardView({ key: 0, card, box: cardBox, collapsed: cardCollapsed, minimized: cardMinimized, quoteOpen, selection: selectionRef.current }, true)] : [];
			const stackCardNodes = stack.filter((item) => item.minimized !== true).map((item) => buildCardView(item, false));
			const pillNodes = [...stack.filter((item) => item.minimized === true).map((item) => (0, react.createElement)("button", {
				key: "pill-" + item.key,
				type: "button",
				className: "dst-card-pill",
				title: copy.restore,
				"aria-label": copy.restore,
				onClick: () => updateStackItem(item.key, { minimized: false })
			}, icon("ask", 14), (0, react.createElement)("span", null, titleOf(item.card))))];
			const activeTitle = card === null ? "" : titleOf(card);
			const activePill = card === null || cardMinimized !== true ? null : (0, react.createElement)("button", {
				type: "button",
				className: "dst-card-pill",
				title: copy.restore,
				"aria-label": copy.restore,
				onClick: () => setCardMinimized(false)
			}, icon("ask", 14), (0, react.createElement)("span", null, activeTitle));
			if (activePill !== null) pillNodes.push(activePill);
			const toastNode = toast === null ? null : (0, react.createElement)("div", {
				className: "dst-toast",
				role: "status",
				"aria-live": "polite"
			}, toast.text);
			return (0, react.createElement)("div", {
				ref: rootRef,
				className: "dst-root"
			}, floatNode, ...stackCardNodes, ...cardNodes, ...pillNodes, toastNode);
		}
		//#endregion
		//#region src/client/settings.tsx
		/**
		* 设置页里的「划词工具」一页（settings.section）。
		*
		* 数据流：宿主半边持有设置文件（dsh-floating-assistant.json）与 HTTP 路由，
		* 这里只用同源 fetch 读写——不依赖官方 settings 服务，插件在任何 profile 下都能用。
		*
		* 模型下拉的候选来自官方 \`ctx.modelDirectories\`（与输入框的模型座位同一份目录），
		* 目录读不到时退化成手填 provider / model。
		*/
		/** 文案。 */
		const COPY = {
			zh: {
				title: "划词工具",
				eyebrow: "dsh-floating-assistant",
				hint: "让每一次划词，都更懂你的意思。",
				autoSave: "自动保存",
				languageTitle: "翻译偏好",
				languageDescription: "选择你习惯阅读的语言。",
				modelTitle: "模型配置",
				modelDescription: "为翻译、解释与总结分别选择合适的模型。",
				rulesTitle: "回答规则",
				rulesDescription: "微调语气、格式与内容，让回答更合心意。",
				stepSelect: "选中文字",
				stepAction: "解释、总结、翻译，或引用到会话里问问",
				stepRead: "即刻阅读",
				explainShort: "解释规则",
				summarizeShort: "总结规则",
				translateShort: "翻译规则",
				customRules: "自定义",
				defaultRules: "默认规则",
				stepHint: "起于划词，止于读懂。",
				previewLabel: "浮层外观",
				previewSrc: "Select any sentence, then pick Explain, Summarize, or Translate.",
				previewOut: "选中即问：解释/总结/翻译在原处作答，问问把原文（连同上文）引用进当前会话或新会话。",
				previewNote: "以上为示意，正式回答由你配置的模型生成。",
				targetLabel: "默认翻译至",
				targetHint: "自动模式下，中文译为英文，其他语言译为中文。",
				fallbackLabel: "反向目标语言",
				fallbackHint: "原文与目标语言相同时，使用此语言；自动模式下中英互译。",
				explainRulesLabel: "解释规则（交给模型的要求）",
				explainRulesHint: "每行一条要求，将直接用于生成解释。",
				summarizeRulesLabel: "总结规则（交给模型的要求）",
				summarizeRulesHint: "每行一条要求，将直接用于生成总结。",
				translateRulesLabel: "翻译规则（交给模型的要求）",
				translateRulesHint: "每行一条要求，将直接用于生成翻译。",
				restore: "恢复默认",
				translateModelLabel: "翻译使用的模型",
				explainModelLabel: "解释使用的模型",
				summarizeModelLabel: "总结使用的模型",
				modelHint: "「跟随当前会话」= 用你当前对话正在用的模型。",
				fallbackTitle: "上游过载时换 provider 兜底",
				fallbackHint: "同 provider 的模型都被打回（429）时，最后再试下面这个模型；选中的文字会发给该服务。",
				fallbackModelLabel: "兜底模型",
				fallbackModelHint: "建议选一个和主模型不同服务商的模型；不选则不跨 provider 兜底。",
				fallbackModelEmpty: "不设置（不跨 provider 兜底）",
				mtLabel: "翻译通道",
				mtHint: "机译走浏览器同款的匿名端点（免登录、更快），失败或超长会自动回到模型座位；解释与总结仍走模型。",
				mtBing: "Bing 机译（免费）",
				mtGoogle: "Google 机译（免费）",
				mtLlm: "AI 模型（用下面的模型座位）",
				askBlockTitle: "问问",
				askBlockDescription: "在 DSH 里划词点「问问」时，随引用一起带进会话的内容。",
				styleBlockTitle: "回答风格",
				styleBlockDescription: "统一控制解释、总结、翻译的回答长度与展开程度。",
				styleLabel: "默认风格",
				styleHint: "简洁=先给结论、不展开；详细=给依据与步骤。",
				styleConcise: "简洁",
				styleStandard: "标准",
				styleDetailed: "详细",
				personaLabel: "自定义角色（可选）",
				personaHint: "只影响语气与侧重，不改变事实与规则；最多 500 字。",
				personaPlaceholder: "例如：用耐心的老师语气解释，多用类比。",
				askContextTitle: "引用时附带上文",
				askContextHint: "把选区所在的段落作为「上文」附在引用后面，会话里的模型才知道这个词指的是什么；选区本身就是整段时会自动省略。",
				effortLabel: "推理等级",
				effortDefault: "适配器默认",
				followSession: "跟随当前会话",
				auto: "跟随原文自动（中 ↔ 英）",
				autoMirror: "自动（镜像）",
				manualHint: "暂时读不到模型目录，可直接填写 provider / model。",
				provider: "provider",
				model: "model",
				saved: "已保存",
				saving: "保存中…",
				failed: "保存失败",
				loading: "读取设置中…",
				loadFailed: "读取设置失败",
				retry: "重试"
			},
			en: {
				title: "Selection tools",
				eyebrow: "dsh-floating-assistant",
				hint: "A little more understanding, with every selection.",
				autoSave: "Auto-save on",
				languageTitle: "Translation preferences",
				languageDescription: "Read in the language that feels like home.",
				modelTitle: "Model preferences",
				modelDescription: "Choose the right model for each task.",
				rulesTitle: "Response rules",
				rulesDescription: "Fine-tune the tone, format, and level of detail.",
				stepSelect: "Select text",
				stepAction: "Explain, summarize, translate, or quote it into a conversation",
				stepRead: "Keep reading",
				explainShort: "Explanation rules",
				summarizeShort: "Summary rules",
				translateShort: "Translation rules",
				customRules: "Custom",
				defaultRules: "Default rules",
				stepHint: "It starts with a selection and ends with understanding.",
				previewLabel: "Panel preview",
				previewSrc: "Select any sentence, then pick Explain, Summarize, or Translate.",
				previewOut: "Read it on the spot — explanation, summary, or translation, without leaving the page.",
				previewNote: "Illustrative only — real answers come from the model you configure.",
				targetLabel: "Translate into",
				targetHint: "\"Follow the source\" keeps the original behaviour: Chinese → English, anything else → Chinese.",
				fallbackLabel: "Fallback target",
				fallbackHint: "Used when the selection is already in the primary target language.",
				explainRulesLabel: "Explain rules (given to the model)",
				explainRulesHint: "Sent verbatim as the \"Requirements\" block of the explain prompt, one rule per line.",
				summarizeRulesLabel: "Summary rules (given to the model)",
				summarizeRulesHint: "Sent verbatim as the \"Requirements\" block of the summary prompt, one rule per line.",
				translateRulesLabel: "Translate rules (given to the model)",
				translateRulesHint: "Sent verbatim as the \"Requirements\" block of the translate prompt, one rule per line.",
				restore: "Restore default",
				translateModelLabel: "Model for translation",
				explainModelLabel: "Model for explanation",
				summarizeModelLabel: "Model for summarization",
				modelHint: "\"Follow the current session\" uses whatever model your conversation uses.",
				fallbackTitle: "Fall back to another provider when overloaded",
				fallbackHint: "When every model on the primary provider keeps returning 429, try this one last; the selected text is sent to that service.",
				fallbackModelLabel: "Fallback model",
				fallbackModelHint: "Pick a model from a different vendor than the main one. Leave empty to disable cross-provider fallback.",
				fallbackModelEmpty: "Not set (no cross-provider fallback)",
				mtLabel: "Translate with",
				mtHint: "Machine translation uses the same anonymous endpoints as the browser (no login, faster); failures or oversized selections fall back to the model seats below. Explain and summarize always use the model.",
				mtBing: "Bing (free)",
				mtGoogle: "Google (free)",
				mtLlm: "AI model (seats below)",
				askBlockTitle: "Ask in chat",
				askBlockDescription: "What gets carried into the conversation when you press Ask on a selection.",
				styleBlockTitle: "Answer style",
				styleBlockDescription: "Controls the length and depth of Explain, Summarize and Translate answers.",
				styleLabel: "Default style",
				styleHint: "Concise = conclusion first; Detailed = reasoning and evidence.",
				styleConcise: "Concise",
				styleStandard: "Standard",
				styleDetailed: "Detailed",
				personaLabel: "Custom role (optional)",
				personaHint: "Affects tone and emphasis only, never facts or rules. Up to 500 characters.",
				personaPlaceholder: "e.g. Explain like a patient teacher, with analogies.",
				askContextTitle: "Attach surrounding text",
				askContextHint: "Adds the paragraph around the selection as context so the model knows what it refers to; omitted when the selection already covers that paragraph.",
				effortLabel: "Reasoning effort",
				effortDefault: "Adapter default",
				followSession: "Follow current session",
				auto: "Follow the source (zh ↔ en)",
				autoMirror: "Automatic (mirror)",
				manualHint: "The model catalog is not available yet — type provider / model directly.",
				provider: "provider",
				model: "model",
				saved: "Saved",
				saving: "Saving…",
				failed: "Save failed",
				loading: "Loading…",
				loadFailed: "Could not load settings",
				retry: "Retry"
			}
		};
		/** 语言下拉的选项（含"自动"）。 */
		function languageOptions(autoLabel) {
			return [{
				id: AUTO_LANGUAGE_ID,
				label: autoLabel
			}, ...LANGUAGES.map((item) => ({
				id: item.id,
				label: item.label + " (" + item.prompt + ")"
			}))];
		}
		/**
		* 读模型目录。
		*
		* 两个来源，按优先级用：
		* 1. 当前会话的模型座位目录（`modelDirectories.directoryFor(sessionId)`）——与输入框同一份，
		*    但**只有存在当前会话时才有**；
		* 2. 全局模型目录（`modelDirectories.catalog`）——设置页常常在"还没开会话"时被打开，
		*    这时只能用它（它是一次 host RPC，不依赖会话）。
		*/
		function useModelCatalog(ctx) {
			const [groups, setGroups] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				const directories = ctx.get?.("modelDirectories");
				if (directories === void 0 || directories === null) return void 0;
				let directory;
				try {
					const sessionId = ctx.get?.("sessions")?.list?.getSnapshot?.()?.current;
					directory = sessionId === void 0 ? void 0 : directories.directoryFor?.(sessionId);
				} catch {
					directory = void 0;
				}
				const catalog = directories.catalog;
				const read = () => {
					const fromDirectory = directory?.store?.getSnapshot?.();
					const fromCatalog = catalog?.store?.getSnapshot?.();
					const directoryGroups = Array.isArray(fromDirectory?.groups) ? fromDirectory.groups : [];
					const catalogGroups = Array.isArray(fromCatalog?.value?.groups) ? fromCatalog.value.groups : [];
					setGroups(directoryGroups.length > 0 ? directoryGroups : catalogGroups);
				};
				const stops = [];
				for (const store of [directory?.store, catalog?.store]) {
					if (typeof store?.subscribe !== "function") continue;
					const stop = store.subscribe(read);
					if (typeof stop === "function") stops.push(stop);
				}
				try {
					catalog?.load?.().catch?.(() => void 0);
				} catch {}
				read();
				return () => {
					for (const stop of stops) stop();
				};
			}, [ctx]);
			return {
				groups,
				ready: groups.length > 0
			};
		}
		/** 一个模型座位选择器（模型 + 推理等级）。 */
		function ModelSeatField(props) {
			const { label, hint, copy, seat, groups, catalogsReady, onChange, emptyLabel } = props;
			const flat = (0, react.useMemo)(() => groups.flatMap((group) => (group.models ?? []).map((model) => ({
				key: group.id + "/" + model.id,
				provider: group.id,
				providerLabel: group.name ?? group.label ?? group.id,
				model
			}))), [groups]);
			const current = seat === null ? "" : seat.provider + "/" + seat.model;
			const efforts = (0, react.useMemo)(() => {
				if (seat === null) return [];
				return flat.find((item) => item.provider === seat.provider && item.model.id === seat.model)?.model.reasoning?.efforts ?? [];
			}, [flat, seat]);
			const pickModel = (value) => {
				if (value === "") {
					onChange(null);
					return;
				}
				const found = flat.find((item) => item.key === value);
				if (found === void 0) return;
				const defaultEffort = found.model.reasoning?.defaultEffort;
				onChange({
					provider: found.provider,
					model: found.model.id,
					...defaultEffort === void 0 ? {} : { reasoningEffort: defaultEffort }
				});
			};
			const rows = [];
			rows.push((0, react.createElement)("span", { className: "dst-set-label" }, label), catalogsReady ? (0, react.createElement)("select", {
				className: "dst-set-input",
				"aria-label": label,
				value: current,
				onChange: (event) => pickModel(String(event.target.value))
			}, [(0, react.createElement)("option", {
				key: "",
				value: ""
			}, emptyLabel ?? copy.followSession), ...flat.map((item) => (0, react.createElement)("option", {
				key: item.key,
				value: item.key
			}, item.providerLabel + " · " + (item.model.name ?? item.model.id)))]) : (0, react.createElement)("div", { className: "dst-set-row" }, (0, react.createElement)("input", {
				className: "dst-set-input",
				placeholder: copy.provider,
				"aria-label": label + " · " + copy.provider,
				value: seat?.provider ?? "",
				onChange: (event) => onChange({
					provider: String(event.target.value),
					model: seat?.model ?? ""
				})
			}), (0, react.createElement)("input", {
				className: "dst-set-input",
				placeholder: copy.model,
				"aria-label": label + " · " + copy.model,
				value: seat?.model ?? "",
				onChange: (event) => onChange({
					provider: seat?.provider ?? "",
					model: String(event.target.value)
				})
			})));
			if (catalogsReady && seat !== null && efforts.length > 0) rows.push((0, react.createElement)("div", { className: "dst-set-row" }, (0, react.createElement)("span", { className: "dst-set-sub" }, copy.effortLabel), (0, react.createElement)("select", {
				className: "dst-set-input",
				"aria-label": label + " · " + copy.effortLabel,
				value: seat.reasoningEffort ?? "",
				onChange: (event) => {
					const effort = String(event.target.value);
					onChange({
						provider: seat.provider,
						model: seat.model,
						...effort === "" ? {} : { reasoningEffort: effort }
					});
				}
			}, [(0, react.createElement)("option", {
				key: "",
				value: ""
			}, copy.effortDefault), ...efforts.map((effort) => (0, react.createElement)("option", {
				key: effort.id,
				value: effort.id
			}, effort.name ?? effort.id))])));
			rows.push((0, react.createElement)("span", { className: "dst-set-hint" }, catalogsReady ? hint : copy.manualHint));
			return (0, react.createElement)("div", { className: "dst-set-field" }, ...rows);
		}
		/**
		* 「划词工具」设置页。
		* @param props.ctx - 客户端 Cordis 上下文。
		*/
		function SettingsSection(props) {
			const { ctx } = props;
			const locale = detectLocale();
			const copy = COPY[locale];
			const [settings, setSettings] = (0, react.useState)(null);
			const [status, setStatus] = (0, react.useState)("loading");
			const [error, setError] = (0, react.useState)("");
			const timer = (0, react.useRef)(null);
			const { groups, ready: catalogsReady } = useModelCatalog(ctx);
			const load = (0, react.useCallback)(() => {
				setStatus("loading");
				fetch(API_PREFIX + "/settings").then((response) => response.ok ? response.json() : Promise.reject(/* @__PURE__ */ new Error("HTTP " + response.status))).then((payload) => {
					setSettings(normalizeSettings(payload.settings));
					setStatus("ready");
					setError("");
				}).catch((cause) => {
					setStatus("error");
					setError(cause instanceof Error ? cause.message : String(cause));
				});
			}, []);
			(0, react.useEffect)(() => {
				load();
				return () => {
					if (timer.current !== null) window.clearTimeout(timer.current);
				};
			}, [load]);
			/** 改一项 → 立刻本地生效 + 防抖落盘。 */
			const update = (0, react.useCallback)((patch) => {
				setSettings((current) => {
					if (current === null) return current;
					const next = normalizeSettings({
						...current,
						...patch
					});
					setStatus("saving");
					if (timer.current !== null) window.clearTimeout(timer.current);
					timer.current = window.setTimeout(() => {
						timer.current = null;
						fetch(API_PREFIX + "/settings", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(next)
						}).then((response) => response.ok ? response.json() : Promise.reject(/* @__PURE__ */ new Error("HTTP " + response.status))).then((payload) => {
							setSettings(normalizeSettings(payload.settings));
							setStatus("saved");
							setError("");
						}).catch((cause) => {
							setStatus("error");
							setError(cause instanceof Error ? cause.message : String(cause));
						});
					}, 220);
					return next;
				});
			}, []);
			const statusText = status === "saving" ? copy.saving : status === "saved" ? copy.saved : status === "error" ? copy.failed : copy.autoSave;
			/** 渐变抬头（加载态与正文共用，避免骨架和内容长得不一样）。 */
			const hero = (showSteps) => (0, react.createElement)("header", { className: "dst-hero" }, (0, react.createElement)("div", { className: "dst-hero-top" }, (0, react.createElement)("div", { className: "dst-set-heading" }, (0, react.createElement)("span", { className: "dst-eyebrow" }, copy.eyebrow), (0, react.createElement)("h2", { className: "dst-set-title" }, copy.title), (0, react.createElement)("p", { className: "dst-set-hint dst-set-intro" }, copy.hint)), (0, react.createElement)("span", {
				className: "dst-set-save",
				"data-state": status,
				role: "status",
				"aria-live": "polite"
			}, status === "saving" ? (0, react.createElement)("span", {
				className: "dst-set-spinner",
				"aria-hidden": true
			}) : (0, react.createElement)(ToolIcon, {
				name: "check",
				size: 14
			}), statusText)), showSteps ? (0, react.createElement)("div", {
				className: "dst-hero-steps",
				"aria-label": copy.stepHint
			}, (0, react.createElement)("span", {
				className: "dst-hero-step",
				"data-active": "true"
			}, "1 · " + copy.stepSelect), (0, react.createElement)("span", {
				className: "dst-hero-arrow",
				"aria-hidden": true
			}, "›"), (0, react.createElement)("span", { className: "dst-hero-step" }, "2 · " + copy.stepAction), (0, react.createElement)("span", {
				className: "dst-hero-arrow",
				"aria-hidden": true
			}, "›"), (0, react.createElement)("span", { className: "dst-hero-step" }, "3 · " + copy.stepRead)) : null);
			if (settings === null) return (0, react.createElement)("div", { className: "dst-set-section" }, hero(false), (0, react.createElement)("div", { className: "dst-set-status" }, (0, react.createElement)("span", { className: status === "error" ? "dst-set-error" : "" }, status === "error" ? copy.loadFailed + "：" + error : copy.loading), status === "error" ? (0, react.createElement)("button", {
				type: "button",
				className: "dst-set-link",
				onClick: load
			}, copy.retry) : null));
			const languageField = (label, hint, value, autoLabel, key) => (0, react.createElement)("div", {
				className: "dst-set-field",
				key
			}, (0, react.createElement)("label", {
				className: "dst-set-label",
				htmlFor: "dst-" + key
			}, label), (0, react.createElement)("select", {
				id: "dst-" + key,
				className: "dst-set-input",
				value,
				onChange: (event) => update({ [key]: String(event.target.value) })
			}, languageOptions(autoLabel).map((option) => (0, react.createElement)("option", {
				key: option.id,
				value: option.id
			}, option.label))), (0, react.createElement)("span", { className: "dst-set-hint" }, hint));
			/** 一个普通下拉（「翻译通道」这类枚举选项）。 */
			const selectField = (label, hint, value, options, key) => (0, react.createElement)("div", {
				className: "dst-set-field",
				key
			}, (0, react.createElement)("label", {
				className: "dst-set-label",
				htmlFor: "dst-" + key
			}, label), (0, react.createElement)("select", {
				id: "dst-" + key,
				className: "dst-set-input",
				value,
				onChange: (event) => update({ [key]: String(event.target.value) })
			}, options.map((option) => (0, react.createElement)("option", {
				key: option.id,
				value: option.id
			}, option.label))), (0, react.createElement)("span", { className: "dst-set-hint" }, hint));
			const rulesField = (key, label, hint, value, fallback) => (0, react.createElement)("details", {
				className: "dst-set-rule",
				key
			}, (0, react.createElement)("summary", { className: "dst-set-rule-summary" }, (0, react.createElement)(ToolIcon, {
				name: key === "explainRules" ? "sparkle" : key === "summarizeRules" ? "list" : "language",
				size: 18
			}), (0, react.createElement)("span", { className: "dst-set-rule-name" }, label), (0, react.createElement)("span", {
				className: "dst-set-rule-badge",
				"data-custom": value !== fallback
			}, value === fallback ? copy.defaultRules : copy.customRules), (0, react.createElement)("span", { className: "dst-set-rule-chevron" }, (0, react.createElement)(ToolIcon, {
				name: "chevron",
				size: 16
			}))), (0, react.createElement)("div", { className: "dst-set-rule-body" }, (0, react.createElement)("textarea", {
				className: "dst-set-textarea",
				"aria-label": label,
				rows: 6,
				spellCheck: false,
				value,
				onChange: (event) => update({ [key]: String(event.target.value) })
			}), (0, react.createElement)("div", { className: "dst-set-labelrow" }, (0, react.createElement)("span", { className: "dst-set-hint" }, hint), (0, react.createElement)("button", {
				type: "button",
				className: "dst-set-link",
				disabled: value === fallback,
				onClick: () => update({ [key]: fallback })
			}, copy.restore))));
			/** 一条滑块（语速 / 音量）：左边是标签与当前值，下面是轨道。 */
			const sliderField = (key, label, hint, min, max, lowLabel, highLabel) => (0, react.createElement)("div", {
				className: "dst-set-field",
				key
			}, (0, react.createElement)("div", { className: "dst-set-slider-head" }, (0, react.createElement)("label", {
				className: "dst-set-label",
				htmlFor: "dst-" + key
			}, label), (0, react.createElement)("span", { className: "dst-set-slider-value" }, String(settings[key]))), (0, react.createElement)("input", {
				id: "dst-" + key,
				className: "dst-set-range",
				type: "range",
				min,
				max,
				step: 1,
				value: settings[key],
				onChange: (event) => update({ [key]: Number(event.target.value) })
			}), (0, react.createElement)("div", {
				className: "dst-set-range-ends",
				"aria-hidden": true
			}, (0, react.createElement)("span", null, lowLabel), (0, react.createElement)("span", null, highLabel)), (0, react.createElement)("span", { className: "dst-set-hint" }, hint));
			/** 一个开关行（复选框）：用于「跨 provider 兜底」这类二元选项。 */
			const switchField = (label, hint, value, onChange) => (0, react.createElement)("div", {
				className: "dst-set-field"
			}, (0, react.createElement)("label", {
				className: "dst-set-label",
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					cursor: "pointer"
				}
			}, (0, react.createElement)("input", {
				type: "checkbox",
				checked: value === true,
				style: {
					width: 15,
					height: 15,
					margin: 0,
					accentColor: "var(--dst-accent)"
				},
				onChange: (event) => onChange(event.target.checked)
			}), (0, react.createElement)("span", null, label)), (0, react.createElement)("span", { className: "dst-set-hint" }, hint));
			/** 一段编号设置区（01 / 02 / 03 / 04），替代旧版的图标卡片。 */
			const block = (index, title, description, content) => (0, react.createElement)("section", {
				className: "dst-set-block",
				"aria-label": title
			}, (0, react.createElement)("div", { className: "dst-set-block-head" }, (0, react.createElement)("span", {
				className: "dst-set-block-index",
				"aria-hidden": true
			}, index), (0, react.createElement)("div", null, (0, react.createElement)("h3", { className: "dst-set-block-title" }, title), (0, react.createElement)("p", { className: "dst-set-hint" }, description))), content);
			return (0, react.createElement)("div", { className: "dst-set-section" }, hero(true), status === "error" ? (0, react.createElement)("div", {
				className: "dst-set-error-banner",
				role: "alert"
			}, copy.failed + "：" + error, (0, react.createElement)("button", {
				type: "button",
				className: "dst-set-link",
				onClick: () => update({})
			}, copy.retry)) : null, block("01", copy.languageTitle, copy.languageDescription, (0, react.createElement)("div", { className: "dst-set-grid" }, languageField(copy.targetLabel, copy.targetHint, settings.targetLanguage, copy.auto, "targetLanguage"), languageField(copy.fallbackLabel, copy.fallbackHint, settings.fallbackLanguage, copy.autoMirror, "fallbackLanguage"), selectField(copy.mtLabel, copy.mtHint, settings.translateEngine, [{
				id: "bing",
				label: copy.mtBing
			}, {
				id: "google",
				label: copy.mtGoogle
			}, {
				id: "llm",
				label: copy.mtLlm
			}], "translateEngine"))), block("02", copy.modelTitle, copy.modelDescription, (0, react.createElement)("div", { className: "dst-set-grid" }, (0, react.createElement)(ModelSeatField, {
				label: copy.translateModelLabel,
				hint: copy.modelHint,
				copy,
				seat: settings.translateModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ translateModel: seat })
			}), (0, react.createElement)(ModelSeatField, {
				label: copy.explainModelLabel,
				hint: copy.modelHint,
				copy,
				seat: settings.explainModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ explainModel: seat })
			}), (0, react.createElement)(ModelSeatField, {
				label: copy.summarizeModelLabel,
				hint: copy.modelHint,
				copy,
				seat: settings.summarizeModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ summarizeModel: seat })
			}), switchField(copy.fallbackTitle, copy.fallbackHint, settings.crossProviderFallback, (on) => update({ crossProviderFallback: on })), (0, react.createElement)(ModelSeatField, {
				label: copy.fallbackModelLabel,
				hint: copy.fallbackModelHint,
				copy,
				emptyLabel: copy.fallbackModelEmpty,
				seat: settings.fallbackModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ fallbackModel: seat })
			}))), block("03", copy.rulesTitle, copy.rulesDescription, (0, react.createElement)("div", { className: "dst-set-rules" }, rulesField("explainRules", copy.explainShort, copy.explainRulesHint, settings.explainRules, DEFAULT_EXPLAIN_RULES), rulesField("summarizeRules", copy.summarizeShort, copy.summarizeRulesHint, settings.summarizeRules, DEFAULT_SUMMARIZE_RULES), rulesField("translateRules", copy.translateShort, copy.translateRulesHint, settings.translateRules, DEFAULT_TRANSLATE_RULES))), block("04", copy.styleBlockTitle, copy.styleBlockDescription, (0, react.createElement)("div", {
				className: "dst-set-grid"
			}, selectField(copy.styleLabel, copy.styleHint, settings.answerStyle, [
				{ id: "concise", label: copy.styleConcise },
				{ id: "standard", label: copy.styleStandard },
				{ id: "detailed", label: copy.styleDetailed }
			], "answerStyle"), (0, react.createElement)("div", {
				className: "dst-set-field",
				key: "customPersona"
			}, (0, react.createElement)("label", {
				className: "dst-set-label",
				htmlFor: "dst-customPersona"
			}, copy.personaLabel), (0, react.createElement)("textarea", {
				id: "dst-customPersona",
				className: "dst-set-textarea",
				rows: 3,
				spellCheck: false,
				placeholder: copy.personaPlaceholder,
				value: settings.customPersona,
				onChange: (event) => update({ customPersona: String(event.target.value) })
			}), (0, react.createElement)("span", { className: "dst-set-hint" }, copy.personaHint)))), block("05", copy.askBlockTitle, copy.askBlockDescription, (0, react.createElement)("div", {
				className: "dst-set-grid"
			}, switchField(copy.askContextTitle, copy.askContextHint, settings.askIncludeContext, (on) => update({ askIncludeContext: on })))), (0, react.createElement)("div", {
				className: "dst-preview",
				"aria-hidden": true
			}, (0, react.createElement)("span", { className: "dst-preview-title" }, copy.previewLabel), (0, react.createElement)("p", { className: "dst-preview-quote" }, copy.previewSrc), (0, react.createElement)("p", { className: "dst-preview-answer" }, copy.previewOut), (0, react.createElement)("span", { className: "dst-preview-note" }, copy.previewNote)));
		}
		//#endregion
		//#region src/client/styles.ts
		/** 插件样式：局部令牌、轻量卡片与浮层，深浅色跟随宿主。 */
		const STYLE_TAG_ID = "dsh-floating-assistant/client.css";
		const CSS = `
/* 局部变量不污染宿主；所有表单控件显式继承字体与主题。 */
.dst-root, .dst-set-section {
  --dst-text: var(--dsw-alias-label-primary, #202735);
  --dst-muted: var(--dsw-alias-label-secondary, #677183);
  --dst-subtle: var(--dsw-alias-label-tertiary, #788395);
  --dst-surface: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff));
			--dst-surface-solid: var(--dsw-alias-bg-layer-3, #fff);
			--dst-card-solid: #ffffff;
  --dst-soft: var(--dsw-alias-bg-layer-1, #f6f8fb);
  --dst-border: var(--dsw-alias-border-l1, #e5e9f0);
  --dst-accent: #6f5bd8;
  --dst-tint: color-mix(in srgb, var(--dst-accent) 9%, var(--dst-surface));
  --dst-hover: var(--dsw-alias-interactive-bg-hover, rgba(111, 91, 216, .07));
  --dst-hairline: color-mix(in srgb, var(--dst-text) 9%, transparent);
  color: var(--dst-text);
  font-size: 14px;
  font-family: inherit;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.dst-root *, .dst-set-section * { box-sizing: border-box; }
.dst-root button, .dst-set-section button { font: inherit; cursor: pointer; }
.dst-root svg, .dst-set-section svg { display: block; flex-shrink: 0; }
.dst-root button:focus-visible, .dst-set-section :is(button, select, input, textarea, summary):focus-visible {
  outline: 2px solid var(--dst-accent);
  outline-offset: 3px;
}
.dst-root button:disabled, .dst-set-section button:disabled { opacity: .4; cursor: default; }

/* 设置页：渐变抬头 + 三段编号设置区（刻意与旧版「图标卡片 + 流程条」拉开距离）。 */
.dst-set-section { container-type: inline-size; width: 100%; max-width: 860px; min-width: 0; margin: 0 auto; padding: 2px 0 28px; }
.dst-hero { position: relative; overflow: hidden; margin-bottom: 26px; padding: 22px 24px 18px; border-radius: 18px; border: 1px solid color-mix(in srgb, var(--dst-accent) 17%, var(--dst-border)); background: radial-gradient(120% 130% at 100% 0%, color-mix(in srgb, var(--dst-accent) 15%, transparent) 0%, transparent 58%), color-mix(in srgb, var(--dst-accent) 5%, var(--dst-surface)); }
.dst-hero-top { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.dst-set-heading { flex: 1; min-width: 180px; }
.dst-eyebrow { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 2px 9px 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--dst-accent) 13%, transparent); color: var(--dst-accent); font-size: 10px; font-weight: 650; letter-spacing: .5px; text-transform: uppercase; }
.dst-set-section .dst-set-title { margin: 0; font-size: 24px; line-height: 1.32; font-weight: 680; letter-spacing: -.6px; color: var(--dst-text); }
.dst-set-section .dst-set-hint { display: block; margin: 0; color: var(--dst-muted); font-size: 12px; line-height: 1.75; overflow-wrap: anywhere; }
.dst-set-section .dst-set-intro { margin-top: 6px; font-size: 13px; max-width: 48em; }
.dst-set-save { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 5px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dst-accent) 18%, transparent); background: color-mix(in srgb, var(--dst-surface) 70%, transparent); color: var(--dst-muted); font-size: 11px; white-space: nowrap; }
.dst-set-save[data-state="saving"] { color: var(--dst-accent); }
.dst-set-save[data-state="saved"] { color: #26845d; border-color: color-mix(in srgb, #26845d 26%, transparent); }
.dst-set-save[data-state="error"], .dst-set-error { color: #db5454; }
.dst-set-save[data-state="error"] { border-color: color-mix(in srgb, #db5454 30%, transparent); }
.dst-set-save[data-state="error"] svg { display: none; }
.dst-set-spinner { width: 11px; height: 11px; border: 1.5px solid var(--dst-border); border-top-color: var(--dst-accent); border-radius: 50%; animation: dst-spin .8s linear infinite; }
.dst-hero-steps { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 18px; padding-top: 14px; border-top: 1px dashed color-mix(in srgb, var(--dst-accent) 24%, transparent); }
.dst-hero-step { display: inline-flex; align-items: center; gap: 6px; padding: 3px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dst-accent) 13%, transparent); background: color-mix(in srgb, var(--dst-surface) 78%, transparent); color: var(--dst-muted); font-size: 11px; }
.dst-hero-step[data-active="true"] { color: var(--dst-accent); background: color-mix(in srgb, var(--dst-accent) 10%, var(--dst-surface)); border-color: color-mix(in srgb, var(--dst-accent) 32%, transparent); }
.dst-hero-arrow { color: var(--dst-subtle); }
.dst-set-block { padding-bottom: 24px; border-top: 1px solid var(--dst-hairline); }
.dst-set-block-head { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 13px; align-items: start; margin: 20px 0 16px; }
.dst-set-block-index { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: var(--dst-tint); color: var(--dst-accent); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .3px; }
.dst-set-section .dst-set-block-title { margin: 1px 0 3px; font-size: 15px; line-height: 1.45; font-weight: 650; color: var(--dst-text); }
.dst-preview { margin-top: 26px; padding: 16px 18px; border: 1px dashed color-mix(in srgb, var(--dst-accent) 28%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--dst-accent) 4%, transparent); }
.dst-preview-title { display: block; margin-bottom: 12px; color: var(--dst-accent); font-size: 10px; font-weight: 650; letter-spacing: .6px; text-transform: uppercase; }
.dst-preview-quote { margin: 0 0 12px; padding-left: 12px; border-left: 2px solid color-mix(in srgb, var(--dst-accent) 38%, transparent); color: var(--dst-muted); font-size: 12px; line-height: 1.7; }
.dst-preview-answer { margin: 0; color: var(--dst-text); font-size: 13px; line-height: 1.8; }
.dst-preview-note { display: block; margin-top: 10px; color: var(--dst-subtle); font-size: 10px; }
.dst-set-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
.dst-set-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dst-set-label { display: block; font-size: 12px; font-weight: 550; color: var(--dst-text); }
.dst-set-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dst-set-sub { flex-shrink: 0; color: var(--dst-muted); font-size: 12px; }
.dst-set-input, .dst-set-textarea { width: 100%; min-width: 0; margin: 0; padding: 10px 12px; border: 1px solid var(--dst-border); border-radius: 9px; background: var(--dst-soft); color: var(--dst-text); font-family: inherit; font-size: 13px; line-height: 1.5; transition: border-color .15s, box-shadow .15s; }
.dst-set-input { min-height: 40px; }
select.dst-set-input { padding-right: 30px; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='m5 6 3 3 3-3' fill='none' stroke='%23788395' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; cursor: pointer; text-overflow: ellipsis; }
.dst-set-input option { background: var(--dst-surface); color: var(--dst-text); }
.dst-set-input:hover, .dst-set-textarea:hover { border-color: color-mix(in srgb, var(--dst-accent) 30%, var(--dst-border)); }
.dst-set-input:focus, .dst-set-textarea:focus { border-color: var(--dst-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dst-accent) 10%, transparent); }
.dst-set-input::placeholder { color: var(--dst-subtle); }
.dst-set-rules { display: grid; gap: 10px; }
.dst-set-rule { border: 1px solid var(--dst-border); border-radius: 12px; background: color-mix(in srgb, var(--dst-soft) 55%, var(--dst-surface)); overflow: hidden; transition: border-color .15s, background .15s; }
.dst-set-rule[open] { border-color: color-mix(in srgb, var(--dst-accent) 30%, var(--dst-border)); background: var(--dst-surface); }
.dst-set-rule-summary { display: flex; align-items: center; gap: 10px; padding: 13px 15px; list-style: none; cursor: pointer; color: var(--dst-muted); transition: background .15s; }
.dst-set-rule-summary::-webkit-details-marker { display: none; }
.dst-set-rule-summary:hover { background: var(--dst-hover); }
.dst-set-rule-summary:focus-visible { outline-offset: -3px !important; }
.dst-set-rule-name { flex: 1; font-size: 13px; font-weight: 550; color: var(--dst-text); }
.dst-set-rule-badge { font-size: 10px; padding: 2px 8px; border-radius: 999px; border: 1px solid transparent; background: color-mix(in srgb, var(--dst-text) 7%, transparent); color: var(--dst-muted); }
.dst-set-rule-badge[data-custom="true"] { background: color-mix(in srgb, var(--dst-accent) 12%, transparent); border-color: color-mix(in srgb, var(--dst-accent) 26%, transparent); color: var(--dst-accent); }
.dst-set-rule-chevron { transition: transform .16s; }
.dst-set-rule[open] .dst-set-rule-chevron { transform: rotate(180deg); }
.dst-set-rule-body { padding: 0 15px 15px; }
.dst-set-textarea { display: block; resize: vertical; min-height: 140px; line-height: 1.8; }
.dst-set-labelrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; flex-wrap: wrap; }
.dst-set-slider-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.dst-set-slider-value { flex-shrink: 0; padding: 1px 8px; border-radius: 6px; background: var(--dst-tint); color: var(--dst-accent); font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
.dst-set-range { width: 100%; height: 22px; margin: 0; appearance: none; background: transparent; cursor: pointer; }
.dst-set-range::-webkit-slider-runnable-track { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--dst-accent) 20%, var(--dst-border)); }
.dst-set-range::-webkit-slider-thumb { appearance: none; width: 15px; height: 15px; margin-top: -5.5px; border-radius: 50%; border: 2px solid var(--dst-surface); background: var(--dst-accent); box-shadow: 0 1px 4px #101b3233; }
.dst-set-range::-moz-range-track { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--dst-accent) 20%, var(--dst-border)); }
.dst-set-range::-moz-range-thumb { width: 15px; height: 15px; border: 2px solid var(--dst-surface); border-radius: 50%; background: var(--dst-accent); }
.dst-set-range:focus-visible { outline: 2px solid color-mix(in srgb, var(--dst-accent) 45%, transparent); outline-offset: 3px; }
.dst-set-range-ends { display: flex; justify-content: space-between; margin-top: -4px; color: var(--dst-subtle); font-size: 10px; }
.dst-set-section .dst-set-link { display: inline-flex; align-items: center; flex-shrink: 0; min-height: 28px; padding: 2px 6px; border: none; border-radius: 5px; background: transparent; color: var(--dst-accent); font-size: 12px; }
.dst-set-link:hover:not(:disabled) { background: var(--dst-tint); }
.dst-set-status, .dst-set-error-banner { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 10px; background: var(--dst-soft); font-size: 13px; overflow-wrap: anywhere; }
.dst-set-error-banner { color: #db5454; border: 1px solid color-mix(in srgb, #db5454 25%, transparent); }

/* 划词菜单：一次品牌标记，两个紧凑操作。 */
.dst-menu { position: fixed; z-index: 2400; display: flex; flex-direction: column; padding: 6px; background: var(--dst-surface); border: 1px solid var(--dst-border); border-radius: 14px; box-shadow: 0 12px 36px #101b3224, 0 2px 6px #101b320a; animation: dst-fade-in .14s ease-out; }
.dst-menu-caption { display: flex; align-items: center; justify-content: space-between; height: 26px; padding: 0 9px; color: var(--dst-subtle); font-size: 10px; letter-spacing: .2px; }
.dst-menu-caption span:last-child { font-size: 9px; border: 1px solid var(--dst-border); border-radius: 4px; padding: 0 4px; line-height: 15px; }
.dst-menu-item { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dst-text); text-align: left; }
.dst-menu-item:hover { background: var(--dst-tint); color: var(--dst-accent); }
.dst-menu-item-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 26px; height: 26px; border-radius: 7px; color: var(--dst-accent); background: var(--dst-tint); }
.dst-menu-item-label { flex: 1; min-width: 0; white-space: nowrap; font-size: 13px; font-weight: 500; }
.dst-menu-arrow { color: var(--dst-subtle); opacity: 0; transition: opacity .15s; }
.dst-menu-item:hover .dst-menu-arrow, .dst-menu-item:focus-visible .dst-menu-arrow { opacity: 1; }

/* 回答浮层：紧凑标题栏、引用原文、独立阅读区。 */
.dst-panel { position: fixed; z-index: 2390; display: flex; flex-direction: column; min-width: 280px; min-height: 180px; background: var(--dst-surface); border: 1px solid var(--dst-border); border-radius: 16px; box-shadow: 0 20px 60px #101b3229, 0 3px 12px #101b320d; animation: dst-fade-in .16s ease-out; }
.dst-panel-header { display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-height: 56px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--dst-border); cursor: grab; touch-action: none; user-select: none; }
.dst-panel-header:active { cursor: grabbing; }
.dst-panel-title { min-width: 0; font-size: 14px; font-weight: 600; }
.dst-panel-brand { margin-left: 4px; color: var(--dst-subtle); font-size: 10px; font-weight: 400; }
.dst-panel-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; }
.dst-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--dst-muted); }
.dst-icon-btn:hover:not(:disabled) { background: var(--dst-hover); color: var(--dst-text); }
.dst-panel-body { flex: 1; min-height: 0; padding: 16px 18px; overflow: auto; scrollbar-width: thin; overflow-wrap: anywhere; }
.dst-source { margin-bottom: 18px; padding: 10px 12px; border-left: 2px solid color-mix(in srgb, var(--dst-accent) 45%, transparent); border-radius: 0 8px 8px 0; background: var(--dst-soft); color: var(--dst-muted); font-size: 12px; line-height: 1.7; }
.dst-source-label { display: block; color: var(--dst-subtle); font-size: 10px; font-weight: 500; margin-bottom: 4px; }
.dst-source-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.dst-source[data-expanded="false"] .dst-source-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.dst-source-toggle, .dst-link { border: 0; background: transparent; color: var(--dst-accent); padding: 3px 0; font-size: 12px !important; }
.dst-source-toggle:hover, .dst-link:hover { text-decoration: underline; }
.dst-answer { font-size: 14px; line-height: 1.85; }
.dst-answer > :first-child, .dst-answer p:first-child { margin-top: 0; }
.dst-answer > :last-child, .dst-answer p:last-child { margin-bottom: 0; }
.dst-answer pre { max-width: 100%; overflow: auto; }
.dst-plain { margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
		html[data-ds-theme-source="dark"] .dst-root { --dst-card-solid: #1e1f24; }
		html[data-ds-theme-source="dark"] .dst-card, html[data-ds-theme-source="dark"] .dst-float, html[data-ds-theme-source="dark"] .dst-card-pill { background: #1e1f24; }
		.dst-md { font-size: 13px; line-height: 1.75; color: var(--dst-text); overflow-wrap: anywhere; }
		.dst-md > :first-child { margin-top: 0; }
		.dst-md > :last-child { margin-bottom: 0; }
		.dst-md-p { margin: 0 0 8px; }
		.dst-md-h { margin: 14px 0 6px; font-weight: 600; line-height: 1.45; color: var(--dst-text); }
		.dst-md-h1 { font-size: 16px; }
		.dst-md-h2 { font-size: 15px; }
		.dst-md-h3 { font-size: 14px; }
		.dst-md-h4 { font-size: 13px; }
		.dst-md-list { margin: 4px 0 8px; padding-left: 20px; }
		.dst-md-list li { margin: 2px 0; }
		.dst-md-code { margin: 8px 0; padding: 10px 12px; border-radius: 8px; background: var(--dst-soft); color: var(--dst-text); font-size: 12px; line-height: 1.6; overflow: auto; white-space: pre; }
		.dst-md-code code { font-family: ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace; }
		.dst-md-inline-code, .dst-md-inline-math { padding: 1px 4px; border-radius: 4px; background: var(--dst-soft); font-family: ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace; font-size: 12px; }
		.dst-md-quote { margin: 8px 0; padding: 2px 0 2px 10px; border-left: 3px solid var(--dst-border); color: var(--dst-muted); }
		.dst-md-hr { margin: 12px 0; border: 0; border-top: 1px solid var(--dst-border); }
		.dst-md-tablewrap { overflow: auto; margin: 8px 0; }
		.dst-md-table { border-collapse: collapse; font-size: 12px; }
		.dst-md-table th, .dst-md-table td { border: 1px solid var(--dst-border); padding: 4px 8px; text-align: left; vertical-align: top; }
		.dst-md-table th { background: var(--dst-soft); font-weight: 600; }
		.dst-md-link { color: var(--dst-accent); text-decoration: underline; text-underline-offset: 2px; }

.dst-empty { color: var(--dst-subtle); font-size: 13px; }
.dst-caret { display: inline-block; width: 6px; height: 16px; border-radius: 3px; background: var(--dst-accent); animation: dst-pulse 1.2s ease-in-out infinite; }
.dst-panel-foot { display: flex; align-items: center; gap: 7px; flex-shrink: 0; min-height: 38px; padding: 8px 16px; border-top: 1px solid var(--dst-border); color: var(--dst-muted); font-size: 11px; line-height: 1.5; }
.dst-panel-foot .dst-error { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.dst-result:disabled {
			opacity: .45;
			cursor: default;
		}

.dst-foot-spacer { flex: 1; }
.dst-dot { flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: #32a478; }
.dst-dot[data-state="running"] { background: var(--dst-accent); animation: dst-pulse 1.2s ease-in-out infinite; }
.dst-dot[data-state="error"] { background: #db5454; }
.dst-error { color: #db5454; }
.dst-resize { position: absolute; z-index: 2; touch-action: none; }
.dst-resize-n { left: 16px; right: 16px; top: 0; height: 6px; cursor: ns-resize; }
.dst-resize-s { left: 16px; right: 16px; bottom: 0; height: 12px; cursor: ns-resize; }
.dst-resize-e, .dst-resize-w { top: 12px; bottom: 12px; width: 10px; cursor: ew-resize; }
.dst-resize-e { right: 0; } .dst-resize-w { left: 0; }
.dst-resize-ne, .dst-resize-nw { width: 10px; height: 10px; }
.dst-resize-se, .dst-resize-sw { width: 22px; height: 22px; }
.dst-resize-ne { top: 0; right: 0; cursor: nesw-resize; } .dst-resize-nw { top: 0; left: 0; cursor: nwse-resize; }
.dst-resize-se { bottom: 0; right: 0; cursor: nwse-resize; } .dst-resize-sw { bottom: 0; left: 0; cursor: nesw-resize; }
@container (max-width: 520px) {
  .dst-set-grid { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .dst-hero { padding: 18px 16px 15px; border-radius: 15px; }
  .dst-hero-steps { gap: 4px; }
  .dst-hero-step { padding: 2px 9px; font-size: 10px; }
  .dst-set-block-head { grid-template-columns: 28px minmax(0, 1fr); gap: 11px; }
  .dst-set-block-index { width: 28px; height: 28px; border-radius: 9px; }
}
@container (max-width: 360px) {
  .dst-hero-top { gap: 10px; }
  .dst-set-section .dst-set-title { font-size: 20px; }
  .dst-set-section .dst-set-intro { display: none; }
}
@keyframes dst-fade-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dst-pulse { 50% { opacity: .35; } }
@keyframes dst-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dst-root *, .dst-set-section * { animation: none !important; transition: none !important; }
}
		/* —— 侧卡：头部按钮 / 选中内容 / 拖动拉伸 / 最小化胶囊 —— */
		.dst-card-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
		.dst-card-head { cursor: grab; user-select: none; touch-action: none; }
		.dst-card-head:active { cursor: grabbing; }
		.dst-card-quote { margin: 8px 16px 0; padding: 6px 10px 8px; border-left: 2px solid var(--dst-accent); background: var(--dst-soft); border-radius: 8px; font-size: 12px; line-height: 1.55; color: var(--dst-muted); cursor: pointer; overflow-wrap: anywhere; }
		.dst-card-quote-label { display: block; margin-bottom: 2px; font-size: 10.5px; color: var(--dst-subtle); }
		.dst-card-quote-clamped .dst-card-quote-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
		.dst-card.dst-card-collapsed { height: auto !important; min-height: 0; }
		.dst-card.dst-card-collapsed .dst-card-answer, .dst-card.dst-card-collapsed .dst-card-compose, .dst-card.dst-card-collapsed .dst-card-foot { display: none; }
		.dst-card-pill { position: fixed; z-index: 2401; right: 16px; bottom: 24px; display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 999px; border: 1px solid var(--dst-border); background: var(--dst-card-solid, #fff); color: var(--dst-text); box-shadow: 0 6px 24px rgba(0, 0, 0, .18); cursor: pointer; font-size: 12.5px; }
		.dst-card-pill:hover { background: var(--dst-hover); }
/* 与划词菜单打架的「朗读选中」小气泡：TTS 插件（@memef1f1y/dsh-plugin-tts）
   每次划词都会在选区旁弹一个 .dsh-tts-sel-wrap，常常和本插件的菜单叠在一起。
   这里只把那个气泡藏掉，TTS 的消息朗读/自动朗读等功能不受影响。 */
.dsh-tts-sel-wrap { display: none !important; }

		/* —— 选区浮出条（契约 §3.1/§3.2）：贴在选区下方 8px，越界翻上方 —— */
		.dst-float {
			position: fixed;
			z-index: 2410;
			display: inline-flex;
			align-items: center;
			gap: 2px;
			padding: 4px;
			border: 1px solid var(--dst-border);
			border-radius: 11px;
			background: var(--dst-card-solid, #fff);
			box-shadow: 0 8px 26px #101b3224, 0 2px 6px #101b320a;
			transform: translateX(-50%);
			animation: dst-fade-in 0.12s ease-out;
		}
		.dst-float-btn {
			display: inline-flex;
			align-items: center;
			gap: 5px;
			height: 30px;
			padding: 0 9px;
			border: 0;
			border-radius: 7px;
			background: transparent;
			color: var(--dst-text);
			font-family: inherit;
			font-size: 12px;
			font-weight: 500;
			white-space: nowrap;
			cursor: pointer;
		}
		.dst-float-btn svg {
			color: var(--dst-accent);
		}
		.dst-float-btn:hover {
			background: var(--dst-tint);
			color: var(--dst-accent);
		}
		.dst-float-btn-icon {
			display: inline-flex;
			align-items: center;
		}
		.dst-float-sep {
			width: 1px;
			height: 16px;
			margin: 0 2px;
			background: var(--dst-border);
		}
		.dst-float-kbd {
			margin-left: 1px;
			padding: 0 3px;
			border: 1px solid var(--dst-border);
			border-radius: 3px;
			color: var(--dst-subtle);
			font-size: 9px;
			line-height: 13px;
		}
		/* —— 右侧侧卡（契约 §3.1）：固定右上角，答案区流式渲染 —— */
		.dst-card {
			position: fixed;
			z-index: 2400;
			top: 16px;
			right: 16px;
			display: flex;
			flex-direction: column;
			width: 380px;
			max-width: calc(100vw - 32px);
			max-height: calc(100vh - 32px);
			border: 1px solid var(--dst-border);
			border-radius: 16px;
			background: var(--dst-card-solid, #fff);
			box-shadow: 0 20px 60px #101b3229, 0 3px 12px #101b320d;
			overflow: hidden;
			animation: dst-fade-in 0.16s ease-out;
		}
		.dst-card-head {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-shrink: 0;
			min-height: 46px;
			padding: 8px 10px 8px 16px;
			border-bottom: 1px solid var(--dst-border);
		}
		.dst-card-title {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			color: var(--dst-text);
			font-size: 14px;
			font-weight: 600;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.dst-card-status {
			display: flex;
			align-items: center;
			gap: 6px;
			flex-shrink: 0;
			padding: 6px 16px;
			border-bottom: 1px solid color-mix(in srgb, var(--dst-border) 60%, transparent);
			color: var(--dst-muted);
			font-size: 11px;
		}
		.dst-card-via {
			color: var(--dst-subtle);
		}
		.dst-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: var(--dst-accent);
		}
		.dst-dot[data-state="running"] {
			animation: dst-pulse 1.1s ease-in-out infinite;
		}
		.dst-dot[data-state="done"] {
			background: #3d9970;
		}
		.dst-dot[data-state="error"] {
			background: #db5454;
		}
		.dst-dot[data-state="idle"] {
			background: var(--dst-subtle);
		}
		.dst-card-answer {
			flex: 1;
			min-height: 120px;
			max-height: 46vh;
			padding: 14px 16px;
			overflow: auto;
			scrollbar-width: thin;
			color: var(--dst-text);
			font-size: 14px;
			line-height: 1.8;
			overflow-wrap: anywhere;
		}
		.dst-card-answer > :first-child,
		.dst-card-answer .dst-md > :first-child {
			margin-top: 0;
		}
		.dst-turn + .dst-turn {
			margin-top: 14px;
			padding-top: 12px;
			border-top: 1px dashed var(--dst-border);
		}
		.dst-card-q {
			margin: 0 0 6px;
			padding-left: 9px;
			border-left: 2px solid color-mix(in srgb, var(--dst-accent) 45%, transparent);
			color: var(--dst-muted);
			font-size: 12px;
			line-height: 1.6;
		}
		.dst-card-hint {
			color: var(--dst-subtle);
			font-size: 13px;
			line-height: 1.7;
		}
		.dst-error {
			color: #db5454;
			font-size: 12px;
			line-height: 1.6;
		}
		.dst-caret {
			display: inline-block;
			width: 7px;
			height: 15px;
			margin-top: 2px;
			border-radius: 2px;
			background: var(--dst-accent);
			vertical-align: -2px;
			animation: dst-pulse 1s ease-in-out infinite;
		}
		.dst-card-compose {
			display: flex;
			align-items: flex-end;
			gap: 8px;
			flex-shrink: 0;
			padding: 10px 12px;
			border-top: 1px solid var(--dst-border);
			background: var(--dst-soft);
		}
		.dst-card-input {
			flex: 1;
			min-width: 0;
			min-height: 38px;
			max-height: 120px;
			margin: 0;
			padding: 9px 10px;
			border: 1px solid var(--dst-border);
			border-radius: 9px;
			background: var(--dst-surface);
			color: var(--dst-text);
			font-family: inherit;
			font-size: 13px;
			line-height: 1.5;
			resize: none;
		}
		.dst-card-input:focus {
			border-color: var(--dst-accent);
			outline: none;
			box-shadow: 0 0 0 3px color-mix(in srgb, var(--dst-accent) 10%, transparent);
		}
		.dst-card-send {
			flex-shrink: 0;
			height: 38px;
			padding: 0 13px;
			border: 0;
			border-radius: 9px;
			background: var(--dst-accent);
			color: #fff;
			font-family: inherit;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
		}
		.dst-card-send:disabled {
			opacity: 0.45;
			cursor: default;
		}
		.dst-card-foot {
			display: flex;
			align-items: center;
			gap: 4px;
			flex-wrap: wrap;
			flex-shrink: 0;
			min-height: 42px;
			padding: 8px 10px;
			border-top: 1px solid var(--dst-border);
		}
		.dst-result {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			height: 26px;
			padding: 0 8px;
			border: 1px solid transparent;
			border-radius: 7px;
			background: transparent;
			color: var(--dst-muted);
			font-family: inherit;
			font-size: 11px;
			cursor: pointer;
		}
		.dst-result:hover:not(:disabled) {
			background: var(--dst-tint);
			color: var(--dst-accent);
		}
		.dst-foot-spacer {
			flex: 1;
		}
		.dst-card-followup {
			color: var(--dst-accent);
			font-weight: 600;
		}
		.dst-toast {
			position: fixed;
			z-index: 2500;
			left: 50%;
			bottom: 28px;
			max-width: min(420px, calc(100vw - 32px));
			padding: 8px 14px;
			border-radius: 10px;
			background: color-mix(in srgb, var(--dst-text) 88%, transparent);
			color: var(--dst-surface);
			font-size: 12px;
			line-height: 1.5;
			box-shadow: 0 10px 30px #101b3233;
			transform: translateX(-50%);
			animation: dst-fade-in 0.14s ease-out;
		}
		/* —— 定位原文：给原选区所在块加 2 秒高亮（契约 §3.3） —— */
		.dst-locate-hl {
			outline: 2px solid #6f5bd8;
			outline-offset: 3px;
			border-radius: 4px;
			background: rgba(111, 91, 216, 0.14);
			scroll-margin: 96px;
			animation: dst-locate-pulse 0.7s ease-out 2;
		}
		@keyframes dst-locate-pulse {
			from {
				background: rgba(111, 91, 216, 0.28);
			}
			to {
				background: rgba(111, 91, 216, 0.14);
			}
		}

`;
		/** 注入一次；沿用宿主 HMR 的样式标签身份，卸载时可回收。 */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify("dsh-floating-assistant/client.css") + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-floating-assistant";
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* dsh-floating-assistant —— 浏览器半边入口。
		*
		* 两处注册：
		* - \`shell.overlay\`：页内选区浮出条 + 右侧问答侧卡（系统级浮层递来的取件照旧）；
		* - \`settings.section\`：设置页里的「划词工具」一页（语言、规则、模型）。
		*/
		/** 硬依赖：槽位注册表。其余服务一律经 ctx.get 可选读取。 */
		const inject = ["slots"];
		/**
		* 挂载浏览器半边。
		* @param ctx - 客户端 Cordis 上下文。
		*/
		function apply(ctx) {
			ensureStyles();
			const slots = ctx.get?.("slots");
			if (slots === void 0) return;
			slots.inject("shell.overlay", () => slots.register({
				name: "shell.overlay",
				id: "dsh-floating-assistant",
				order: 60
			}, () => (0, react.createElement)(Overlay, { ctx })));
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "dsh-floating-assistant",
				order: 40,
				label: () => detectLocale() === "zh" ? "划词工具" : "Selection tools"
			}, () => (0, react.createElement)(SettingsSection, { ctx })));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map