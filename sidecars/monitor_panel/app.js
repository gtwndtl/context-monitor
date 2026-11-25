(() => {
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}k`;
    return String(Math.round(v));
  }

  function getHostContext() {
    const params = new URLSearchParams(window.location.search);
    const ag = window.__antigravity || {};
    return {
      conversationId: params.get('conversationId') || ag.conversationId || '',
      workspaces: params.get('workspaces') || (Array.isArray(ag.workspaces) ? ag.workspaces.join('|') : ''),
    };
  }

  // State
  let activeTab = 'quota';
  let cxMode = 'bar';
  let cxEtag = '';
  let usgPeriod = '7d';
  let usgScope = 'all';
  let usgEtag = '';

  const CATEGORIES = [
    { key: 'systemPrompt', label: 'System Prompt', color: 'var(--c-sys-prompt)' },
    { key: 'systemTools', label: 'System Tools', color: 'var(--c-sys-tools)' },
    { key: 'mcpTools', label: 'MCP Tools', color: 'var(--c-mcp)' },
    { key: 'mcpInstructions', label: 'MCP Instructions', color: 'var(--c-mcp-inst)' },
    { key: 'rulesFiles', label: 'Rules', color: 'var(--c-rules)' },
    { key: 'skills', label: 'Skills', color: 'var(--c-skills)' },
    { key: 'customAgents', label: 'Agents', color: 'var(--c-agents)' },
    { key: 'messages', label: 'User Messages', color: 'var(--c-messages)' },
    { key: 'agentResponses', label: 'Agent Responses', color: 'var(--c-agent)' },
    { key: 'toolCalls', label: 'Tool Calls & Outputs', color: 'var(--c-tools)' },
    { key: 'systemMessages', label: 'System Messages', color: 'var(--c-sys-msg)' },
    { key: 'checkpointBuffer', label: 'Compaction Summary', color: 'var(--c-compact)' },
  ];

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => {
        const on = b.dataset.tab === activeTab;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
      });
      $('view-context').classList.toggle('hidden', activeTab !== 'context');
      $('view-usage').classList.toggle('hidden', activeTab !== 'usage');
      $('view-quota').classList.toggle('hidden', activeTab !== 'quota');
      if (activeTab === 'context') pollContext(true);
      else if (activeTab === 'usage') pollUsage(true);
      else pollQuota();
    });
  });

  // Context view mode toggle
  $('cx-bar-btn').addEventListener('click', () => setCxMode('bar'));
  $('cx-grid-btn').addEventListener('click', () => setCxMode('grid'));

  function setCxMode(mode) {
    cxMode = mode;
    $('cx-bar-btn').classList.toggle('on', mode === 'bar');
    $('cx-grid-btn').classList.toggle('on', mode === 'grid');
    $('cx-bar').classList.toggle('hidden', mode !== 'bar');
    $('cx-grid').classList.toggle('hidden', mode !== 'grid');
  }

  // Usage controls
  document.querySelectorAll('.period-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      usgPeriod = btn.dataset.period;
      document.querySelectorAll('.period-btn').forEach((b) => b.classList.toggle('on', b.dataset.period === usgPeriod));
      usgEtag = '';
      pollUsage(true);
    });
  });

  $('usg-scope').addEventListener('change', (e) => {
    usgScope = e.target.value;
    usgEtag = '';
    pollUsage(true);
  });

  // Render Context
  function renderContext(d) {
    $('cx-loading').classList.add('hidden');
    if (!d.found) {
      $('cx-empty').classList.remove('hidden');
      $('cx-content').classList.add('hidden');
      return;
    }
    $('cx-empty').classList.add('hidden');
    $('cx-content').classList.remove('hidden');

    $('cx-pct').textContent = `${d.usedPercent}%`;
    $('cx-used').textContent = fmtTok(d.usedTokens);
    $('cx-limit').textContent = fmtTok(d.contextLimit);
    $('cx-model').textContent = d.model?.label || d.model?.id || 'Unknown model';
    $('cx-steps').textContent = `${d.stepCount || 0} steps`;

    const hitRatio = d.cache?.cacheHitRatio ?? 0;
    const cachedTok = d.cache?.cachedTokens ?? 0;
    $('cx-cache').textContent = `Cache ${hitRatio}% (${fmtTok(cachedTok)})`;

    if (d.compaction?.count > 0) {
      $('cx-compact').textContent = `${d.compaction.count} compacted`;
      $('cx-compact').classList.remove('hidden');
    } else {
      $('cx-compact').classList.add('hidden');
    }

    const cats = d.categories || {};
    const limit = Math.max(1, d.contextLimit || 1);
    const active = CATEGORIES.map((c) => ({ ...c, tokens: Number(cats[c.key]) || 0 })).filter((c) => c.tokens > 0);

    // Stacked bar
    $('cx-bar').innerHTML = active
      .map((c) => {
        const w = Math.max(0.4, (c.tokens / limit) * 100);
        return `<div class="bar-seg" style="width:${w.toFixed(2)}%;background:${c.color}" title="${esc(c.label)}: ${fmtTok(c.tokens)}"></div>`;
      })
      .join('');

    // Proportional 100-cell grid (20x5)
    const cells = [];
    for (const c of active) {
      const count = Math.max(1, Math.round((c.tokens / limit) * 100));
      for (let i = 0; i < count && cells.length < 100; i++) {
        cells.push(`<div class="grid-cell" style="background:${c.color}" title="${esc(c.label)}"></div>`);
      }
    }
    while (cells.length < 100) {
      cells.push('<div class="grid-cell" title="Free space"></div>');
    }
    $('cx-grid').innerHTML = cells.join('');

    // Breakdown rows
    $('cx-free-label').textContent = `${fmtTok(d.freeTokens)} free`;
    $('cx-rows').innerHTML = active
      .sort((a, b) => b.tokens - a.tokens)
      .map((c) => {
        const pct = ((c.tokens / limit) * 100).toFixed(1);
        return `
          <div class="cat-row">
            <div class="cat-left">
              <span class="dot" style="background:${c.color}"></span>
              <span class="cat-name">${esc(c.label)}</span>
            </div>
            <div class="cat-right num">
              <span>${fmtTok(c.tokens)}</span>
              <span class="cat-pct">${pct}%</span>
            </div>
          </div>`;
      })
      .join('');

    // Expandable details
    const det = d.details || {};
    const sections = [];

    if (det.heavyToolCalls?.length) {
      sections.push(renderDetailCard('Heavy Tool Calls', det.heavyToolCalls.length, det.heavyToolCalls.slice(0, 8).map((t) =>
        `<div class="table-row" title="${esc(t.toolName || '')}"><span class="row-main">${esc(t.label || t.toolName || 'tool')}</span><span class="row-meta num">${fmtTok(t.tokens)}</span></div>`
      ).join('')));
    }
    if (det.mcpServers?.length) {
      sections.push(renderDetailCard('MCP Servers', det.mcpServers.length, det.mcpServers.map((m) =>
        `<div class="table-row"><span class="row-main">${esc(m.name)}</span><span class="row-meta num">${m.toolCount || 0} tools · ${fmtTok(m.tokens)}</span></div>`
      ).join('')));
    }
    if (det.rules?.length) {
      sections.push(renderDetailCard('Active Rules', det.rules.length, det.rules.map((r) =>
        `<div class="table-row"><span class="row-main">${esc(r.name || r.path)}</span><span class="row-meta num">${fmtTok(r.tokens)}</span></div>`
      ).join('')));
    }
    if (det.skills?.length) {
      sections.push(renderDetailCard('Skills', det.skills.length, det.skills.map((s) =>
        `<div class="table-row"><span class="row-main">${esc(s.name)}</span><span class="row-meta num">${fmtTok(s.tokens)}</span></div>`
      ).join('')));
    }

    $('cx-details').innerHTML = sections.join('');
  }

  function renderDetailCard(title, count, bodyHtml) {
    return `
      <details class="detail-card">
        <summary><span>${esc(title)}</span><span class="num muted">${count}</span></summary>
        <div class="detail-body">${bodyHtml}</div>
      </details>`;
  }

  // Render Usage
  function renderUsage(d) {
    lastUsageData = d;
    $('usg-loading').classList.add('hidden');
    $('usg-content').classList.remove('hidden');

    // Update scope options cleanly
    const sel = $('usg-scope');
    if (Array.isArray(d.scopes) && d.scopes.length) {
      const currentVal = usgScope;
      sel.innerHTML = d.scopes
        .map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`)
        .join('');
      if (d.scopes.some((s) => s.id === currentVal)) sel.value = currentVal;
    }

    const t = d.totals || {};
    $('usg-total-tok').textContent = fmtTok(t.processedTokens);
    const totalIn = (t.uncachedInputTokens || 0) + (t.cachedInputTokens || 0) + (t.cacheCreationTokens || 0);
    $('usg-io-sub').textContent = `${fmtTok(totalIn)} in · ${fmtTok(t.outputTokens)} out`;

    const hitPct = ((t.cacheHitRate || 0) * 100).toFixed(1);
    $('usg-cache-pct').textContent = `${hitPct}%`;
    $('usg-cache-sub').textContent = `${fmtTok(t.cachedInputTokens)} cached`;

    $('usg-out-tok').textContent = fmtTok(t.outputTokens);
    $('usg-reason-sub').textContent = `${fmtTok(t.reasoningTokens)} reasoning`;

    $('usg-sessions').textContent = `${t.sessions || 0} sessions`;
    $('usg-turns-sub').textContent = `${t.records || 0} turns`;

    renderChart(d.timeline || [], d.series || []);
    renderModels(d.breakdown?.models || []);
    renderSessions(d.breakdown?.sessions || []);
  }

  function renderChart(timeline, series) {
    const svg = $('usg-chart');
    const tip = $('usg-tooltip');
    const legend = $('usg-legend');
    tip.classList.add('hidden');

    const activeSeries = Array.isArray(series) && series.length
      ? series
      : [{ id: 'total', label: 'Tokens', colorVar: '--c-messages' }];

    legend.innerHTML = activeSeries
      .map((s) => `<span class="leg-item"><i class="dot" style="background: var(${esc(s.colorVar || '--c-messages')})"></i>${esc(s.label)}</span>`)
      .join('');

    if (!timeline.length) {
      svg.innerHTML = '';
      return;
    }

    const wrapW = svg.parentElement?.clientWidth || svg.clientWidth || 320;
    const W = Math.max(160, wrapW);
    const H = Math.max(120, svg.clientHeight || 150);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const padB = 20;
    const plotH = H - padB - 8;
    const n = timeline.length;
    const step = W / n;
    const barW = Math.max(4, Math.min(28, step * 0.68));

    let maxVal = 1;
    const bars = timeline.map((pt) => {
      const segs = activeSeries.map((s) => ({
        label: s.label,
        colorVar: s.colorVar || '--c-messages',
        val: s.id === 'total'
          ? (pt.processedTokens || 0)
          : (pt.byFamily?.[s.id]?.processedTokens || 0),
      }));
      const total = pt.processedTokens || segs.reduce((a, b) => a + b.val, 0);
      if (total > maxVal) maxVal = total;
      return {
        label: pt.shortLabel || pt.label || pt.key,
        fullLabel: pt.label || pt.key,
        segs,
        total,
        records: pt.records || 0,
      };
    });

    const parts = [];
    bars.forEach((b, i) => {
      const x = i * step + (step - barW) / 2;
      let y = H - padB;

      for (const seg of b.segs) {
        if (seg.val <= 0) continue;
        const h = Math.max(1.5, (seg.val / maxVal) * plotH);
        y -= h;
        parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="var(${esc(seg.colorVar)})" rx="1"/>`);
      }

      parts.push(`<rect class="hit-bar" data-idx="${i}" x="${(i * step).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}" fill="transparent"/>`);

      if (n <= 10 || i === 0 || i === n - 1 || i % Math.ceil(n / 6) === 0) {
        parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="9" fill="var(--cx-fg-muted)">${esc(b.label)}</text>`);
      }
    });

    svg.innerHTML = parts.join('');
    svg.querySelectorAll('.hit-bar').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const b = bars[Number(el.dataset.idx)];
        if (!b) return;
        const details = b.segs
          .filter((s) => s.val > 0)
          .map((s) => `${esc(s.label)}: ${fmtTok(s.val)}`)
          .join('<br>');
        tip.innerHTML = `<strong>${esc(b.fullLabel)}</strong><br>Total: ${fmtTok(b.total)} (${b.records} turns)${details ? `<br>${details}` : ''}`;
        tip.classList.remove('hidden');
      });
      el.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    });
  }

  function renderModels(models) {
    const el = $('usg-models');
    if (!models.length) {
      el.innerHTML = '<div class="muted" style="font-size:12px">No usage recorded in this period.</div>';
      return;
    }
    el.innerHTML = models
      .slice(0, 8)
      .map((m) => {
        const hit = m.cacheHitRate != null ? `${(m.cacheHitRate * 100).toFixed(0)}% cache` : '';
        return `
          <div class="table-row">
            <span class="row-main">${esc(m.label || m.model)}</span>
            <span class="row-meta num">${fmtTok(m.processedTokens)} · ${hit}</span>
          </div>`;
      })
      .join('');
  }

  function renderSessions(sessions) {
    const el = $('usg-sessions-list');
    if (!sessions.length) {
      el.innerHTML = '<div class="muted" style="font-size:12px">No sessions in this period.</div>';
      return;
    }
    el.innerHTML = sessions
      .slice(0, 10)
      .map((s) => `
        <div class="table-row">
          <span class="row-main">${esc(s.title || s.conversationId)}</span>
          <span class="row-meta num">${fmtTok(s.processedTokens)} · ${s.turns || 0}t</span>
        </div>`)
      .join('');
  }

  // Polling
  async function pollContext(force = false) {
    const { conversationId, workspaces } = getHostContext();
    const qs = new URLSearchParams();
    if (conversationId) qs.set('conversationId', conversationId);
    if (workspaces) qs.set('workspaces', workspaces);
    if (!force && cxEtag) qs.set('etag', cxEtag);

    try {
      const res = await fetch(`/api/context?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.unchanged) return;
      if (data.etag) cxEtag = data.etag;
      renderContext(data);
    } catch {
      // ignore transient poll error
    }
  }

  async function pollUsage(force = false) {
    const { conversationId } = getHostContext();
    const qs = new URLSearchParams({ period: usgPeriod, scope: usgScope });
    if (conversationId) qs.set('conversationId', conversationId);
    if (!force && usgEtag) qs.set('etag', usgEtag);
    try {
      qs.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    } catch {}

    try {
      const res = await fetch(`/api/usage?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.unchanged) return;
      if (data.etag) usgEtag = data.etag;
      renderUsage(data);
    } catch {
      // ignore transient poll error
    }
  }

  // Quota rendering, model picker (disk-persisted) & polling
  const DEFAULT_QUOTA_MODELS = [];
  let selectedModels = new Set(DEFAULT_QUOTA_MODELS);
  let prefsLoaded = false;
  let lastQuotaData = null;
  let lastUsageData = null;

  async function ensureQuotaPrefs() {
    if (prefsLoaded) return;
    prefsLoaded = true;
    try {
      const res = await fetch('/api/quota/prefs');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.selectedModels)) {
        selectedModels = new Set(data.selectedModels);
      }
    } catch {}
  }

  async function saveSelectedModels(set) {
    const arr = Array.from(set);
    try {
      await fetch('/api/quota/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedModels: arr }),
      });
    } catch {}
  }

  function baseModelName(label) {
    return String(label || '')
      .replace(/\s*\((Low|Medium|High|XHigh|Fast)\)\s*$/i, '')
      .trim();
  }

  function getUniqueBaseModels(models) {
    const map = new Map();
    for (const m of models || []) {
      const base = baseModelName(m.label);
      if (!map.has(base)) {
        map.set(base, {
          name: base,
          remainingFraction: m.remainingFraction,
          remainingPct: m.remainingPct,
          resetTime: m.resetTime,
        });
      }
    }
    return Array.from(map.values());
  }

  function getWindowType(iso) {
    if (!iso) return null;
    const target = Date.parse(iso);
    if (!Number.isFinite(target)) return null;
    const diffMs = target - Date.now();
    return diffMs > 12 * 3600 * 1000 ? 'weekly' : 'short';
  }

  function renderWinTag(iso) {
    const w = getWindowType(iso);
    if (w === 'weekly') return '<span class="win-tag weekly">Weekly</span>';
    if (w === 'short') return '<span class="win-tag short">5h</span>';
    return '';
  }

  function toneColor(pct) {
    if (pct === null || pct === undefined) return 'var(--cx-fg-muted)';
    if (pct <= 15) return '#ef4444';
    if (pct <= 50) return '#f59e0b';
    return 'var(--c-mcp)';
  }

  function fmtReset(iso) {
    if (!iso) return 'No reset timer';
    const target = Date.parse(iso);
    if (!Number.isFinite(target)) return '';
    const diffMs = target - Date.now();
    const localTime = new Date(target).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffMs <= 0) return `Resetting soon (${localTime})`;
    const mins = Math.floor(diffMs / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `Resets in ${days}d ${hrs % 24}h`;
    if (hrs > 0) return `Resets in ${hrs}h ${mins % 60}m (${localTime})`;
    return `Resets in ${Math.max(1, mins)}m (${localTime})`;
  }

  function renderPicker(baseModels) {
    const chipsEl = $('q-chips');
    chipsEl.innerHTML = baseModels
      .map((m) => {
        const on = selectedModels.has(m.name);
        return `<button type="button" class="model-chip${on ? ' on' : ''}" data-model="${esc(m.name)}">${esc(m.name)}</button>`;
      })
      .join('');

    chipsEl.querySelectorAll('.model-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.model;
        if (selectedModels.has(name)) selectedModels.delete(name);
        else selectedModels.add(name);
        saveSelectedModels(selectedModels);
        if (lastQuotaData) renderQuota(lastQuotaData);
      });
    });
  }

  function renderRingSvg(pct, color) {
    const val = pct === null || pct === undefined ? 100 : Math.max(0, Math.min(100, pct));
    const r = 7.5;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - val / 100);
    return `
      <svg class="ring-svg" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="${r}" fill="none" stroke="var(--cx-track)" stroke-width="2.4"/>
        <circle cx="10" cy="10" r="${r}" fill="none" stroke="${color}" stroke-width="2.4"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round"/>
      </svg>`;
  }

  function friendlyPoolName(families) {
    const joined = families.join(' ').toLowerCase();
    if (joined.includes('claude') || joined.includes('gpt')) return 'Claude and GPT models';
    if (joined.includes('argon') && !joined.includes('neon')) return 'Gemini 4 Argon';
    if (joined.includes('neon') || joined.includes('hydrogen') || joined.includes('flash')) return 'Gemini Models';
    return families.slice(0, 2).join(' · ');
  }

  function poolOrderScore(title) {
    if (title === 'Gemini Models') return 1;
    if (title === 'Claude and GPT models') return 2;
    if (title === 'Gemini 4 Argon') return 3;
    return 4;
  }

  function renderQuota(data) {
    lastQuotaData = data;
    $('q-loading').classList.add('hidden');
    if (!data?.ok) {
      $('q-error').textContent = data?.error || 'Unable to fetch local quota.';
      $('q-error').classList.remove('hidden');
      $('q-content').classList.add('hidden');
      return;
    }
    $('q-error').classList.add('hidden');
    $('q-content').classList.remove('hidden');

    if (data.plan?.name) {
      $('q-plan-badge').textContent = data.plan.name;
      $('q-plan-badge').classList.remove('hidden');
    }

    if (data.fetchedAt) {
      $('q-updated-at').textContent = new Date(data.fetchedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    const pools = [...(data.pools || [])]
      .map((p) => ({ ...p, groupTitle: friendlyPoolName(p.families || []) }))
      .sort((a, b) => poolOrderScore(a.groupTitle) - poolOrderScore(b.groupTitle));

    $('q-pools').innerHTML = pools.length
      ? pools
          .map((p) => {
            const pct = p.remainingPct;
            const color = toneColor(pct);
            const winLabel = p.groupTitle === 'Claude and GPT models'
              ? 'Weekly limit'
              : (getWindowType(p.resetTime) === 'weekly' ? 'Weekly limit' : '5h limit');
            const resetStr = fmtReset(p.resetTime);
            const members = (p.families || []).join(', ');
            return `
              <div class="q-group" title="${esc(members)}">
                <div class="q-group-title">${esc(p.groupTitle)}</div>
                <div class="q-group-row">
                  <div class="q-group-meta">
                    <span class="q-limit-label">${winLabel}</span>
                    ${resetStr ? `<span class="q-reset-label">${esc(resetStr)}</span>` : ''}
                  </div>
                  <div class="ring-right">
                    <span class="ring-pct num">${Math.round(pct)}% left</span>
                    ${renderRingSvg(pct, color)}
                  </div>
                </div>
              </div>`;
          })
          .join('')
      : '<div class="muted" style="font-size:12px">No quota pools reported.</div>';

    const models = data.models || [];
    $('q-models-count').textContent = String(models.length);
    $('q-models').innerHTML = models
      .map((m) => {
        const pctText = m.remainingPct !== null ? `${m.remainingPct.toFixed(1)}%` : 'Unlimited';
        const color = toneColor(m.remainingPct);
        return `
          <div class="table-row">
            <span class="row-main">${esc(m.label)}</span>
            <span class="row-meta num">
              <span style="color:${color};font-weight:600">${pctText}</span>
              <span class="muted">${m.resetTime ? esc(fmtReset(m.resetTime)) : ''}</span>
            </span>
          </div>`;
      })
      .join('');
  }

  async function pollQuota() {
    try {
      const res = await fetch('/api/quota', { cache: 'no-store' });
      if (!res.ok) return;
      renderQuota(await res.json());
    } catch {
      // ignore transient error
    }
  }

  $('q-refresh-btn').addEventListener('click', pollQuota);

  function refreshActiveTab(force = false) {
    if (activeTab === 'context') pollContext(force);
    else if (activeTab === 'usage') pollUsage(force);
    else pollQuota();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshActiveTab(true);
  });
  window.addEventListener('focus', () => refreshActiveTab(false));

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (activeTab === 'usage' && lastUsageData) {
        renderChart(lastUsageData.timeline || [], lastUsageData.series || []);
      }
    }).observe($('usg-chart'));
  }

  pollQuota();
  let lastUsagePollAt = 0;
  setInterval(() => {
    if (document.hidden) return;
    if (activeTab === 'context') {
      pollContext(false);
    } else if (activeTab === 'usage') {
      const now = Date.now();
      if (now - lastUsagePollAt >= 15000) {
        lastUsagePollAt = now;
        pollUsage(false);
      }
    } else {
      pollQuota();
    }
  }, 2500);
})();
