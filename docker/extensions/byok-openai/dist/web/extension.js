'use strict';

// Self-contained web extension (CommonJS, no bundling step required).
// Registers OpenAI-compatible language models declared in /config.json and
// marks client BYOK as available so the chat UI does not require a GitHub
// account before listing them.

const vscode = require('vscode');

const VENDOR = 'byok';
const CONFIG_PATH = '/config.json';
const BYOK_CONTEXT_KEYS = [
	'github.copilot.clientByokEnabled',
	'github.copilot.hasByokModels',
	'chatNonCopilotModelsAreUserSelectable'
];
const CONFIG_REFRESH_MS = 30000;
const DEFAULT_MAX_INPUT = 128000;
const DEFAULT_MAX_OUTPUT = 8192;

function absoluteUrl(path) {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
		return path;
	}
	const origin = typeof self !== 'undefined' && self.location ? self.location.origin : undefined;
	return origin ? new URL(path, origin).toString() : path;
}

function normalizeBaseUrl(baseUrl) {
	return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// Supports both `<base>/chat/completions` and `<base>/v1/chat/completions`
// shapes so a configuration can point at `/llm/v1` or `/llm` interchangeably.
function endpoint(baseUrl, suffix) {
	const base = normalizeBaseUrl(baseUrl);
	if (/\/v1$/i.test(base) && suffix.startsWith('/v1/')) {
		return `${base}${suffix.slice(3)}`;
	}
	return `${base}${suffix}`;
}

function apiTypeOf(config, model) {
	const perModel = model && typeof model.apiType === 'string' ? model.apiType : undefined;
	const value = perModel || config.apiType || 'chat-completions';
	return value === 'messages' ? 'messages' : 'chat-completions';
}

function isValidModel(model) {
	return !!model && typeof model.id === 'string' && model.id.length > 0;
}

async function readByokConfig() {
	try {
		const response = await fetch(absoluteUrl(CONFIG_PATH), { cache: 'no-store' });
		if (!response.ok) {
			return undefined;
		}
		const json = await response.json();
		const byok = json && json.byok;
		if (!byok || typeof byok.baseUrl !== 'string' || !Array.isArray(byok.models)) {
			return undefined;
		}
		const models = byok.models.filter(isValidModel);
		if (models.length === 0) {
			return undefined;
		}
		return {
			baseUrl: normalizeBaseUrl(byok.baseUrl),
			apiType: typeof byok.apiType === 'string' ? byok.apiType : undefined,
			apiKey: typeof byok.apiKey === 'string' && byok.apiKey ? byok.apiKey : undefined,
			models
		};
	} catch {
		return undefined;
	}
}

function toModelInformation(config) {
	return config.models.map(model => ({
		id: model.id,
		name: typeof model.name === 'string' && model.name ? model.name : model.id,
		family: typeof model.family === 'string' && model.family ? model.family : model.id,
		version: '1.0.0',
		detail: 'BYOK',
		tooltip: `${model.id} via ${config.baseUrl}`,
		maxInputTokens: Number.isFinite(model.maxInputTokens) ? model.maxInputTokens : DEFAULT_MAX_INPUT,
		maxOutputTokens: Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : DEFAULT_MAX_OUTPUT,
		capabilities: {
			toolCalling: model.toolCalling !== false,
			imageInput: model.imageInput === true
		}
	}));
}

function partKind(part) {
	if (!part || typeof part !== 'object') {
		return typeof part === 'string' ? 'text' : 'unknown';
	}
	if (typeof part.callId === 'string' && typeof part.name === 'string') {
		return 'toolCall';
	}
	if (typeof part.callId === 'string' && Array.isArray(part.content)) {
		return 'toolResult';
	}
	if (typeof part.mimeType === 'string' && part.data !== undefined) {
		return 'data';
	}
	if (typeof part.value === 'string') {
		return 'text';
	}
	return 'unknown';
}

function toolResultText(part) {
	const chunks = [];
	for (const item of part.content || []) {
		if (typeof item === 'string') {
			chunks.push(item);
		} else if (item && typeof item.value === 'string') {
			chunks.push(item.value);
		}
	}
	return chunks.join('\n');
}

function toBase64(part) {
	try {
		const bytes = part.data instanceof Uint8Array ? part.data : new Uint8Array(part.data);
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	} catch {
		return undefined;
	}
}

function toDataUrl(part) {
	const base64 = toBase64(part);
	return base64 === undefined ? undefined : `data:${part.mimeType};base64,${base64}`;
}

function toOpenAiMessages(messages) {
	const converted = [];
	for (const message of messages) {
		const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
		const textChunks = [];
		const images = [];
		const toolCalls = [];
		const toolResults = [];

		for (const part of message.content || []) {
			switch (partKind(part)) {
				case 'text':
					textChunks.push(typeof part === 'string' ? part : part.value);
					break;
				case 'toolCall':
					toolCalls.push({
						id: part.callId,
						type: 'function',
						function: {
							name: part.name,
							arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {})
						}
					});
					break;
				case 'toolResult':
					toolResults.push({ callId: part.callId, text: toolResultText(part) });
					break;
				case 'data': {
					const url = toDataUrl(part);
					if (url && /^image\//i.test(part.mimeType)) {
						images.push({ type: 'image_url', image_url: { url } });
					}
					break;
				}
				default:
					break;
			}
		}

		if (isAssistant) {
			if (textChunks.length > 0 || toolCalls.length > 0) {
				const entry = { role: 'assistant' };
				entry.content = textChunks.join('');
				if (toolCalls.length > 0) {
					entry.tool_calls = toolCalls;
				}
				converted.push(entry);
			}
			continue;
		}

		for (const result of toolResults) {
			converted.push({ role: 'tool', tool_call_id: result.callId, content: result.text });
		}

		if (images.length > 0) {
			const content = [];
			const text = textChunks.join('');
			if (text) {
				content.push({ type: 'text', text });
			}
			content.push(...images);
			converted.push({ role: 'user', content });
		} else if (textChunks.length > 0) {
			converted.push({ role: 'user', content: textChunks.join('\n') });
		}
	}
	return converted;
}

