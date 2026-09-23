/** Standalone, scoped graph viewer; graph data comes only from the memory API. */
export const GRAPH_DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stratum — Knowledge Graph</title>
<style>
:root { color-scheme: light dark; font: 15px/1.4 system-ui, sans-serif; }
body { margin: 0; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; padding: .7rem 1rem; border-bottom: 1px solid #8885; }
h1 { font-size: 1.2rem; margin: 0 auto 0 0; }
a { color: #4787d8; }
input, button { font: inherit; color: inherit; background: transparent; border: 1px solid #8888; border-radius: 5px; padding: .35rem .55rem; }
button { cursor: pointer; }
input { min-width: 13rem; }
#status { padding: .45rem 1rem; margin: 0; min-height: 1.5rem; }
main { display: grid; grid-template-columns: minmax(0, 1fr) 19rem; height: calc(100dvh - 7rem); min-height: 24rem; }
#canvas { width: 100%; height: 100%; background: #121b27; touch-action: none; cursor: grab; }
#canvas:active { cursor: grabbing; }
#details { border-left: 1px solid #8885; padding: 1rem; overflow: auto; overflow-wrap: anywhere; }
#details h2 { font-size: 1rem; margin: 0 0 .5rem; }
#details p { margin: .35rem 0 .9rem; }
#relations { padding-left: 1.2rem; }
@media (max-width: 700px) { main { grid-template-columns: 1fr; grid-template-rows: minmax(18rem, 55vh) auto; height: auto; } #details { border-left: 0; border-top: 1px solid #8885; } }
</style></head><body>
<header><h1><a href="/dashboard">Stratum</a> / Knowledge Graph</h1>
<input id="key" type="password" autocomplete="off" placeholder="CQ API key" aria-label="CQ API key">
<button id="load" type="button">Load graph</button>
<button id="zoom-in" type="button" aria-label="Zoom in">+</button><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="reset" type="button">Reset view</button></header>
<p id="status" role="status">Enter a CQ API key, or use ?org-id= in personal mode.</p>
<main><svg id="canvas" xmlns="http://www.w3.org/2000/svg" aria-label="Knowledge graph" role="img"><g id="viewport"></g></svg>
<aside id="details"><h2>Node details</h2><p>Select a node to see its source path, summary, and relationships. Selecting a node also reveals its neighbors.</p><ul id="relations"></ul></aside></main>
<script>
const svgNS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('canvas');
const viewport = document.getElementById('viewport');
const status = document.getElementById('status');
const details = document.getElementById('details');
const relations = document.getElementById('relations');
const keyInput = document.getElementById('key');
const org = new URLSearchParams(location.search).get('org-id') || '';
keyInput.value = sessionStorage.getItem('cq_dashboard_key') || '';
let nodes = [], edges = [], byId = new Map(), visible = new Set(), selected = null;
let x = 0, y = 0, scale = 1, dragging = null;
function element(tag, value) { const node = document.createElement(tag); if (value != null) node.textContent = String(value); return node; }
function vector(tag, attrs) { const node = document.createElementNS(svgNS, tag); Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v))); return node; }
function transform() { viewport.setAttribute('transform', 'translate(' + x + ' ' + y + ') scale(' + scale + ')'); }
function positions(items) {
  const points = new Map();
  items.forEach((node, i) => {
    const ring = Math.floor(i / 24), slot = i % 24, count = Math.min(24, items.length - ring * 24);
    const angle = 2 * Math.PI * slot / count;
    const radius = 135 + 125 * ring;
    points.set(node.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  });
  return points;
}
function select(id) {
  const node = byId.get(id);
  if (!node) return;
  selected = id;
  const attached = edges.filter(e => e.from_entity === id || e.to_entity === id);
  attached.forEach(e => { visible.add(e.from_entity); visible.add(e.to_entity); });
  details.replaceChildren(element('h2', node.name), element('p', 'Type: ' + node.kind),
    element('p', 'Path: ' + (node.file_path || '—')), element('p', node.summary || 'No summary available.'), relations);
  relations.replaceChildren();
  attached.forEach(e => {
    const other = byId.get(e.from_entity === id ? e.to_entity : e.from_entity);
    if (!other) return;
    const item = element('li');
    const button = element('button', e.edge_type + ' → ' + other.name);
    button.type = 'button';
    button.addEventListener('click', () => select(other.id));
    item.appendChild(button); relations.appendChild(item);
  });
  if (!attached.length) relations.appendChild(element('li', 'No relationships in this snapshot.'));
  draw();
}
function draw() {
  viewport.replaceChildren();
  const shown = nodes.filter(n => visible.has(n.id));
  const points = positions(shown);
  edges.forEach(edge => {
    const a = points.get(edge.from_entity), b = points.get(edge.to_entity);
    if (!a || !b) return;
    viewport.appendChild(vector('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#65839b', 'stroke-width': 1.5 }));
  });
  shown.forEach(node => {
    const point = points.get(node.id);
    const group = vector('g', { transform: 'translate(' + point.x + ' ' + point.y + ')', tabindex: 0, role: 'button', 'aria-label': node.name });
    const circle = vector('circle', { r: node.id === selected ? 17 : 12, fill: node.kind === 'File' ? '#35a6ae' : '#b67ade', stroke: '#fff', 'stroke-width': node.id === selected ? 2 : 0 });
    const label = vector('text', { x: 18, y: 4, fill: '#fff', 'font-size': 12 });
    label.textContent = node.name.length > 30 ? node.name.slice(-30) : node.name;
    group.append(circle, label);
    group.addEventListener('click', event => { event.stopPropagation(); select(node.id); });
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.id); } });
    viewport.appendChild(group);
  });
  transform();
}
function zoom(factor) { scale = Math.min(4, Math.max(.2, scale * factor)); transform(); }
document.getElementById('zoom-in').addEventListener('click', () => zoom(1.25));
document.getElementById('zoom-out').addEventListener('click', () => zoom(.8));
document.getElementById('reset').addEventListener('click', () => { x = svg.clientWidth / 2; y = svg.clientHeight / 2; scale = 1; transform(); });
svg.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.1 : .9); }, { passive: false });
svg.addEventListener('pointerdown', event => { dragging = { x: event.clientX, y: event.clientY }; svg.setPointerCapture(event.pointerId); });
svg.addEventListener('pointermove', event => { if (!dragging) return; x += event.clientX - dragging.x; y += event.clientY - dragging.y; dragging = { x: event.clientX, y: event.clientY }; transform(); });
svg.addEventListener('pointerup', () => { dragging = null; });
svg.addEventListener('pointercancel', () => { dragging = null; });
async function load() {
  const key = keyInput.value.trim();
  if (!key && !org) { status.textContent = 'Enter a CQ API key, or use ?org-id= in personal mode.'; return; }
  if (key) sessionStorage.setItem('cq_dashboard_key', key); else sessionStorage.removeItem('cq_dashboard_key');
  status.textContent = 'Loading graph…';
  try {
    const url = '/v1/memory/graph?limit=500' + (key ? '' : '&org-id=' + encodeURIComponent(org));
    const response = await fetch(url, { headers: key ? { Authorization: 'Bearer ' + key } : {}, cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Invalid or missing CQ API key.' : 'Graph request failed (' + response.status + ').');
    const graph = await response.json();
    nodes = Array.isArray(graph.entities) ? graph.entities : [];
    edges = Array.isArray(graph.edges) ? graph.edges : [];
    byId = new Map(nodes.map(n => [n.id, n]));
    visible = new Set(nodes.slice(0, 40).map(n => n.id));
    selected = null;
    details.replaceChildren(element('h2', 'Node details'), element('p', 'Select a node to see its relationships.'), relations);
    relations.replaceChildren();
    x = svg.clientWidth / 2; y = svg.clientHeight / 2; scale = 1;
    draw();
    status.textContent = nodes.length + ' nodes, ' + edges.length + ' edges loaded. Showing ' + visible.size + ' nodes; select one to reveal neighbors.' + (nodes.length === 500 ? ' Snapshot may be truncated at 500 nodes.' : '');
  } catch (error) {
    nodes = []; edges = []; byId = new Map(); visible = new Set(); draw();
    status.textContent = error.message || String(error);
  }
}
document.getElementById('load').addEventListener('click', load);
keyInput.addEventListener('keydown', event => { if (event.key === 'Enter') load(); });
if (keyInput.value || org) load();
</script></body></html>`;
