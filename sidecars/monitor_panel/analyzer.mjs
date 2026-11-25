/**
 * 100% Original Local Context Analyzer for Antigravity.
 * Reads on-disk JSONL transcripts, SQLite summaries, and workspace customizations.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

const DEFAULT_APP_DATA = join(homedir(), '.gemini', 'antigravity');
const CONFIG_DIR = join(homedir(), '.gemini', 'config');

function approxTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(s.length / 4);
}

function getModelContextLimit(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('claude')) return 200_000;
  if (m.includes('gpt-oss') || m.includes('gpt_oss')) return 128_000;
  return 1_000_000;
}

function formatModelLabel(modelId) {
  if (!modelId) return 'Unknown Model';
  return String(modelId)
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function listRecentConversations(limit = 10) {
  const dbPath = join(DEFAULT_APP_DATA, 'conversation_summaries.db');
  if (!existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT conversation_id, title, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?')
      .all(limit);
    return rows.map((r) => ({ id: r.conversation_id, title: r.title, updatedAt: r.last_modified_time }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

export function resolveConversationAppData(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  const p = join(DEFAULT_APP_DATA, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  return existsSync(p) ? DEFAULT_APP_DATA : null;
}

function uriToPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (uri.startsWith('file:///')) {
    let p = decodeURIComponent(uri.slice(8));
    if (/^[A-Za-z]:/.test(p)) return p.replace(/\//g, '\\');
    return '/' + p;
  }
  return uri;
}

function scanMdDir(dir, kind) {
  const items = [];
  if (!existsSync(dir)) return items;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (kind === 'skills' && entry.isDirectory()) {
        const skillFile = join(dir, entry.name, 'SKILL.md');
        if (existsSync(skillFile)) {
          const text = readFileSync(skillFile, 'utf8');
          items.push({ name: entry.name, path: skillFile, tokens: approxTokens(text) });
        }
      } else if (kind === 'rules' && entry.isFile() && entry.name.endsWith('.md')) {
        const ruleFile = join(dir, entry.name);
        const text = readFileSync(ruleFile, 'utf8');
        items.push({ name: entry.name, path: ruleFile, tokens: approxTokens(text) });
      }
    }
  } catch {}
  return items;
}

async function fetchLsPlugins(workspaceUris) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) return [];
  try {
    const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetAllPlugins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
      body: JSON.stringify(workspaceUris?.length ? { workspaceUris } : {}),
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.plugins) ? data.plugins : [];
  } catch {
    return [];
  }
}

export async function analyzeConversation(appData, convId, { workspaceUris = [] } = {}) {
  const transcriptPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) return { conversationId: convId, found: false };

  let stat;
  try {
    stat = statSync(transcriptPath);
  } catch {
    return { conversationId: convId, found: false };
  }

  const rawLines = readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
  const steps = [];
  for (const line of rawLines) {
    try { steps.push(JSON.parse(line)); } catch {}
  }

  let modelId = '';
  let lastInputUncached = 0;
  let lastCacheRead = 0;
  let lastOutputTokens = 0;
  let cumulativeInput = 0;
  let cumulativeCached = 0;
  let cumulativeOutput = 0;

  let userTokens = 0;
  let agentTokens = 0;
  let toolTokens = 0;
  let sysMsgTokens = 0;
  let checkpointTokens = 0;
  let compactionCount = 0;
  const heavyToolCalls = [];

  for (const s of steps) {
    if (s.type === 'USER_INPUT') {
      userTokens += approxTokens(s.content);
    } else if (s.type === 'PLANNER_RESPONSE') {
      if (s.model) modelId = s.model;
      const inTok = Number(s.input_tokens) || 0;
      const cacheTok = Number(s.cache_read_tokens) || 0;
      const outTok = Number(s.output_tokens) || 0;
      lastInputUncached = inTok;
      lastCacheRead = cacheTok;
      lastOutputTokens = outTok;
      cumulativeInput += inTok + cacheTok;
      cumulativeCached += cacheTok;
      cumulativeOutput += outTok;
      agentTokens += outTok + approxTokens(s.thinking);

      if (Array.isArray(s.tool_calls)) {
        for (const tc of s.tool_calls) {
          const tok = approxTokens(tc.arguments || tc.args || tc);
          toolTokens += tok;
          const label = tc.name ? `${tc.name}` : 'tool_call';
          heavyToolCalls.push({ toolName: tc.name || 'tool', label, tokens: tok });
        }
      }
    } else if (s.type === 'CHECKPOINT') {
      compactionCount++;
      checkpointTokens += approxTokens(s.content);
    } else if (s.type === 'GENERIC' || s.type === 'SYSTEM_MESSAGE') {
      const tok = approxTokens(s.content);
      if (s.source === 'SYSTEM') sysMsgTokens += tok;
      else {
        toolTokens += tok;
        heavyToolCalls.push({
          toolName: s.source || 'tool_output',
          label: `Step #${s.step_index ?? '?'} output`,
          tokens: tok,
        });
      }
    }
  }

  heavyToolCalls.sort((a, b) => b.tokens - a.tokens);

  // Discover rules, skills, MCP servers
  const rules = [...scanMdDir(join(CONFIG_DIR, 'rules'), 'rules')];
  const skills = [...scanMdDir(join(CONFIG_DIR, 'skills'), 'skills')];
  for (const uri of workspaceUris) {
    const wsPath = uriToPath(uri);
    if (!wsPath) continue;
    for (const root of ['.agents', '.agent']) {
      rules.push(...scanMdDir(join(wsPath, root, 'rules'), 'rules'));
      skills.push(...scanMdDir(join(wsPath, root, 'skills'), 'skills'));
    }
    const geminiMd = join(wsPath, 'GEMINI.md');
    if (existsSync(geminiMd)) {
      rules.push({ name: 'GEMINI.md', path: geminiMd, tokens: approxTokens(readFileSync(geminiMd, 'utf8')) });
    }
  }

  const plugins = await fetchLsPlugins(workspaceUris);
  const mcpServers = [];
  for (const p of plugins) {
    if (p.disabled) continue;
    if (Array.isArray(p.skills)) {
      for (const sk of p.skills) {
        if (sk?.name && !skills.some((x) => x.name === sk.name)) {
          skills.push({ name: sk.name, path: sk.path || '', tokens: approxTokens(sk.description || sk.name) });
        }
      }
    }
    if (Array.isArray(p.mcpServers)) {
      for (const m of p.mcpServers) {
        mcpServers.push({ name: m.name || 'mcp', toolCount: m.tools?.length || 0, tokens: approxTokens(m) });
      }
    }
  }

  const rulesTokens = rules.reduce((a, r) => a + r.tokens, 0);
  const skillsTokens = skills.reduce((a, s) => a + Math.min(80, s.tokens), 0); // progressive disclosure index
  const mcpTokens = mcpServers.reduce((a, m) => a + m.tokens, 0);

  const contextLimit = getModelContextLimit(modelId);
  const lastPromptTotal = lastInputUncached + lastCacheRead;
  const accounted = userTokens + agentTokens + toolTokens + sysMsgTokens + checkpointTokens + rulesTokens + skillsTokens + mcpTokens;
  const usedTokens = lastPromptTotal > 0 ? lastPromptTotal : accounted;
  const systemOverhead = Math.max(0, usedTokens - (userTokens + agentTokens + toolTokens + sysMsgTokens + checkpointTokens + rulesTokens + skillsTokens + mcpTokens));
  const freeTokens = Math.max(0, contextLimit - usedTokens);
  const usedPercent = Number(((usedTokens / contextLimit) * 100).toFixed(1));
  const cacheHitRatio = lastPromptTotal > 0 ? Number(((lastCacheRead / lastPromptTotal) * 100).toFixed(1)) : 0;

  return {
    conversationId: convId,
    found: true,
    model: { id: modelId, label: formatModelLabel(modelId) },
    contextLimit,
    usedTokens,
    freeTokens,
    usedPercent,
    stepCount: steps.length,
    cache: {
      lastPromptTokens: lastPromptTotal,
      cachedTokens: lastCacheRead,
      cacheHitRatio,
      lastOutputTokens,
    },
    compaction: { count: compactionCount },
    categories: {
      systemPrompt: systemOverhead,
      systemTools: 0,
      mcpTools: mcpTokens,
      mcpInstructions: 0,
      rulesFiles: rulesTokens,
      skills: skillsTokens,
      customAgents: 0,
      messages: userTokens,
      agentResponses: agentTokens,
      toolCalls: toolTokens,
      systemMessages: sysMsgTokens,
      checkpointBuffer: checkpointTokens,
      mcpDeferred: 0,
      skillsDeferred: 0,
    },
    details: {
      heavyToolCalls: heavyToolCalls.slice(0, 15),
      mcpServers,
      rules,
      skills,
      artifacts: [],
      spawnedSubagents: [],
    },
    transcriptStats: {
      path: transcriptPath,
      mtime: stat.mtimeMs,
      size: stat.size,
    },
  };
}