function toOpenAiTools(tools) {
	if (!Array.isArray(tools) || tools.length === 0) {
		return undefined;
	}
	return tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description || '',
			parameters: tool.inputSchema || { type: 'object', properties: {} }
		}
	}));
}

function safeParseJson(value) {
	if (typeof value !== 'string' || value.trim() === '') {
		return {};
	}
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

function buildHeaders(apiKey) {
	const headers = {
		'content-type': 'application/json',
		accept: 'text/event-stream, application/json'
	};
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

function toAnthropicMessages(messages) {
	const systemChunks = [];
	const out = [];

	for (const message of messages) {
		const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
		const blocks = [];
		const toolResults = [];
		const textChunks = [];

		for (const part of message.content || []) {
			const kind = partKind(part);
			if (kind === 'text') {
				textChunks.push(typeof part === 'string' ? part : part.value);
			} else if (kind === 'toolCall' && isAssistant) {
				blocks.push({
					type: 'tool_use',
					id: part.callId,
					name: part.name,
					input: typeof part.input === 'string' ? safeParseJson(part.input) : (part.input || {})
				});
			} else if (kind === 'toolResult') {
				toolResults.push({ type: 'tool_result', tool_use_id: part.callId, content: toolResultText(part) });
			} else if (kind === 'data') {
				const base64 = toBase64(part);
				if (base64 && /^image\//i.test(part.mimeType)) {
					blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: base64 } });
				}
			}
		}

		if (isAssistant) {
			if (textChunks.length > 0) {
				blocks.unshift({ type: 'text', text: textChunks.join('') });
			}
			if (blocks.length > 0) {
				out.push({ role: 'assistant', content: blocks });
			}
			continue;
		}

		// User-role text becomes the prompt; leading text is treated as the
		// system prompt only when it is the first message of the conversation.
		if (textChunks.length > 0) {
			const text = textChunks.join('\n');
			if (out.length === 0 && toolResults.length === 0) {
				systemChunks.push(text);
			} else {
				blocks.push({ type: 'text', text });
			}
		}

		if (toolResults.length > 0) {
			blocks.unshift(...toolResults);
		}

		if (blocks.length > 0) {
			out.push({ role: 'user', content: blocks });
		}
	}

	return { system: systemChunks.length > 0 ? systemChunks.join('\n\n') : undefined, messages: out };
}

class ByokProvider {
	constructor() {
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
		this._config = undefined;
		this._signature = '';
	}

	async refresh() {
		const config = await readByokConfig();
		const signature = config ? JSON.stringify(config) : '';
		if (signature !== this._signature) {
			this._signature = signature;
			this._config = config;
			this._onDidChange.fire();
		}
		return this._config;
	}

