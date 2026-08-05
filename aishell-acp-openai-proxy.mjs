#!/usr/bin/env node
/**
 * Run this file INSIDE the Huawei AI Shell container.
 *
 * It translates OpenAI Chat Completions requests into ACP JSON-RPC calls to
 * the authenticated `hwcloud acp` process. This avoids exporting TokenHub
 * credentials and keeps upstream traffic on Huawei's authorized DevEnv IP.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 5173);
const PROXY_VERSION = '1.3.0';
const CWD = process.env.AISHELL_CWD || '/root';
const HWCLOUD_BIN = process.env.HWCLOUD_BIN || '/opt/hwcloud/v1.0.0-beta.10/hwcloud';
const DEFAULT_MODEL = process.env.HUAWEI_GLM_MODEL || 'glm-5.2';
const LOCAL_API_KEY = process.env.LOCAL_PROXY_API_KEY || '';
const AUTO_APPROVE = /^(1|true|yes)$/i.test(process.env.ACP_AUTO_APPROVE || 'false');
const PROMPT_TIMEOUT_MS = Number(process.env.PROMPT_TIMEOUT_MS || 600000);
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS || 20000);
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 96000);
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 16000);
const MAX_TOOL_SCHEMA_CHARS = Number(process.env.MAX_TOOL_SCHEMA_CHARS || 36000);
const LOCAL_CODEX_MODE = !/^(0|false|no)$/i.test(process.env.LOCAL_CODEX_MODE || 'true');
const RESPONSE_CACHE_ENABLED = !/^(0|false|no)$/i.test(process.env.RESPONSE_CACHE_ENABLED || 'true');
const RESPONSE_CACHE_TTL_MS = Number(process.env.RESPONSE_CACHE_TTL_MS || 600000);
const RESPONSE_CACHE_MAX_ENTRIES = Number(process.env.RESPONSE_CACHE_MAX_ENTRIES || 128);

const responseCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;
let cacheWrites = 0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
};

function writeJson(res, status, value, extra = {}) {
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    ...extra,
  });
  res.end(JSON.stringify(value));
}

function errorBody(message, type = 'proxy_error', code = null) {
  return { error: { message, type, param: null, code } };
}

function isAuthorized(req) {
  if (!LOCAL_API_KEY) return true;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return bearer === LOCAL_API_KEY || req.headers['x-api-key'] === LOCAL_API_KEY;
}

function cacheableRequest(input) {
  return RESPONSE_CACHE_ENABLED && input.stream !== true && input.cache !== false &&
    !Array.isArray(input.tools) && !input.tool_choice && !input.parallel_tool_calls;
}

function cacheKey(input) {
  const normalized = { ...input, stream: false, caller: LOCAL_API_KEY };
  delete normalized.cache;
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function getCachedResponse(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.response;
}

function setCachedResponse(key, response) {
  if (RESPONSE_CACHE_MAX_ENTRIES <= 0 || RESPONSE_CACHE_TTL_MS <= 0) return;
  responseCache.set(key, { response, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
  while (responseCache.size > RESPONSE_CACHE_MAX_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value);
  }
  cacheWrites += 1;
}

function cacheStatus() {
  const total = cacheHits + cacheMisses;
  return {
    enabled: RESPONSE_CACHE_ENABLED,
    ttl_ms: RESPONSE_CACHE_TTL_MS,
    max_entries: RESPONSE_CACHE_MAX_ENTRIES,
    entries: responseCache.size,
    hits: cacheHits,
    misses: cacheMisses,
    writes: cacheWrites,
    hit_rate: total ? Number((cacheHits / total).toFixed(4)) : 0,
  };
}

async function readBody(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 16 * 1024 * 1024) throw new Error('Body exceeds 16 MiB');
    parts.push(part);
  }
  const text = Buffer.concat(parts).toString('utf8');
  return text.trim() ? JSON.parse(text) : {};
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((part) => {
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'image_url') return `[image: ${part.image_url?.url || ''}]`;
    return JSON.stringify(part);
  }).join('\n');
}

function truncateMiddle(text, maxChars) {
  const value = String(text || '');
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  const marker = `\n...[${value.length - maxChars} chars omitted]...\n`;
  if (marker.length >= maxChars) return value.slice(-maxChars);
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.4);
  return value.slice(0, headLength) + marker + value.slice(value.length - (available - headLength));
}

function compactToolValue(value, key = '') {
  if (typeof value === 'string') {
    return key === 'description' ? truncateMiddle(value, 320) : value;
  }
  if (Array.isArray(value)) return value.map((item) => compactToolValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([entryKey]) => !['examples', '$comment'].includes(entryKey))
    .map(([entryKey, entryValue]) => [entryKey, compactToolValue(entryValue, entryKey)]));
}

function serializeTools(tools) {
  const compacted = tools.map((tool) => compactToolValue(tool));
  const full = JSON.stringify(compacted);
  if (full.length <= MAX_TOOL_SCHEMA_CHARS) return full;

  const summaries = tools.map((tool) => ({
    type: tool?.type || 'function',
    function: {
      name: tool?.function?.name || tool?.name || 'unknown_tool',
      description: truncateMiddle(tool?.function?.description || tool?.description || '', 240),
      parameters: compactToolValue(tool?.function?.parameters || tool?.parameters || { type: 'object' }),
    },
  }));
  let selected = [];
  for (const summary of summaries) {
    const next = JSON.stringify([...selected, summary]);
    if (next.length > MAX_TOOL_SCHEMA_CHARS) break;
    selected.push(summary);
  }
  if (!selected.length && summaries.length) {
    selected = summaries.slice(0, 1).map((summary) => ({
      ...summary,
      function: { ...summary.function, parameters: { type: 'object' } },
    }));
  }
  return JSON.stringify(selected);
}

function toolInstruction(tools, toolChoice, parallelToolCalls) {
  if (!LOCAL_CODEX_MODE || !Array.isArray(tools) || tools.length === 0) return '';
  return [
    'RUNTIME CONTEXT:',
    'You are the model backend for a local Codex session running on the user machine.',
    'The ACP process is remote. Do not claim that remote /root files, shell commands, or ACP tools are local Codex resources.',
    'Tool execution and file access belong exclusively to the connected client.',
    'Never execute ACP-side tools, shell commands, or remote file operations for the client.',
    'Request client tools using the exact protocol below.',
    '',
    'LOCAL CODEX TOOL PROTOCOL:',
    'When a local tool is needed, emit one or more tags in this exact form and valid JSON:',
    '<codex_tool_call>{"name":"TOOL_NAME","arguments":{"key":"value"}}</codex_tool_call>',
    'Use the tool name and JSON arguments from the supplied schemas. Do not wrap the tag in Markdown.',
    'After emitting tool calls, stop. The local Codex client will execute them and send tool results in a later turn.',
    'When a TOOL RESULT already contains the requested data, answer from that result and do not call the same tool again.',
    'Only emit another tool call when the result is missing or an additional local operation is genuinely required.',
    `tool_choice=${JSON.stringify(toolChoice ?? 'auto')}`,
    `parallel_tool_calls=${JSON.stringify(parallelToolCalls !== false)}`,
    'AVAILABLE LOCAL CODEX TOOLS:',
    serializeTools(tools),
  ].join('\n');
}

function messagesToPrompt(messages = [], tools = [], toolChoice, parallelToolCalls) {
  const rendered = messages.map((message, index) => {
    const role = String(message?.role || 'user').toUpperCase();
    if (message?.role === 'tool') {
      return {
        index,
        role: message.role,
        text: `TOOL RESULT (${message.tool_call_id || 'unknown'}):\n${truncateMiddle(messageContentToText(message.content), MAX_MESSAGE_CHARS)}`,
      };
    }
    let text = `${role}:\n${truncateMiddle(messageContentToText(message?.content), MAX_MESSAGE_CHARS)}`;
    if (Array.isArray(message?.tool_calls)) {
      text += `\nTOOL CALLS:\n${truncateMiddle(JSON.stringify(message.tool_calls), MAX_MESSAGE_CHARS)}`;
    }
    return { index, role: message?.role, text };
  });

  const sections = [];
  const instruction = toolInstruction(tools, toolChoice, parallelToolCalls);
  if (LOCAL_CODEX_MODE) {
    sections.push([
      'LOCAL CODEX SESSION:',
      'Answer for the local Codex client. The user-visible workspace and tools are local to Codex, not this remote ACP container.',
      'Use the local tool protocol when a tool is required; do not fabricate access to files or commands.',
      'Treat file and media references as client-owned input. Never attempt to open them from the ACP container.',
      'If no local tool schemas are supplied, do not request ACP permissions or remote shell access.',
    ].join('\n'));
  }
  if (instruction) sections.push(instruction);

  const baseLength = sections.join('\n\n').length;
  let remaining = Math.max(4096, MAX_PROMPT_CHARS - baseLength - 64);
  const selected = [];
  const selectedIndexes = new Set();
  const systemMessages = rendered.filter((item) => ['system', 'developer'].includes(item.role)).slice(0, 2);
  let systemBudget = Math.min(24000, Math.floor(remaining * 0.35));

  for (const item of systemMessages) {
    if (systemBudget < 256) break;
    const text = truncateMiddle(item.text, Math.min(MAX_MESSAGE_CHARS, systemBudget));
    selected.push({ ...item, text });
    selectedIndexes.add(item.index);
    systemBudget -= text.length + 2;
    remaining -= text.length + 2;
  }

  const recent = [];
  for (let index = rendered.length - 1; index >= 0 && remaining >= 256; index -= 1) {
    const item = rendered[index];
    if (selectedIndexes.has(item.index)) continue;
    const text = truncateMiddle(item.text, Math.min(MAX_MESSAGE_CHARS, remaining));
    if (!text) continue;
    recent.unshift({ ...item, text });
    selectedIndexes.add(item.index);
    remaining -= text.length + 2;
  }

  selected.push(...recent);
  selected.sort((left, right) => left.index - right.index);
  if (selected.length < rendered.length) sections.push(`[${rendered.length - selected.length} older messages omitted]`);
  sections.push(...selected.map((item) => item.text));
  const combined = sections.join('\n\n');
  if (!/\nUSER:/.test(combined)) {
    const lastUser = rendered.filter((item) => item.role === 'user').pop();
    if (lastUser) sections.push(lastUser.text);
  }
  return truncateMiddle(sections.join('\n\n'), MAX_PROMPT_CHARS);
}

function clientAbortError() {
  const error = new Error('Client disconnected before completion');
  error.name = 'AbortError';
  return error;
}

function parseCodexToolCalls(text) {
  const calls = [];
  const starts = [...text.matchAll(/<codex_tool_call>\s*/gi)];
  for (const [index, match] of starts.entries()) {
    const segmentStart = match.index + match[0].length;
    const segmentEnd = starts[index + 1]?.index ?? text.length;
    const segment = text.slice(segmentStart, segmentEnd);
    try {
      const objectStart = segment.indexOf('{');
      if (objectStart < 0) continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let objectEnd = -1;
      for (let i = objectStart; i < segment.length; i += 1) {
        const ch = segment[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}' && --depth === 0) { objectEnd = i + 1; break; }
      }
      if (objectEnd < 0) continue;
      const value = JSON.parse(segment.slice(objectStart, objectEnd));
      if (!value || typeof value.name !== 'string' || !value.name.trim()) continue;
      const argumentsValue = value.arguments ?? {};
      const argumentsText = typeof argumentsValue === 'string'
        ? argumentsValue
        : JSON.stringify(argumentsValue);
      JSON.parse(argumentsText);
      calls.push({
        id: `call_${randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: { name: value.name, arguments: argumentsText },
      });
    } catch {
      // Ignore malformed model tags and keep the response as text.
    }
  }
  return calls;
}

function stripCodexToolCalls(text) {
  // 先删除完整闭合的标签块；再删除孤立/未闭合的开头标签，保留其后正文，避免误吞用户可见文本。
  return text
    .replace(/<codex_tool_call>[\s\S]*?<\/(?:codex_tool_call|arg_value|tool_call)>/gi, '')
    .replace(/<codex_tool_call>\s*/gi, '')
    .trim();
}

class AcpClient {
  constructor() {
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.initialized = false;
    this.starting = null;
    this.queue = Promise.resolve();
  }

  async start() {
    if (this.initialized && this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #start() {
    const child = spawn(HWCLOUD_BIN, ['acp', '--cwd', CWD], {
      cwd: CWD,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      const error = new Error(`hwcloud acp exited: code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.child = null;
      this.initialized = false;
    });
    child.stderr.on('data', (data) => process.stderr.write(`[hwcloud] ${data}`));

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#onLine(line));

    try {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: 'aishell-openai-proxy',
          title: 'AI Shell OpenAI Proxy',
          version: '1.0.0',
        },
      }, 30000);
      this.initialized = true;
    } catch (error) {
      this.#invalidate(error, child);
      throw error;
    }
  }

  #invalidate(error, child = this.child) {
    if (!child || this.child !== child) return;
    this.child = null;
    this.initialized = false;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    if (!child.killed) child.kill('SIGKILL');
  }

  #send(value) {
    if (!this.child?.stdin?.writable) throw new Error('ACP stdin is not writable');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async request(method, params, timeoutMs = PROMPT_TIMEOUT_MS) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('ACP request timed out: ' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.#send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  #respond(id, result) {
    this.#send({ jsonrpc: '2.0', id, result });
  }

  #respondError(id, code, message) {
    this.#send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (line.trim()) process.stderr.write(`[acp non-json] ${line}\n`);
      return;
    }

    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.id != null && message.method) {
      this.#handleAgentRequest(message);
      return;
    }

    if (message.method === 'session/update') {
      const sessionId = message.params?.sessionId;
      const listener = this.listeners.get(sessionId);
      if (listener) listener(message.params?.update || {});
    }
  }

  #handleAgentRequest(message) {
    if (message.method === 'session/request_permission') {
      const options = message.params?.options || [];
      if (AUTO_APPROVE && options.length) {
        const preferred = options.find((item) => /allow.*once/i.test(`${item.kind} ${item.name}`)) || options[0];
        this.#respond(message.id, {
          outcome: { outcome: 'selected', optionId: preferred.optionId },
        });
      } else {
        this.#respond(message.id, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    this.#respondError(message.id, -32601, `Unsupported client method: ${message.method}`);
  }

  prompt(text, onText, signal) {
    if (signal?.aborted) throw clientAbortError();
    // 全局串行队列：请求按到达顺序逐个进入 ACP，避免并发 session 互相干扰。
    const run = () => this.#promptWithRetry(text, onText, signal);
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => {});
    return task;
  }

  async #promptWithRetry(text, onText, signal) {
    let emitted = false;
    const forwardText = (chunk) => {
      emitted = true;
      onText?.(chunk);
    };
    try {
      return await this.#promptOnce(text, forwardText, signal);
    } catch (error) {
      if (emitted || signal?.aborted || error?.name === 'AbortError') throw error;
      process.stderr.write(`[acp retry] ${error.message}\n`);
      return this.#promptOnce(text, forwardText, signal);
    }
  }

  async #promptOnce(text, onText, signal) {
    if (signal?.aborted) throw clientAbortError();
    await this.start();
    if (signal?.aborted) {
      const error = clientAbortError();
      this.#invalidate(error);
      throw error;
    }
    const abort = () => this.#invalidate(clientAbortError());
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const created = await this.request('session/new', { cwd: CWD, mcpServers: [] }, SESSION_TIMEOUT_MS);
      const sessionId = created.sessionId;
      let fullText = '';

      this.listeners.set(sessionId, (update) => {
        if (update.sessionUpdate !== 'agent_message_chunk') return;
        const content = update.content;
        if (content?.type !== 'text' || typeof content.text !== 'string') return;
        fullText += content.text;
        onText?.(content.text);
      });

      try {
        const result = await this.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        });
        return { text: fullText, stopReason: result?.stopReason || 'end_turn', sessionId };
      } finally {
        this.listeners.delete(sessionId);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}

