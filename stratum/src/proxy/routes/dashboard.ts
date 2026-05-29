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
  code { background: #8882; padding: .1rem .3rem; border-radius: 4px; }
</style></head>
<body>
  <h1>Stratum — Phase 1 Waste Dashboard</h1>
  <div class="note" id="note"></div>
  <div class="cards" id="cards"></div>
  <h2>Waste findings</h2>
  <table id="waste"><thead><tr><th>Type</th><th>Severity</th><th>~Tokens</th><th>Detail</th></tr></thead><tbody></tbody></table>
  <h2>Sessions</h2>
  <table id="sessions"><thead><tr><th>Session</th><th>Started</th><th>Turns</th><th>Dropped</th><th>Input tok</th><th>Output tok</th></tr></thead><tbody></tbody></table>
  <script>
    const fmt = (n) => Number(n).toLocaleString();
    fetch('/dashboard/api').then(r => r.json()).then(d => {
      document.getElementById('note').textContent = d.note;
      document.getElementById('cards').innerHTML = [
        ['Sessions', d.session_count], ['Turns', fmt(d.total_turns)],
        ['Dropped (FAIL-CLOSED)', fmt(d.total_dropped_turns)],
        ['Input tokens', fmt(d.total_input_tokens)], ['Output tokens', fmt(d.total_output_tokens)],
        ['Est. cost (USD)', '$' + d.estimated_cost_usd], ['#1 waste', d.top_waste_type || '—'],
      ].map(([k,v]) => '<div class="card"><div class="v">'+v+'</div><div class="k">'+k+'</div></div>').join('');
      const wt = document.querySelector('#waste tbody');
      wt.innerHTML = d.waste.length ? d.waste.map(w =>
        '<tr><td><code>'+w.type+'</code></td><td class="sev-'+w.severity+'">'+w.severity+'</td><td>'+fmt(w.token_estimate)+'</td><td>'+w.description+'</td></tr>'
      ).join('') : '<tr><td colspan="4" class="empty">No waste detected yet — capture a few real sessions first.</td></tr>';
      const st = document.querySelector('#sessions tbody');
      st.innerHTML = d.sessions.length ? d.sessions.map(s =>
        '<tr><td><code>'+s.session_id.slice(0,8)+'</code></td><td>'+s.started_at+'</td><td>'+s.turns+'</td><td>'+s.dropped_turns+'</td><td>'+fmt(s.input_tokens)+'</td><td>'+fmt(s.output_tokens)+'</td></tr>'
      ).join('') : '<tr><td colspan="6" class="empty">No sessions captured yet. Run: npm run dev, then point Claude Code at the proxy.</td></tr>';
    }).catch(e => { document.getElementById('cards').textContent = 'Failed to load dashboard data: ' + e; });
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
    app.get("/dashboard", async (_req, reply) => {
      void reply.header("content-type", "text/html; charset=utf-8");
      return reply.send(HTML);
    });
    app.get("/dashboard/api", async () => {
      const sessions = await deps.readSessions();
      return buildDashboardData(sessions);
    });
    done();
  };
}