	async provideLanguageModelChatInformation(_options, _token) {
		const config = this._config ?? await this.refresh();
		const models = config ? toModelInformation(config) : [];
		console.log('[byok-openai] provideLanguageModelChatInformation ->', models.length, 'model(s)');
		return models;
	}

	async provideLanguageModelChatResponse(model, messages, options, progress, token) {
		const config = this._config ?? await this.refresh();
		if (!config) {
			throw new Error('BYOK is not configured: /config.json has no usable "byok" entry.');
		}
		const selected = apiTypeOf(config, model);
		if (selected === 'messages') {
			await this._messages(config, model, messages, options, progress, token);
		} else {
			await this._chatCompletions(config, model, messages, options, progress, token);
		}
	}

	async _fetch(config, model, url, body, extraHeaders, token) {
		const controller = new AbortController();
		const cancellation = token && token.onCancellationRequested
			? token.onCancellationRequested(() => controller.abort())
			: { dispose() { } };
		let response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: { ...buildHeaders(config.apiKey), ...extraHeaders },
				body: JSON.stringify(body),
				signal: controller.signal
			});
		} finally {
			cancellation.dispose();
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`BYOK request failed (${model.id}): ${response.status} ${response.statusText}${detail ? ` - ${detail.slice(0, 500)}` : ''}`);
		}
		return response;
	}

	async _chatCompletions(config, model, messages, options, progress, token) {
		const body = {
			model: model.id,
			messages: toOpenAiMessages(messages),
			stream: true
		};
		const tools = toOpenAiTools(options && options.tools);
		if (tools) {
			body.tools = tools;
			body.tool_choice = 'auto';
		}

		const response = await this._fetch(
			config,
			model,
			endpoint((model && model.url) || config.baseUrl, '/v1/chat/completions'),
			body,
			{},
			token
		);

		const contentType = (response.headers.get('content-type') || '').toLowerCase();
		if (!contentType.includes('text/event-stream') || !response.body) {
			const json = await response.json();
			const choice = json && json.choices && json.choices[0];
			const message = choice && choice.message;
			if (message) {
				if (typeof message.content === 'string' && message.content) {
					progress.report(new vscode.LanguageModelTextPart(message.content));
				}
				for (const call of message.tool_calls || []) {
					progress.report(new vscode.LanguageModelToolCallPart(
						call.id || `call_${Math.random().toString(36).slice(2)}`,
						call.function && call.function.name,
						safeParseJson(call.function && call.function.arguments)
					));
				}
			}
			return;
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		const toolCalls = new Map();
		let buffer = '';
		let finished = false;

		while (!finished) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			let newline;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);

				if (!line.startsWith('data:')) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') {
					finished = true;
					break;
				}

				let chunk;
				try {
					chunk = JSON.parse(payload);
				} catch {
					continue;
				}
				const choice = chunk.choices && chunk.choices[0];
				if (!choice) {
					continue;
				}
				const delta = choice.delta || {};
				if (typeof delta.content === 'string' && delta.content) {
					progress.report(new vscode.LanguageModelTextPart(delta.content));
				}
				for (const call of delta.tool_calls || []) {
					const index = typeof call.index === 'number' ? call.index : 0;
					const current = toolCalls.get(index) || { id: '', name: '', args: '' };
					if (call.id) {
						current.id = call.id;
					}
					if (call.function && typeof call.function.name === 'string') {
						current.name = call.function.name;
					}
					if (call.function && typeof call.function.arguments === 'string') {
						current.args += call.function.arguments;
					}
					toolCalls.set(index, current);
				}
			}
		}

		for (const [, call] of toolCalls) {
			if (call.name) {
				progress.report(new vscode.LanguageModelToolCallPart(
					call.id || `call_${Math.random().toString(36).slice(2)}`,
					call.name,
					safeParseJson(call.args)
				));
			}
		}
	}

	async _messages(config, model, messages, options, progress, token) {
		const converted = toAnthropicMessages(messages);
		const body = {
			model: model.id,
			max_tokens: (model && Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : DEFAULT_MAX_OUTPUT),
			messages: converted.messages,
			stream: true
		};
		if (converted.system) {
			body.system = converted.system;
		}
		if (Array.isArray(options && options.tools) && options.tools.length > 0) {
			body.tools = options.tools.map(tool => ({
				name: tool.name,
				description: tool.description || '',
				input_schema: tool.inputSchema || { type: 'object', properties: {} }
			}));
		}

		const response = await this._fetch(
			config,
			model,
			endpoint((model && model.url) || config.baseUrl, '/v1/messages'),
			body,
			{ 'anthropic-version': '2023-06-01' },
			token
		);

		const contentType = (response.headers.get('content-type') || '').toLowerCase();
		if (!contentType.includes('text/event-stream') || !response.body) {
			const json = await response.json();
			for (const block of json.content || []) {
				if (block.type === 'text' && block.text) {
					progress.report(new vscode.LanguageModelTextPart(block.text));
				} else if (block.type === 'tool_use') {
					progress.report(new vscode.LanguageModelToolCallPart(block.id, block.name, block.input || {}));
				}
			}
			return;
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		const toolCalls = new Map();
		let buffer = '';
		let finished = false;

		while (!finished) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			let newline;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);

				if (!line.startsWith('data:')) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') {
					continue;
				}

				let event;
				try {
					event = JSON.parse(payload);
				} catch {
					continue;
				}

				if (event.type === 'content_block_start' && event.content_block && event.content_block.type === 'tool_use') {
					const index = typeof event.index === 'number' ? event.index : toolCalls.size;
					toolCalls.set(index, {
						id: event.content_block.id,
						name: event.content_block.name,
						args: ''
					});
				} else if (event.type === 'content_block_delta' && event.delta) {
					if (event.delta.type === 'text_delta' && event.delta.text) {
						progress.report(new vscode.LanguageModelTextPart(event.delta.text));
					} else if (event.delta.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
						const index = typeof event.index === 'number' ? event.index : 0;
						const current = toolCalls.get(index) || { id: '', name: '', args: '' };
						current.args += event.delta.partial_json;
						toolCalls.set(index, current);
					}
				} else if (event.type === 'message_stop') {
					finished = true;
					break;
				}
			}
		}

		for (const [, call] of toolCalls) {
			if (call.name) {
				progress.report(new vscode.LanguageModelToolCallPart(
					call.id || `call_${Math.random().toString(36).slice(2)}`,
					call.name,
					safeParseJson(call.args)
				));
			}
		}
	}

	async provideTokenCount(model, value, _token) {
		const text = typeof value === 'string'
			? value
			: (value && Array.isArray(value.content)
				? value.content.map(part => (part && typeof part.value === 'string' ? part.value : '')).join('\n')
				: String(value || ''));
		const limit = model && Number.isFinite(model.maxInputTokens) ? model.maxInputTokens : DEFAULT_MAX_INPUT;
		return Math.max(1, Math.min(limit, Math.ceil(text.length / 4)));
	}
}

