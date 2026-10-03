// REQ-11/AC-B5/B6. Run only by the parent on the disposable c4b-erasure stack.
// These synthetic negative fences test guards, not real prepare/execute receipts.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const proofDir = resolve(root, '.workflow/proofs/c4b-2026-10-03');
const runId = randomUUID();
const journalPath = resolve(proofDir, `guard-races-${runId}.json`);
const container = 'devops-stratum-isolated-c4b-erasure-db';
const ids = Object.fromEntries(['orgA', 'orgB', 'sessionA', 'sessionB', 'late', 'writer', 'retired', 'reused', 'entity', 'deadlock', 'stale'].map((key) => [key, randomUUID()]));
const journal = { runId, container, ids, status: 'prepared', cases: [] };
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const q = (key) => quote(ids[key]);
const vector = "('['||array_to_string(array_fill(0,ARRAY[384]),',')||']')::vector";
const save = () => writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

class Connection {
  constructor(name) {
    this.name = name;
    this.pending = null;
    this.buffer = '';
    this.errors = '';
    this.sequence = 0;
    this.child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C' } });
    this.exit = new Promise((resolveExit) => {
      this.child.once('error', (error) => { this.pending?.reject(error); resolveExit({ error: error.message }); });
      this.child.once('exit', (code, signal) => {
        this.pending?.reject(new Error(`${name} exited ${code}/${signal}: ${this.errors}`));
        resolveExit({ code, signal });
      });
    });
    this.child.stderr.on('data', (data) => { this.errors += data.toString(); });
    this.child.stdout.on('data', (data) => {
      this.buffer += data.toString();
      const pending = this.pending;
      if (!pending) return;
      const marker = `${pending.marker}\n`;
      const at = this.buffer.indexOf(marker);
      if (at < 0) return;
      const result = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + marker.length);
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(result);
    });
  }
  run(sql) {
    if (this.pending) throw new Error(`${this.name} already has a pending query`);
    const result = new Promise((resolveQuery, rejectQuery) => {
      const marker = `guard_race_${this.name}_${++this.sequence}`;
      const timer = setTimeout(() => rejectQuery(new Error(`${this.name} query exceeded 15 seconds`)), 15000);
      this.pending = { marker, resolve: resolveQuery, reject: rejectQuery, timer };
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
    // Barrier observation can finish before a peer's query is awaited. Attach a
    // handler immediately while preserving rejection for its eventual await.
    result.catch(() => {});
    return result;
  }
  async init() {
    const result = await this.run(`SET application_name=${quote(`c4b-guard-${runId}-${this.name}`)};
      SET statement_timeout='10s'; SET lock_timeout='8s';
      CREATE FUNCTION pg_temp.guard_try(sql text) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN EXECUTE sql; RETURN '00000'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $$;
      CREATE FUNCTION pg_temp.guard_wait(blocked integer,blocker integer) RETURNS boolean LANGUAGE plpgsql AS $$
      DECLARE until_at timestamptz:=clock_timestamp()+interval '5 seconds';
      BEGIN LOOP
        IF blocker=ANY(pg_blocking_pids(blocked)) THEN RETURN true; END IF;
        IF clock_timestamp()>until_at THEN RAISE EXCEPTION 'expected database lock barrier not reached'; END IF;
        PERFORM pg_sleep(.01);
      END LOOP; END $$;
      DO $$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',(SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema())); END $$;
      GRANT EXECUTE ON FUNCTION pg_temp.guard_try(text),pg_temp.guard_wait(integer,integer) TO service_role;
      SELECT pg_backend_pid();`);
    assert.match(result, /^\d+$/);
    this.pid = Number(result);
  }
  try(sql) { return this.run(`SELECT pg_temp.guard_try(${quote(sql)});`); }
  async barrier(blocked) { assert.equal(await this.run(`SELECT pg_temp.guard_wait(${blocked.pid},${this.pid});`), 't'); }
  async close() {
    if (this.pending) { clearTimeout(this.pending.timer); this.child.stdin.destroy(); this.child.kill('SIGTERM'); }
    else this.child.stdin.end('ROLLBACK;\n\\q\n');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 12000);
    const result = await this.exit;
    clearTimeout(timer);
    return result;
  }
}
const a = new Connection('a');
const b = new Connection('b');
const reset = `UPDATE public.session_erasure_state SET state='active',request_id=NULL,prepared_at=NULL,completed_at=NULL,receipt=NULL,erased_fact_ids='{}',erased_entity_ids='{}' WHERE session_id=${q('sessionA')};`;
const fence = `UPDATE public.session_erasure_state SET state='erasing',request_id=gen_random_uuid(),prepared_at=clock_timestamp() WHERE session_id=${q('sessionA')};`;
const complete = (kind, id) => `UPDATE public.session_erasure_state SET state='complete',request_id=gen_random_uuid(),prepared_at=clock_timestamp(),completed_at=clock_timestamp(),receipt='{"status":"complete","fixture":"negative-guard-race-only"}',erased_fact_ids=${kind === 'fact' ? `ARRAY[${quote(id)}::uuid]` : "'{}'"},erased_entity_ids=${kind === 'entity' ? `ARRAY[${quote(id)}::uuid]` : "'{}'"} WHERE session_id=${q('sessionA')};`;
const todo = (id, org = 'orgA', session = 'sessionA') => `INSERT INTO public.todos(id,org_id,session_id,confidence,description) VALUES(${quote(id)},${q(org)},${q(session)},.9,'guard race fixture')`;
const sourceLock = (kind, id) => `SELECT pg_advisory_xact_lock(hashtext('erasure_source:${kind}:${id}')::bigint);`;
const expectFence = async () => assert.equal(await a.run(`SELECT state FROM public.session_erasure_state WHERE session_id=${q('sessionA')};`), 'erasing');
const record = async (name, detail) => { journal.cases.push({ name, ...detail }); await save(); };
let success = false;
try {
  await mkdir(proofDir, { recursive: true }); await save();
  await Promise.all([a.init(), b.init()]);
  assert.equal(await a.run('SELECT count(*)=1 AND bool_and(NOT enabled) FROM public.erasure_deployment;'), 't');
  assert.equal(await a.run("SELECT to_regprocedure('public.lock_erasure_source(text,uuid)') IS NOT NULL;"), 't');
  await a.run(`BEGIN;
    INSERT INTO public.organizations(id,name) VALUES(${q('orgA')},'C4B guard race A'),(${q('orgB')},'C4B guard race B');
    INSERT INTO public.sessions(id,org_id,model) VALUES(${q('sessionA')},${q('orgA')},'guard-race'),(${q('sessionB')},${q('orgB')},'guard-race');
    ${todo(ids.reused)}; ${todo(ids.deadlock)};
    INSERT INTO public.knowledge_entities(id,org_id,session_id,kind,name) VALUES(${q('entity')},${q('orgA')},${q('sessionA')},'Function','guard race entity');
    -- Synthetic negative-only enrollment; orgs remain unknown and deployment disabled.
    INSERT INTO public.session_erasure_state(org_id,session_id,activation_id,state) VALUES(${q('orgA')},${q('sessionA')},gen_random_uuid(),'active');
    COMMIT;`);
  journal.status = 'running'; await save();
  await b.run('SET ROLE service_role;');

  // Fence first: demonstrate an actual wait, then refusal using the committed state.
  await a.run(`BEGIN; SELECT public.lock_erasure_org(${q('orgA')}); ${fence}`);
  const late = b.try(todo(ids.late));
  await a.barrier(b);
  await a.run('COMMIT;');
  assert.equal(await late, '55000'); await expectFence();
  assert.equal(await a.run(`SELECT count(*) FROM public.todos WHERE id=${q('late')};`), '0');
  await record('fence-first', { waited: true, writerState: '55000', contentAbsent: true });

  // Writer first: the fence waits for the actual ordinary writer transaction.
  await a.run(reset);
  await b.run(`BEGIN; ${todo(ids.writer)};`);
  const prepare = a.run(`BEGIN; SELECT public.lock_erasure_org(${q('orgA')}); ${fence}`);
  await b.barrier(a);
  await b.run('COMMIT;'); await prepare; await a.run('COMMIT;');
  await expectFence();
  assert.equal(await a.run(`SELECT count(*) FROM public.todos WHERE id=${q('writer')};`), '1');
  assert.equal(await b.try(`UPDATE public.todos SET description='late' WHERE id=${q('writer')}`), '55000');
  await record('writer-first', { waited: true, writerCommittedBeforeFence: true, laterWriteState: '55000' });

  // Global source lock across organizations, canonicalized from a braced alias.
  await a.run(reset);
  await a.run(`BEGIN; ${sourceLock('fact', ids.retired)} ${complete('fact', ids.retired)}`);
  const vectorWrite = b.try(`INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(${q('orgB')},'fact',${quote(`{${ids.retired.toUpperCase()}}`)},${vector})`);
  await a.barrier(b); await a.run('COMMIT;'); assert.equal(await vectorWrite, '55000');
  assert.equal(await a.run(`SELECT count(*) FROM public.memory_vectors WHERE org_id=${q('orgB')};`), '0');
  await record('canonical-source-retirement', { waited: true, differentOrg: true, writerState: '55000' });

  // Source deletion and attempted cross-table UUID reuse share the same lock.
  await a.run(reset);
  await a.run(`BEGIN; ${sourceLock('fact', ids.reused)} DELETE FROM public.todos WHERE id=${q('reused')}; ${complete('fact', ids.reused)}`);
  const factReuse = b.try(`INSERT INTO public.function_changes(id,org_id,session_id,confidence,old_name,change_type) VALUES(${q('reused')},${q('orgB')},${q('sessionB')},.9,'guard reuse','deprecated')`);
  await a.barrier(b); await a.run('COMMIT;'); assert.equal(await factReuse, '55000');
  assert.equal(await a.run(`SELECT (SELECT count(*) FROM public.todos WHERE id=${q('reused')})+(SELECT count(*) FROM public.function_changes WHERE id=${q('reused')});`), '0');
  await record('deleted-fact-identity-reuse', { waited: true, differentOrgAndTable: true, writerState: '55000' });

  await a.run(reset);
  await a.run(`BEGIN; ${sourceLock('entity', ids.entity)} DELETE FROM public.knowledge_entities WHERE id=${q('entity')}; ${complete('entity', ids.entity)}`);
  const entityReuse = b.try(`INSERT INTO public.knowledge_entities(id,org_id,session_id,kind,name) VALUES(${q('entity')},${q('orgB')},${q('sessionB')},'Function','guard entity reuse')`);
  await a.barrier(b); await a.run('COMMIT;'); assert.equal(await entityReuse, '55000');
  assert.equal(await a.run(`SELECT count(*) FROM public.knowledge_entities WHERE id=${q('entity')};`), '0');
  await record('deleted-entity-identity-reuse', { waited: true, differentOrg: true, writerState: '55000' });

  // Direct row operations may acquire a tuple lock before the org advisory lock.
  // Force that inversion: one statement must abort; neither changes content/fence.
  await a.run(`${reset} ${fence}`);
  await a.run(`BEGIN; SELECT public.lock_erasure_org(${q('orgA')});`);
  const update = b.try(`UPDATE public.todos SET description='unsafe deadlock update' WHERE id=${q('deadlock')}`);
  await a.barrier(b);
  const remove = a.try(`DELETE FROM public.todos WHERE id=${q('deadlock')}`);
  const first = await Promise.race([update.then((state) => ({ who: 'b', state })), remove.then((state) => ({ who: 'a', state }))]);
  let states;
  if (first.who === 'a') {
    await a.run('ROLLBACK;'); states = [first.state, await update];
  } else {
    states = [await remove, first.state]; await a.run('ROLLBACK;');
  }
  assert.deepEqual(states.slice().sort(), ['40P01', '55000'].sort());
  await expectFence();
  assert.equal(await a.run(`SELECT description FROM public.todos WHERE id=${q('deadlock')};`), 'guard race fixture');
  await record('tuple-advisory-inversion', { states, fenceRetained: true, contentUnchanged: true });

  // Snapshot predates the fence: unsupported isolation rejects before lookup;
  // READ COMMITTED refreshes and observes the committed fence in the next statement.
  for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE', 'READ COMMITTED']) {
    await a.run(reset);
    await b.run(`BEGIN ISOLATION LEVEL ${isolation}; SELECT count(*) FROM public.todos WHERE org_id=${q('orgA')};`);
    await a.run(fence);
    const state = await b.try(todo(ids.stale)); await b.run('ROLLBACK;');
    assert.equal(state, isolation === 'READ COMMITTED' ? '55000' : '0A000');
    await expectFence();
    assert.equal(await a.run(`SELECT count(*) FROM public.todos WHERE id=${q('stale')};`), '0');
    await record(`snapshot-${isolation.toLowerCase().replaceAll(' ', '-')}`, { writerState: state, fenceRetained: true });
  }

  // Only this run's synthetic metadata/fixtures are removed, in FK-safe order.
  assert.equal(await a.run(`BEGIN;
    DELETE FROM public.session_erasure_state WHERE org_id IN (${q('orgA')},${q('orgB')});
    DELETE FROM public.memory_vectors WHERE org_id IN (${q('orgA')},${q('orgB')});
    DELETE FROM public.function_changes WHERE org_id IN (${q('orgA')},${q('orgB')});
    DELETE FROM public.todos WHERE org_id IN (${q('orgA')},${q('orgB')});
    DELETE FROM public.knowledge_entities WHERE org_id IN (${q('orgA')},${q('orgB')});
    DELETE FROM public.sessions WHERE org_id IN (${q('orgA')},${q('orgB')});
    DELETE FROM public.organizations WHERE id IN (${q('orgA')},${q('orgB')});
    DELETE FROM public.erasure_org_coverage WHERE org_id IN (${q('orgA')},${q('orgB')});
    COMMIT;
    SELECT (SELECT count(*) FROM public.organizations WHERE id IN (${q('orgA')},${q('orgB')}))+
      (SELECT count(*) FROM public.session_erasure_state WHERE org_id IN (${q('orgA')},${q('orgB')}))+
      (SELECT count(*) FROM public.erasure_org_coverage WHERE org_id IN (${q('orgA')},${q('orgB')}));`), '0');
  assert.equal(await a.run(`SELECT NOT enabled FROM public.erasure_deployment WHERE id;`), 't');
  success = true; journal.status = 'passed'; journal.cleanup = 'own fixtures and synthetic metadata removed'; await save();
} catch (error) {
  journal.status = 'failed'; journal.error = error instanceof Error ? error.message : String(error);
  journal.cleanup = 'preserved committed synthetic fixtures for diagnosis; owned connections closed';
  await save(); throw error;
} finally {
  journal.connections = await Promise.all([a.close(), b.close()]);
  const badExit = success && journal.connections.some((exit) => exit.code !== 0);
  if (badExit) { journal.status='failed'; journal.error='owned psql connection did not exit cleanly'; }
  await save();
  if (!success || badExit) console.error(`Guard race evidence and fixture IDs retained at ${journalPath}`);
  if (badExit) throw new Error(journal.error);
  if (success) console.log(`Guard races passed; evidence ${journalPath}`);
}
