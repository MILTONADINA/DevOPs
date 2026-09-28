/**
 * Waste reporting dashboard (§2d) — Phase 1.
 *
 *   GET /dashboard      → a vanilla static HTML page (no framework) that fetches
 *                          /dashboard/api and renders totals / sessions / waste.
 *   GET /dashboard/api  → DashboardData JSON (aggregated from captured sessions).
 *
 * The session source is injected (readSessions) so the route is testable via
 * app.inject() without touching disk; the entry point supplies a reader over
 * data/sessions/*.json.
 */

import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CaptureSession } from "../capture";
import { buildDashboardData } from "../dashboard-data";
import { GRAPH_DASHBOARD_HTML } from "./graph-dashboard";

export interface DashboardDeps {
  /** Returns the captured sessions to aggregate (sync or async). */
  readSessions: () => CaptureSession[] | Promise<CaptureSession[]>;
}

/** Default reader: parse every session-*.json under a directory (missing dir → []). */
export function readSessionsFromDir(dir: string): CaptureSession[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no sessions captured yet
  }
  const sessions: CaptureSession[] = [];
  for (const name of names) {
    if (!name.startsWith("session-") || !name.endsWith(".json")) continue;
    try {
      sessions.push(JSON.parse(readFileSync(path.join(dir, name), "utf-8")) as CaptureSession);
    } catch {
      // skip a corrupt/partial artifact rather than failing the whole dashboard
    }
  }
  return sessions;
}

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stratum — Phase 1 Waste Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 900px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .note { color: #888; font-size: .85rem; margin-bottom: 1.25rem; }
  .cards { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.5rem; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: .75rem 1rem; min-width: 130px; }
  .card .v { font-size: 1.5rem; font-weight: 600; } .card .k { color: #888; font-size: .8rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; }
  th { color: #888; font-weight: 600; }
  .sev-high { color: #e5484d; font-weight: 600; } .sev-medium { color: #f5a623; } .sev-low { color: #888; }
  .empty { color: #888; font-style: italic; }
  .auth { display: flex; gap: .5rem; margin-bottom: .5rem; flex-wrap: wrap; }
  .auth input { flex: 1; min-width: 240px; padding: .4rem .6rem; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; font: inherit; }
  .auth button { padding: .4rem .9rem; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  .drift { border: 2px solid #e5484d; border-radius: 8px; padding: .75rem 1rem; margin-bottom: 1rem; color: #b4232b; }
  .audit-confirmed { color: #13824b; font-weight: 700; } .audit-unverified { color: #986000; font-weight: 700; } .audit-conflict { color: #b4232b; font-weight: 700; }
  code { background: #8882; padding: .1rem .3rem; border-radius: 4px; }
</style></head>
<body>
  <h1>Stratum — Phase 1 Waste Dashboard</h1>
  <p><a href="/dashboard/graph">Explore knowledge graph</a></p>
  <div class="note" id="note"></div>
  <div class="cards" id="cards"></div>
  <h2>Historical Drift</h2>
  <div class="auth"><input id="key" type="password" autocomplete="off" placeholder="CQ API key (commercial mode)" /><button id="load-conflicts" type="button">Load alerts</button></div>
  <p id="drift-status" class="note">Enter a CQ API key, or use ?org-id= in personal mode.</p>
  <div id="drift" class="drift" role="alert" hidden><strong id="drift-count"></strong><table><thead><tr><th>Fact</th><th>Claimed</th><th>Actual</th><th>Commit</th></tr></thead><tbody id="drift-rows"></tbody></table></div>
  <h2>Audit status</h2>
  <p id="audit-status" class="note">Enter a CQ API key, or use ?org-id= in personal mode.</p>
  <table id="audit-status-table"><thead><tr><th>Fact</th><th>Status</th><th>Evidence commit</th><th>Audited</th></tr></thead><tbody></tbody></table>
  <h2>Waste findings</h2>
  <table id="waste"><thead><tr><th>Type</th><th>Severity</th><th>~Tokens</th><th>Detail</th></tr></thead><tbody></tbody></table>
  <h2>Sessions</h2>
  <table id="sessions"><thead><tr><th>Session</th><th>Started</th><th>Turns</th><th>Dropped</th><th>Input tok</th><th>Output tok</th></tr></thead><tbody></tbody></table>
  <script>
    const fmt = (n) => Number(n).toLocaleString();
    const el = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = String(value); if (cls) node.className = cls; return node; };
    const row = (values) => { const tr = document.createElement('tr'); values.forEach((v) => tr.appendChild(el('td', v))); return tr; };
    const emptyRow = (message, cols) => { const tr = document.createElement('tr'); const td = el('td', message, 'empty'); td.colSpan = cols; tr.appendChild(td); return tr; };
    fetch('/dashboard/api').then(r => { if (!r.ok) throw new Error(r.status === 403 ? 'Capture summary is unavailable in commercial mode.' : 'Capture summary failed (' + r.status + ').'); return r.json(); }).then(d => {
      document.getElementById('note').textContent = d.note;
      const cards = document.getElementById('cards');
      cards.replaceChildren();
      [
        ['Sessions', d.session_count], ['Turns', fmt(d.total_turns)],
        ['Dropped (FAIL-CLOSED)', fmt(d.total_dropped_turns)],
        ['Input tokens', fmt(d.total_input_tokens)], ['Output tokens', fmt(d.total_output_tokens)],
        ['Est. cost (USD)', '$' + d.estimated_cost_usd], ['#1 waste', d.top_waste_type || '—'],
      ].forEach(([k,v]) => { const card = el('div', null, 'card'); card.appendChild(el('div', v, 'v')); card.appendChild(el('div', k, 'k')); cards.appendChild(card); });
      const wt = document.querySelector('#waste tbody');
      wt.replaceChildren();
      if (d.waste.length) d.waste.forEach(w => { const tr = row([w.type, w.severity, fmt(w.token_estimate), w.description]); tr.children[1].className = 'sev-' + w.severity; wt.appendChild(tr); });
      else wt.appendChild(emptyRow('No waste detected yet — capture a few real sessions first.', 4));
      const st = document.querySelector('#sessions tbody');
      st.replaceChildren();
      if (d.sessions.length) d.sessions.forEach(s => st.appendChild(row([String(s.session_id).slice(0, 8), s.started_at, s.turns, s.dropped_turns, fmt(s.input_tokens), fmt(s.output_tokens)])));
      else st.appendChild(emptyRow('No sessions captured yet. Run: npm run dev, then point Claude Code at the proxy.', 6));
    }).catch(e => { document.getElementById('cards').textContent = 'Failed to load dashboard data: ' + e; });

    const keyInput = document.getElementById('key');
    const status = document.getElementById('drift-status');
    const banner = document.getElementById('drift');
    const driftRows = document.getElementById('drift-rows');
    const auditStatus = document.getElementById('audit-status');
    const auditRows = document.querySelector('#audit-status-table tbody');
    const org = new URLSearchParams(location.search).get('org-id') || '';
    keyInput.value = sessionStorage.getItem('cq_dashboard_key') || '';
    let loading = false;
    let generation = 0;
    let statusLoadingGeneration = -1;
    async function loadAuditStatuses(current, key) {
      if (statusLoadingGeneration === current) return;
      statusLoadingGeneration = current;
      try {
        const statusUrl = '/v1/memory/audit-statuses?limit=10' + (key ? '' : '&org-id=' + encodeURIComponent(org));
        const statusResponse = await fetch(statusUrl, { headers: key ? { Authorization: 'Bearer ' + key } : {}, cache: 'no-store' });
        if (!statusResponse.ok) throw new Error(statusResponse.status === 401 ? 'Invalid or missing CQ API key.' : 'Audit status lookup failed (' + statusResponse.status + ').');
        const statusData = await statusResponse.json();
        if (current !== generation) return;
        const statuses = Array.isArray(statusData.statuses) ? statusData.statuses : [];
        auditRows.replaceChildren();
        statuses.forEach(s => {
          const tr = row([s.fact_table + ':' + s.fact_id, s.status, s.evidence_commit || '—', s.audited_at]);
          tr.children[1].className = s.status === 'CONFIRMED' ? 'audit-confirmed' : s.status === 'UNVERIFIED' ? 'audit-unverified' : s.status === 'CONFLICT' ? 'audit-conflict' : '';
          auditRows.appendChild(tr);
        });
        auditStatus.textContent = statuses.length ? statuses.length + ' audited fact(s).' : 'No facts audited yet.';
      } catch (error) {
        if (current === generation) { auditRows.replaceChildren(); auditStatus.textContent = error.message || String(error); }
      } finally {
        if (statusLoadingGeneration === current) statusLoadingGeneration = -1;
      }
    }
    async function loadConflicts() {
      if (loading || document.hidden) return;
      const current = generation;
      const key = keyInput.value.trim();
      if (!key && !org) { status.textContent = 'Enter a CQ API key, or use ?org-id= in personal mode.'; auditStatus.textContent = status.textContent; banner.hidden = true; driftRows.replaceChildren(); auditRows.replaceChildren(); return; }
      loading = true;
      const url = '/v1/memory/conflicts?limit=10' + (key ? '' : '&org-id=' + encodeURIComponent(org));
      try {
        const response = await fetch(url, { headers: key ? { Authorization: 'Bearer ' + key } : {}, cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 401 ? 'Invalid or missing CQ API key.' : 'Conflict lookup failed (' + response.status + ').');
        const data = await response.json();
        if (current !== generation) return;
        const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
        driftRows.replaceChildren();
        conflicts.forEach(c => driftRows.appendChild(row([c.fact_table + ':' + c.fact_id, c.claimed_state, c.actual_state, c.conflict_commit || '—'])));
        banner.hidden = conflicts.length === 0;
        document.getElementById('drift-count').textContent = conflicts.length + ' unacknowledged Historical Drift alert(s)';
        status.textContent = conflicts.length ? 'Conflicts are suppressed from memory injection.' : 'No unacknowledged Historical Drift alerts.';
        void loadAuditStatuses(current, key);
      } catch (error) {
        if (current === generation) { banner.hidden = true; driftRows.replaceChildren(); auditRows.replaceChildren(); status.textContent = error.message || String(error); auditStatus.textContent = status.textContent; }
      } finally {
        loading = false;
        if (current !== generation) void loadConflicts();
      }
    }
    function chooseScope() {
      generation++;
      const key = keyInput.value.trim();
      if (key) sessionStorage.setItem('cq_dashboard_key', key); else sessionStorage.removeItem('cq_dashboard_key');
      void loadConflicts();
    }
    document.getElementById('load-conflicts').addEventListener('click', chooseScope);
    keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') chooseScope(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadConflicts(); });
    setInterval(() => { if (!document.hidden) void loadConflicts(); }, 3000);
    if (keyInput.value || org) void loadConflicts();
  </script>
</body></html>`;

/**
 * Build the dashboard Fastify plugin bound to the given session source.
 *
 * @param deps - the session reader.
 * @returns a plugin registering GET /dashboard and GET /dashboard/api.
 */
export function makeDashboardRoute(deps: DashboardDeps): FastifyPluginCallback {
  return function dashboardPlugin(app: FastifyInstance, _opts, done): void {
    app.get("/dashboard/graph", async (_req, reply) => {
      void reply.header("content-type", "text/html; charset=utf-8");
      void reply.header(
        "content-security-policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      void reply.header("x-frame-options", "DENY");
      void reply.header("x-content-type-options", "nosniff");
      void reply.header("referrer-policy", "no-referrer");
      return reply.send(GRAPH_DASHBOARD_HTML);
    });
    app.get("/dashboard", async (_req, reply) => {
      void reply.header("content-type", "text/html; charset=utf-8");
      void reply.header(
        "content-security-policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      void reply.header("x-frame-options", "DENY");
      void reply.header("x-content-type-options", "nosniff");
      void reply.header("referrer-policy", "no-referrer");
      return reply.send(HTML);
    });
    app.get("/dashboard/api", async (req, reply) => {
      // Captured sessions have no tenant key; a commercial server cannot safely
      // return this all-org local aggregate to a public dashboard request.
      if (req.authEnforced === true) return reply.code(403).send({ error: "capture summary unavailable in commercial mode" });
      const sessions = await deps.readSessions();
      return buildDashboardData(sessions);
    });
    done();
  };
}