function setByokContextKeys() {
	for (const key of BYOK_CONTEXT_KEYS) {
		try {
			Promise.resolve(vscode.commands.executeCommand('setContext', key, true)).then(
				() => { },
				error => console.log(`[byok-openai] setContext failed for ${key}:`, String(error))
			);
		} catch (error) {
			console.log(`[byok-openai] setContext threw for ${key}:`, String(error));
		}
	}
}

function activate(context) {
	console.log('[byok-openai] activate');
	const provider = new ByokProvider();

	try {
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
		console.log('[byok-openai] provider registered for vendor', VENDOR);
	} catch (error) {
		console.error('[byok-openai] registerLanguageModelChatProvider failed:', String(error));
	}
	setByokContextKeys();
	void provider.refresh().then(config => console.log('[byok-openai] config loaded:', config ? config.models.map(m => m.id).join(',') : 'none'));

	// The workbench's HasByokModels contribution re-derives the same keys from
	// its own signals and can overwrite ours after activation, so re-assert
	// them early and keep doing so.
	for (const delay of [0, 250, 750, 1500, 3000, 6000, 12000]) {
		setTimeout(() => setByokContextKeys(), delay);
	}

	const fastTimer = setInterval(() => {
		setByokContextKeys();
	}, 10000);
	setTimeout(() => clearInterval(fastTimer), 120000);

	const timer = setInterval(() => {
		setByokContextKeys();
		void provider.refresh();
	}, CONFIG_REFRESH_MS);

	context.subscriptions.push({
		dispose() {
			clearInterval(fastTimer);
			clearInterval(timer);
			provider._onDidChange.dispose();
		}
	});
}

function deactivate() {
}

module.exports = { activate, deactivate };