const acp = new AcpClient();

function writeSse(res, value) {
  res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
}

function completionChunk(completionId, created, model, delta, finishReasonValue = null) {
  return {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReasonValue }],
  };
}

function createStreamingTextWriter(res, completionId, created, model) {
  const marker = '<codex_tool_call>';
  let pending = '';
  let toolMarkerSeen = false;

  const emit = (content) => {
    if (!content) return;
    writeSse(res, completionChunk(completionId, created, model, { content }));
  };

  return {
    push(chunk) {
      if (!chunk) return;
      pending += chunk;
      if (toolMarkerSeen) return;
      const markerIndex = pending.toLowerCase().indexOf(marker);
      if (markerIndex >= 0) {
        emit(pending.slice(0, markerIndex));
        pending = pending.slice(markerIndex);
        toolMarkerSeen = true;
        return;
      }
      const safeLength = Math.max(0, pending.length - marker.length + 1);
      emit(pending.slice(0, safeLength));
      pending = pending.slice(safeLength);
    },
    flushText() {
      emit(pending);
      pending = '';
    },
  };
}

function finishReason(stopReason) {
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'cancelled') return 'stop';
  return 'stop';
}

async function chatCompletion(req, res) {
  const clientAbort = new AbortController();
  const abort = () => {
    if (!res.writableEnded && !clientAbort.signal.aborted) clientAbort.abort();
  };
  req.once('aborted', abort);
  res.once('close', abort);

  let input;
  try {
    input = await readBody(req);
  } catch (error) {
    if (!clientAbort.signal.aborted && !res.destroyed) {
      writeJson(res, 400, errorBody(error.message, 'invalid_request_error'));
    }
    req.removeListener('aborted', abort);
    res.removeListener('close', abort);
    return;
  }
  if (clientAbort.signal.aborted) {
    req.removeListener('aborted', abort);
    res.removeListener('close', abort);
    return;
  }

  const completionId = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  const model = input.model || DEFAULT_MODEL;
  const prompt = messagesToPrompt(input.messages, input.tools, input.tool_choice, input.parallel_tool_calls);
  const requestCacheKey = cacheableRequest(input) ? cacheKey(input) : '';
  if (requestCacheKey) {
    const cached = getCachedResponse(requestCacheKey);
    if (cached) {
      cacheHits += 1;
      writeJson(res, 200, cached, { 'X-AIShell-Cache': 'HIT' });
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      return;
    }
    cacheMisses += 1;
  }
  process.stderr.write(`[request] prompt_chars=${prompt.length} messages=${input.messages?.length || 0} tools=${input.tools?.length || 0}\n`);

  try {
    let streamWriter;
    if (input.stream === true) {
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      writeSse(res, completionChunk(completionId, created, model, { role: 'assistant', content: '' }));
      streamWriter = createStreamingTextWriter(res, completionId, created, model);
    }

    const result = await acp.prompt(prompt, (chunk) => streamWriter?.push(chunk), clientAbort.signal);
    const toolCalls = parseCodexToolCalls(result.text);
    const content = stripCodexToolCalls(result.text);

    if (input.stream === true) {
      if (toolCalls.length) {
        for (const [index, toolCall] of toolCalls.entries()) {
          writeSse(res, completionChunk(completionId, created, model, {
            tool_calls: [{
              index,
              id: toolCall.id,
              type: toolCall.type,
              function: toolCall.function,
            }],
          }));
        }
        writeSse(res, completionChunk(completionId, created, model, {}, 'tool_calls'));
      } else {
        streamWriter.flushText();
        writeSse(res, completionChunk(completionId, created, model, {}, finishReason(result.stopReason)));
      }
      writeSse(res, '[DONE]');
      res.end();
      return;
    }

    const completion = {
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls.length ? (content || null) : content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : finishReason(result.stopReason),
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    if (requestCacheKey) setCachedResponse(requestCacheKey, completion);
    writeJson(res, 200, completion, { 'X-AIShell-Cache': requestCacheKey ? 'MISS' : 'BYPASS' });
  } catch (error) {
    if (clientAbort.signal.aborted || res.destroyed) return;
    if (!res.headersSent) writeJson(res, 502, errorBody(error.message, 'acp_error'));
    else {
      writeSse(res, errorBody(error.message, 'acp_error'));
      writeSse(res, '[DONE]');
      res.end();
    }
  } finally {
    req.removeListener('aborted', abort);
    res.removeListener('close', abort);
  }
}

const server = http.createServer(async (req, res) => {
  let path;
  try {
    path = new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname.replace(/^\/v1\/v1\//, '/v1/');
  } catch {
    writeJson(res, 400, errorBody('Malformed request URL', 'invalid_request_error'));
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (!isAuthorized(req)) {
    writeJson(res, 401, errorBody('Invalid proxy API key', 'authentication_error'));
    return;
  }
  if (path === '/health' || path === '/v1/health') {
    writeJson(res, 200, {
      status: 'ok',
      version: PROXY_VERSION,
      transport: 'hwcloud-acp-stdio',
      model: DEFAULT_MODEL,
      auto_approve: AUTO_APPROVE,
      serial_queue: true,
      response_cache: cacheStatus(),
    });
    return;
  }
  if (path === '/cache' || path === '/v1/cache') {
    writeJson(res, 200, cacheStatus());
    return;
  }
  if (path === '/models' || path === '/v1/models') {
    writeJson(res, 200, {
      object: 'list',
      data: [{ id: DEFAULT_MODEL, object: 'model', created: 0, owned_by: 'huawei-inner-provider' }],
    });
    return;
  }
  if ((path === '/chat/completions' || path === '/v1/chat/completions') && req.method === 'POST') {
    await chatCompletion(req, res);
    return;
  }
  writeJson(res, 404, errorBody(`Not found: ${path}`, 'invalid_request_error'));
});

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, HOST, () => {
    console.log(`AI Shell ACP proxy: http://${HOST}:${PORT}/v1`);
    console.log(`version: ${PROXY_VERSION}`);
    console.log(`hwcloud: ${HWCLOUD_BIN}`);
    console.log(`model: ${DEFAULT_MODEL}`);
  });
}

export { messagesToPrompt, serializeTools, truncateMiddle };
