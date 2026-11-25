/**
 * 100% Original Local Usage Reader for Antigravity.
 * Zero external network calls, zero pricing tables, fast incremental per-file cache.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_APP_DATA = join(homedir(), '.gemini', 'antigravity');
const PROJECTS_TTL_MS = 120_000;
const INDEX_TTL_MS = 15_000;

export const FAMILIES = [
  { id: 'carbon', label: 'Gemini 4 Carbon', colorVar: '--f-carbon' },
  { id: 'argon', label: 'Gemini 4 Argon', colorVar: '--f-argon' },
  { id: 'hydrogen', label: 'Gemini 4 Hydrogen', colorVar: '--f-hydrogen' },
  { id: 'flash', label: 'Gemini Flash', colorVar: '--f-flash' },
  { id: 'claude', label: 'Claude', colorVar: '--f-claude' },
  { id: 'other', label: 'Other', colorVar: '--f-other' },
];

let projectsCache = { loadedAtMs: 0, byId: new Map(), byPath: new Map() };
let projectsInFlight = null;

// Per-conversation parsed cache keyed by convId -> { mtimeMs, size, records }
const fileRecordsCache = new Map();
let lastIndexScanAtMs = 0;

function classifyFamily(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('carbon')) return 'carbon';
  if (m.includes('argon')) return 'argon';
  if (m.includes('hydrogen') || m.includes('neon')) return 'hydrogen';
  if (m.includes('flash')) return 'flash';
  if (m.includes('claude')) return 'claude';
  return 'other';
}

export async function refreshAntigravityProjects() {
  const now = Date.now();
  if (projectsCache.loadedAtMs > 0 && now - projectsCache.loadedAtMs < PROJECTS_TTL_MS) {
    return projectsCache;
  }
  if (projectsInFlight) return projectsInFlight;

  projectsInFlight = (async () => {
    const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    if (!addr) return projectsCache;

    try {
      const headers = { 'Content-Type': 'application/json', ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}) };
      const callLs = async (method, body) => {
        const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/${method}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) throw new Error('LS error');
        return res.json();
      };

      const list = await callLs('ListProjects', {});
      const ids = Array.isArray(list?.projectIds) ? list.projectIds.filter((id) => id && id !== 'outside-of-project') : [];
      const details = await Promise.all(ids.map((id) => callLs('ReadProject', { id }).catch(() => null)));

      const byId = new Map();
      const byPath = new Map();
      for (const d of details) {
        const proj = d?.project;
        if (!proj?.id) continue;
        const name = String(proj.name || proj.id).trim();
        byId.set(proj.id, { id: proj.id, name });
        const uris = proj.workspaceUris || proj.folderUris || [];
        for (const u of uris) byPath.set(String(u), proj.id);
      }
      projectsCache = { loadedAtMs: Date.now(), byId, byPath };
    } catch {}
    projectsInFlight = null;
    return projectsCache;
  })();

  return projectsInFlight;
}

function readSummariesMeta() {
  const meta = new Map();
  const dbPath = join(DEFAULT_APP_DATA, 'conversation_summaries.db');
  if (!existsSync(dbPath)) return meta;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT conversation_id, title, project_id, workspace_uris FROM conversation_summaries')
      .all();
    for (const r of rows) {
      meta.set(r.conversation_id, {
        title: r.title || r.conversation_id,
        projectId: r.project_id || '',
        workspaceUris: r.workspace_uris || '',
      });
    }
  } catch {} finally {
    try { db?.close(); } catch {}
  }
  return meta;
}

function scanAllTranscripts() {
  const now = Date.now();
  const brainDir = join(DEFAULT_APP_DATA, 'brain');
  if (!existsSync(brainDir)) return [];

  if (now - lastIndexScanAtMs < INDEX_TTL_MS && fileRecordsCache.size > 0) {
    return Array.from(fileRecordsCache.values()).flatMap((v) => v.records);
  }

  let dirs = [];
  try {
    dirs = readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const convId = d.name;
    const tp = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(tp)) continue;

    let st;
    try { st = statSync(tp); } catch { continue; }

    const cached = fileRecordsCache.get(convId);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      continue;
    }

    const records = [];
    try {
      const lines = readFileSync(tp, 'utf8').split('\n');
      for (const line of lines) {
        if (!line || !line.includes('"PLANNER_RESPONSE"')) continue;
        try {
          const s = JSON.parse(line);
          if (s.type !== 'PLANNER_RESPONSE') continue;
          const tsMs = Date.parse(s.created_at || '');
          if (!Number.isFinite(tsMs)) continue;
          const inTok = Number(s.input_tokens) || 0;
          const cacheTok = Number(s.cache_read_tokens) || 0;
          const outTok = Number(s.output_tokens) || 0;
          if (inTok + cacheTok + outTok === 0) continue;

          records.push({
            conversationId: convId,
            tsMs,
            model: s.model || 'unknown',
            family: classifyFamily(s.model),
            uncachedInputTokens: inTok,
            cachedInputTokens: cacheTok,
            outputTokens: outTok,
            processedTokens: inTok + cacheTok + outTok,
          });
        } catch {}
      }
    } catch {}

    fileRecordsCache.set(convId, { mtimeMs: st.mtimeMs, size: st.size, records });
  }

  lastIndexScanAtMs = now;
  return Array.from(fileRecordsCache.values()).flatMap((v) => v.records);
}

function getTimeZoneFormatter(tz, opts) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts });
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...opts });
  }
}

export function queryUsage(options = {}) {
  const period = ['24h', '7d', '30d', 'all'].includes(options.period) ? options.period : '7d';
  const scope = options.scope || 'all';
  const currentConversationId = options.currentConversationId || '';
  const tz = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const allRecords = scanAllTranscripts();
  const summaries = readSummariesMeta();

  const nowMs = Date.now();
  const cutoffMs =
    period === '24h' ? nowMs - 24 * 3600_000 :
    period === '7d' ? nowMs - 7 * 86400_000 :
    period === '30d' ? nowMs - 30 * 86400_000 : 0;

  const filtered = allRecords.filter((r) => {
    if (cutoffMs && r.tsMs < cutoffMs) return false;
    if (scope === 'current' && currentConversationId && r.conversationId !== currentConversationId) return false;
    if (scope.startsWith('project:')) {
      const pid = scope.slice(8);
      if (summaries.get(r.conversationId)?.projectId !== pid) return false;
    }
    return true;
  });

  const isHourly = period === '24h';
  const keyFmt = isHourly
    ? getTimeZoneFormatter(tz, { month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    : getTimeZoneFormatter(tz, { year: 'numeric', month: '2-digit', day: '2-digit' });

  const totals = {
    processedTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheHitRate: 0,
    sessions: 0,
    records: 0,
  };

  const sessionSet = new Set();
  const slotMap = new Map();
  const modelMap = new Map();
  const sessionMap = new Map();
  const familyUsed = new Set();

  for (const r of filtered) {
    totals.processedTokens += r.processedTokens;
    totals.uncachedInputTokens += r.uncachedInputTokens;
    totals.cachedInputTokens += r.cachedInputTokens;
    totals.outputTokens += r.outputTokens;
    totals.records++;
    sessionSet.add(r.conversationId);
    familyUsed.add(r.family);

    const slotKey = keyFmt.format(new Date(r.tsMs));
    if (!slotMap.has(slotKey)) {
      slotMap.set(slotKey, {
        key: slotKey,
        label: slotKey,
        shortLabel: isHourly ? slotKey.slice(-2) + 'h' : slotKey.slice(5),
        ts: r.tsMs,
        processedTokens: 0,
        records: 0,
        byFamily: {},
      });
    }
    const slot = slotMap.get(slotKey);
    slot.processedTokens += r.processedTokens;
    slot.records++;
    if (!slot.byFamily[r.family]) slot.byFamily[r.family] = { processedTokens: 0 };
    slot.byFamily[r.family].processedTokens += r.processedTokens;

    if (!modelMap.has(r.model)) {
      modelMap.set(r.model, { model: r.model, label: r.model, processedTokens: 0, cached: 0, input: 0 });
    }
    const m = modelMap.get(r.model);
    m.processedTokens += r.processedTokens;
    m.cached += r.cachedInputTokens;
    m.input += r.uncachedInputTokens + r.cachedInputTokens;

    if (!sessionMap.has(r.conversationId)) {
      const meta = summaries.get(r.conversationId);
      sessionMap.set(r.conversationId, {
        conversationId: r.conversationId,
        title: meta?.title || basename(r.conversationId),
        processedTokens: 0,
        turns: 0,
        lastTs: r.tsMs,
      });
    }
    const sess = sessionMap.get(r.conversationId);
    sess.processedTokens += r.processedTokens;
    sess.turns++;
    if (r.tsMs > sess.lastTs) sess.lastTs = r.tsMs;
  }

  totals.sessions = sessionSet.size;
  const totalIn = totals.uncachedInputTokens + totals.cachedInputTokens;
  totals.cacheHitRate = totalIn > 0 ? totals.cachedInputTokens / totalIn : 0;

  const timeline = Array.from(slotMap.values()).sort((a, b) => a.ts - b.ts);
  const series = FAMILIES.filter((f) => familyUsed.has(f.id));
  const models = Array.from(modelMap.values())
    .map((m) => ({
      model: m.model,
      label: m.label,
      processedTokens: m.processedTokens,
      cacheHitRate: m.input > 0 ? m.cached / m.input : 0,
    }))
    .sort((a, b) => b.processedTokens - a.processedTokens);

  const sessions = Array.from(sessionMap.values()).sort((a, b) => b.lastTs - a.lastTs);

  const scopes = [{ id: 'all', label: 'All Sessions' }];
  if (currentConversationId) scopes.push({ id: 'current', label: 'Current Session' });
  for (const [id, p] of projectsCache.byId.entries()) {
    scopes.push({ id: `project:${id}`, label: p.name });
  }

  const etag = `${period}|${scope}|${totals.processedTokens}|${totals.records}|${totals.sessions}`;

  return {
    ok: true,
    etag,
    period,
    scope,
    scopes,
    series,
    totals,
    timeline,
    breakdown: { models, sessions },
  };
}
