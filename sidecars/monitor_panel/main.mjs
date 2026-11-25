/**
 * Context & Usage Panel sidecar backend.
 *
 * 100% local read-only HTTP server using Antigravity's SidecarApp SDK.
 * Zero external network calls, zero pricing/cost tracking.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ID_RE,
  analyzeConversation,
  listRecentConversations,
  resolveConversationAppData,
} from './analyzer.mjs';
import { queryUsage, refreshAntigravityProjects } from './usage_reader.mjs';

const { SidecarApp, Response } = await import('sidecar_sdk');

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};
const NO_STORE = { 'Cache-Control': 'no-store' };

function parseWorkspaceUris(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u) : [];
    } catch {
      return [];
    }
  }
  return trimmed
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

const app = new SidecarApp();

app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
  contentType: 'text/html; charset=utf-8',
  headers: NO_STORE,
}));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType, headers: NO_STORE }),
    'GET'
  );
}

app.api(
  '/api/context',
  async (data) => {
    const requestedConv = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
    const hostConv = app.config.conversationId || '';
    const conv = requestedConv || hostConv || listRecentConversations(1)[0]?.id || '';
    const workspaceUris = parseWorkspaceUris(data.workspaces);

    if (!conv || !ID_RE.test(conv)) {
      return { conversationId: conv || null, found: false };
    }

    const appData = resolveConversationAppData(conv);
    if (!appData) {
      return { conversationId: conv, found: false };
    }

    const snap = await analyzeConversation(appData, conv, { workspaceUris });
    if (!snap.found) {
      return { conversationId: conv, found: false };
    }

    const subSig = snap.details.spawnedSubagents
      .map((s) => `${s.conversationId || ''}:${s.stats?.steps || 0}`)
      .join(',');
    const etag = [
      conv,
      snap.contextLimit,
      snap.model?.id || '',
      workspaceUris.join(','),
      snap.transcriptStats.mtime,
      snap.transcriptStats.size,
      snap.stepCount,
      snap.compaction.count,
      snap.usedTokens,
      snap.categories.mcpDeferred,
      snap.categories.skillsDeferred,
      snap.details.artifacts.length,
      subSig,
    ].join('|');

    if (data.etag && data.etag === etag) {
      return { conversationId: conv, found: true, unchanged: true, etag };
    }

    return { ...snap, etag };
  },
  'GET'
);

let warmUpStarted = false;
function warmUsageInBackground() {
  if (warmUpStarted) return;
  warmUpStarted = true;
  setTimeout(async () => {
    try {
      await refreshAntigravityProjects();
      queryUsage({ period: '7d', scope: 'all' });
    } catch {}
  }, 400);
}

app.api(
  '/api/usage',
  async (data) => {
    // Refresh projects in background so /api/usage never blocks on LS RPCs
    refreshAntigravityProjects().catch(() => {});

    const currentConversationId =
      (typeof data.conversationId === 'string' && data.conversationId.trim()) ||
      app.config.conversationId ||
      '';
    const result = queryUsage({
      period: typeof data.period === 'string' ? data.period : '7d',
      scope: typeof data.scope === 'string' ? data.scope : 'all',
      family: typeof data.family === 'string' ? data.family : '',
      timeZone: typeof data.tz === 'string' ? data.tz : undefined,
      currentConversationId,
    });

    if (data.etag && data.etag === result.etag) {
      return { ok: true, unchanged: true, etag: result.etag };
    }
    return result;
  },
  'GET'
);

function baseModelName(label) {
  return String(label || '')
    .replace(/\s*\((Low|Medium|High|XHigh|Fast)\)\s*$/i, '')
    .trim();
}

function buildQuotaSnapshot(raw) {
  const us = raw?.userStatus;
  if (!us) return { ok: false, error: 'Missing userStatus' };

  const planInfo = us.planStatus?.planInfo || {};
  const plan = {
    name: planInfo.planName || planInfo.teamsTier || 'Unknown',
    availablePromptCredits: us.planStatus?.availablePromptCredits ?? null,
    availableFlowCredits: us.planStatus?.availableFlowCredits ?? null,
  };

  const configs = us.cascadeModelConfigData?.clientModelConfigs || [];
  const models = [];
  const poolMap = new Map();

  for (const cfg of configs) {
    const label = cfg.label || cfg.modelOrAlias?.model || 'Unknown';
    const q = cfg.quotaInfo;
    const hasQuota = q && typeof q.remainingFraction === 'number';
    const remainingFraction = hasQuota ? Math.max(0, Math.min(1, q.remainingFraction)) : null;
    const resetTime = q?.resetTime || null;

    models.push({
      label,
      remainingFraction,
      remainingPct: remainingFraction !== null ? Number((remainingFraction * 100).toFixed(1)) : null,
      resetTime,
    });

    if (remainingFraction !== null) {
      const key = `${resetTime || 'none'}|${remainingFraction.toFixed(4)}`;
      if (!poolMap.has(key)) {
        poolMap.set(key, {
          key,
          remainingFraction,
          remainingPct: Number((remainingFraction * 100).toFixed(1)),
          resetTime,
          families: new Set(),
          models: [],
        });
      }
      const pool = poolMap.get(key);
      pool.families.add(baseModelName(label));
      pool.models.push(label);
    }
  }

  const pools = Array.from(poolMap.values()).map((p) => {
    const families = Array.from(p.families);
    const title = families.slice(0, 3).join(' · ') + (families.length > 3 ? ` +${families.length - 3}` : '');
    return {
      title,
      families,
      modelCount: p.models.length,
      remainingFraction: p.remainingFraction,
      remainingPct: p.remainingPct,
      resetTime: p.resetTime,
    };
  });

  pools.sort((a, b) => a.remainingFraction - b.remainingFraction);

  return { ok: true, fetchedAt: new Date().toISOString(), plan, pools, models };
}

app.api(
  '/api/quota',
  async () => {
    const addr = process.env.ANTIGRAVITY_LS_ADDRESS || 'localhost:5387';
    const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['x-codeium-csrf-token'] = csrf;

    try {
      const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return { ok: false, error: `Language Server HTTP ${res.status}` };
      return buildQuotaSnapshot(await res.json());
    } catch (err) {
      return { ok: false, error: err?.message || 'Failed to reach local Language Server' };
    }
  },
  'GET'
);

warmUsageInBackground();
app.run();
