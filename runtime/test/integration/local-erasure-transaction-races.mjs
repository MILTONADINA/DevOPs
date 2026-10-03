// REQ-10/11/12, AC-B5/B6/B7/B8/B9. Parent-only isolated SQL proof.
// Real normal enrollment and committed prepare/execute; no synthetic positive states.
// Trusted operator activation covers only these bound SQL fixture consumers. It
// does not prove actual proxy/process activation, HTTP retries or arbitrary stores.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ownPath=fileURLToPath(import.meta.url);
const root=resolve(dirname(ownPath),'../../..');
const container='devops-stratum-isolated-c4b-erasure-db';
const proofDir=resolve(root,'.workflow/proofs/c4b-2026-10-03');
const runId=randomUUID();
const activationId=randomUUID();
const journalPath=resolve(proofDir,`transaction-races-${runId}.json`);
const triggerName=`tx_fail_${runId.replaceAll('-','')}`;
const fixtures=[];
const journal={runId,container,activationId,scope:'controlled_sql_fixture_consumers_only',status:'prepared',fixtures,cases:[],connections:[]};
const quote=(value)=>value===null?'NULL':`'${String(value).replaceAll("'","''")}'`;
const hash=(value)=>createHash('sha256').update(value).digest('hex');
let saveTail=Promise.resolve();
const save=()=>{const body=`${JSON.stringify(journal,null,2)}\n`;const writing=saveTail.then(()=>writeFile(journalPath,body));saveTail=writing.catch(()=>{});return writing;};
const uuid=(value)=>{assert.match(value,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);return value;};
const vector="('['||array_to_string(array_fill(0,ARRAY[384]),',')||']')::vector";
const deletedKeys=['sessions','billing_records','pruning_logs','function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references','audit_conflicts','audit_statuses','knowledge_entities','knowledge_edges','knowledge_entity_sessions','knowledge_edge_sessions','source_fact_links','memory_vectors'].sort();
const retainedKeys=['knowledge_entities','knowledge_edges','knowledge_entity_sessions','knowledge_edge_sessions','source_fact_links','memory_vectors','erasure_deployment','erasure_org_coverage','session_erasure_state','erased_fact_ids','erased_entity_ids'].sort();
const exclusions=['client_held_responses','privileged_host_database_snapshots','physical_heap_os_remnants'];

class Connection {
  constructor(name) {
    this.name = name;
    this.pending = null;
    this.buffer = '';
    this.errors = '';
    this.sequence = 0;
    this.ended = false;
    this.child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C' } });
    this.exit = new Promise((resolveExit) => {
      this.child.once('error', (error) => { this.ended=true; this.pending?.reject(error); resolveExit({ error: error.message }); });
      this.child.once('exit', (code, signal) => {
        this.ended=true;
        this.pending?.reject(new Error(`${name} exited ${code}/${signal}: ${this.errors}`));
        resolveExit({ code, signal });
      });
    });
    this.child.stdin.on('error',(error)=>this.pending?.reject(error));
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
    if (this.ended) throw new Error(`${this.name} connection already exited`);
    if (this.pending) throw new Error(`${this.name} already has a pending query`);
    const result = new Promise((resolveQuery, rejectQuery) => {
      const marker = `transaction_race_${this.name}_${++this.sequence}`;
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
    const result = await this.run(`SET application_name=${quote(`c4b-transaction-${runId}-${this.name}`)};
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
    if (this.ended) { if(this.pending)clearTimeout(this.pending.timer); return this.exit; }
    if (this.pending) { clearTimeout(this.pending.timer); this.child.stdin.destroy(); this.child.kill('SIGTERM'); }
    else this.child.stdin.end('ROLLBACK;\n\\q\n');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 12000);
    const result = await this.exit;
    clearTimeout(timer);
    return result;
  }
}
let a; let b; let originalDeployment; let activated=false; let injection=false;
const allConnections=[];
const open=async(name)=>{const c=new Connection(name);allConnections.push(c);c.record={name,status:'opening'};journal.connections.push(c.record);await c.init();Object.assign(c.record,{pid:c.pid,status:'open'});await save();return c;};
const close=async(c)=>{if(!c||c.record.status==='closed')return;c.record.exit=await c.close();c.record.status='closed';await save();};
const service=(c,sql)=>c.run(`SET ROLE service_role; ${sql}`);
const operator=(c,sql)=>c.run(`RESET ROLE; ${sql}`);
const record=async(name,detail={})=>{journal.cases.push({name,...detail});await save();};
const prepSQL=(f)=>`SELECT public.prepare_session_erasure(${quote(f.org)},${quote(f.target)})::text;`;
const execSQL=(f)=>`SELECT public.execute_session_erasure(${quote(f.org)},${quote(f.target)})::text;`;
const todoSQL=(f,id=randomUUID())=>`INSERT INTO public.todos(id,org_id,session_id,confidence,description) VALUES(${quote(id)},${quote(f.org)},${quote(f.target)},.9,'transaction fixture todo')`;
const factSQL=(table,f,id)=>{
  const base=`id,org_id,session_id,confidence`;
  const vals=`${quote(id)},${quote(f.org)},${quote(f.target)},.9`;
  const specific={function_changes:[',old_name,change_type,file_path',",'private_fn','deprecated','private.ts'"],tech_decisions:[',decision_text,domain',",'transaction fixture decision','private.ts'"],policy_updates:[',policy_name,new_value,policy_type',",'transaction policy','required','process'"],todos:[',description',",'transaction todo'"],variable_changes:[',var_name,new_value',",'transaction variable','value'"],operational_references:[',subject,reference',",'transaction runbook','private.md'"]}[table];
  assert.ok(specific);
  return `INSERT INTO public.${table}(${base}${specific[0]}) VALUES(${vals}${specific[1]})`;
};
const entitySQL=(f,session,name,kind='Function')=>`SELECT public.write_managed_graph_entity(${quote(f.org)},${quote(session)},${quote(JSON.stringify({kind,name,project_scope:null,scope_verified:true,...(kind==='File'?{file_path:name}:{})}))}::jsonb);`;
const edgeSQL=(f,session,from,to)=>`SELECT public.write_managed_graph_edge(${quote(f.org)},${quote(session)},${quote(JSON.stringify({from_entity:from,to_entity:to,edge_type:'DECLARES',project_scope:null,scope_verified:true}))}::jsonb);`;
async function fixture(label,full=false){
  const f={label,org:uuid(await service(a,`SELECT id FROM public.create_managed_organization(${quote(`C4B transaction ${label}`)},'growth');`)),facts:{},ids:{}};
  fixtures.push(f);await save();
  f.target=uuid(await service(a,`SELECT id FROM public.create_session_if_under_cap(${quote(f.org)},'transaction-target',10);`));
  f.survivor=uuid(await service(a,`SELECT id FROM public.create_session_if_under_cap(${quote(f.org)},'transaction-survivor',10);`));
  f.facts.todos=randomUUID();await service(a,`${factSQL('todos',f,f.facts.todos)};`);
  f.ids.privateFn=uuid(await service(a,entitySQL(f,f.target,'private_fn')));
  if(full){
    f.ids.privateFile=uuid(await service(a,entitySQL(f,f.target,'private.ts','File')));
    f.ids.privateEdge=uuid(await service(a,edgeSQL(f,f.target,f.ids.privateFile,f.ids.privateFn)));
    f.ids.sharedFile=uuid(await service(a,entitySQL(f,f.survivor,'shared.ts','File')));
    f.ids.sharedFn=uuid(await service(a,entitySQL(f,f.survivor,'shared_fn')));
    f.ids.sharedEdge=uuid(await service(a,edgeSQL(f,f.survivor,f.ids.sharedFile,f.ids.sharedFn)));
    assert.equal(await service(a,entitySQL(f,f.target,'shared.ts','File')),f.ids.sharedFile);
    assert.equal(await service(a,entitySQL(f,f.target,'shared_fn')),f.ids.sharedFn);
    assert.equal(await service(a,edgeSQL(f,f.target,f.ids.sharedFile,f.ids.sharedFn)),f.ids.sharedEdge);
    for(const table of ['function_changes','tech_decisions','policy_updates','variable_changes','operational_references']){
      f.facts[table]=randomUUID();await service(a,`${factSQL(table,f,f.facts[table])};`);
    }
    f.ids.newDecision=randomUUID();
    await service(a,`UPDATE public.tech_decisions SET created_at='2026-01-01' WHERE id=${quote(f.facts.tech_decisions)};
      INSERT INTO public.tech_decisions(id,org_id,session_id,confidence,decision_text,domain,created_at) VALUES(${quote(f.ids.newDecision)},${quote(f.org)},${quote(f.target)},.9,'replacement fixture decision','private.ts','2026-02-01');
      SELECT public.review_tech_decision_supersession(${quote(f.org)},NULL,${quote(f.ids.newDecision)},${quote(f.facts.tech_decisions)},'fixture reviewer','reviewed transaction fixture replacement evidence');`);
    f.ids.survivorFact=randomUUID();
    await service(a,`INSERT INTO public.function_changes(id,org_id,session_id,confidence,old_name,change_type,file_path) VALUES(${quote(f.ids.survivorFact)},${quote(f.org)},${quote(f.survivor)},.9,'shared_fn','deprecated','shared.ts');`);
    f.ids.conflict=randomUUID(); f.ids.ownAudit=randomUUID();
    assert.equal(await service(a,`SELECT public.persist_audit_results(${quote(f.org)},${quote(f.survivor)},${quote(JSON.stringify([{id:f.ids.conflict,fact_table:'todos',fact_id:f.facts.todos,status:'CONFLICT',claimed_state:'fixture done',actual_state:'fixture pending',conflict_commit:'fixture'}]))}::jsonb);`),'1');
    await service(a,`INSERT INTO public.audit_conflicts(id,org_id,session_id,fact_table,fact_id,claimed_state,actual_state) VALUES(${quote(f.ids.ownAudit)},${quote(f.org)},${quote(f.target)},'function_changes',${quote(f.ids.survivorFact)},'fixture claim','fixture actual');`);
    const vectors=[['vectorFact',null,'fact',f.facts.function_changes],['vectorOther',f.survivor,'fact',f.facts.policy_updates],['vectorEntity',null,'entity',f.ids.privateFn],['vectorSurvivor',f.survivor,'entity',f.ids.sharedFile]];
    for(const [name,session,kind,ref] of vectors){f.ids[name]=randomUUID();await service(a,`INSERT INTO public.memory_vectors(id,org_id,session_id,source_type,source_ref,embedding) VALUES(${quote(f.ids[name])},${quote(f.org)},${quote(session)},${quote(kind)},${quote(ref)},${vector});`);}
    f.ids.prune=randomUUID();f.ids.usage=randomUUID();
    await service(a,`INSERT INTO public.pruning_logs(id,session_id,turns_total,turns_selected,turns_pruned,lambda_used,gain_shift_used,theta_used) VALUES(${quote(f.ids.prune)},${quote(f.target)},3,'{0,2}','{1}',.97,0,1);
      INSERT INTO public.billing_records(id,org_id,session_id,pruning_log_id,original_tokens,quarantined_tokens,api_price_per_token) VALUES(${quote(f.ids.usage)},${quote(f.org)},${quote(f.target)},${quote(f.ids.prune)},120,20,.00001);`);
  }
  await save();
  assert.equal(await service(a,`SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=${quote(f.org)};`),'t');
  assert.equal(JSON.parse(await service(a,`SELECT public.inspect_managed_session_erasure(${quote(f.org)},${quote(f.target)})::text;`)).status,'ready');
  return f;
}
async function digest(c,f){
  const fields=deletedKeys.filter((t)=>t!=='pruning_logs').map((t)=>`${quote(t)},(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM public.${t} r WHERE org_id=${quote(f.org)})`);
  fields.push(`'pruning_logs',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM public.pruning_logs p JOIN public.sessions s ON s.id=p.session_id WHERE s.org_id=${quote(f.org)})`);
  return hash(await service(c,`SELECT jsonb_build_object(${fields.join(',')})::text;`));
}
async function retainedDigest(c,f){
  const selections={
    entities:`SELECT * FROM public.knowledge_entities WHERE id IN(${quote(f.ids.sharedFile)},${quote(f.ids.sharedFn)})`,
    edges:`SELECT * FROM public.knowledge_edges WHERE id=${quote(f.ids.sharedEdge)}`,
    entityProvenance:`SELECT * FROM public.knowledge_entity_sessions WHERE entity_id IN(${quote(f.ids.sharedFile)},${quote(f.ids.sharedFn)}) AND session_id=${quote(f.survivor)}`,
    edgeProvenance:`SELECT * FROM public.knowledge_edge_sessions WHERE edge_id=${quote(f.ids.sharedEdge)} AND session_id=${quote(f.survivor)}`,
    facts:`SELECT * FROM public.function_changes WHERE id=${quote(f.ids.survivorFact)}`,
    links:`SELECT * FROM public.source_fact_links WHERE file_entity_id=${quote(f.ids.sharedFile)} AND function_change_id=${quote(f.ids.survivorFact)}`,
    vectors:`SELECT * FROM public.memory_vectors WHERE id=${quote(f.ids.vectorSurvivor)}`,
    session:`SELECT * FROM public.sessions WHERE id=${quote(f.survivor)}`,
  };
  const fields=Object.entries(selections).map(([key,select])=>`${quote(key)},(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM (${select}) r)`);
  return hash(await service(c,`SELECT jsonb_build_object(${fields.join(',')})::text;`));
}
async function prepare(c,f){
  const prepared=JSON.parse(await service(c,prepSQL(f)));
  assert.deepEqual(Object.keys(prepared).sort(),['status','scope','org_id','session_id','request_id'].sort());
  assert.equal(prepared.status,'prepared');assert.equal(prepared.scope,'managed_explicit_session_v1');
  assert.equal(prepared.org_id,f.org);assert.equal(prepared.session_id,f.target);uuid(prepared.request_id);
  if(f.prepared)assert.deepEqual(prepared,f.prepared);else{f.prepared=prepared;await save();}
  return prepared;
}
function receiptShape(r,f){
  assert.deepEqual(Object.keys(r).sort(),['status','scope','org_id','session_id','request_id','completed_at','deleted','retained','exclusions'].sort());
  assert.equal(r.status,'complete');assert.equal(r.scope,'managed_explicit_session_v1');
  assert.equal(r.org_id,f.org);assert.equal(r.session_id,f.target);assert.equal(r.request_id,f.prepared.request_id);
  assert.ok(Number.isFinite(Date.parse(r.completed_at)));assert.equal(r.deleted.sessions,1);
  assert.deepEqual(Object.keys(r.deleted).sort(),deletedKeys);assert.deepEqual(Object.keys(r.retained).sort(),retainedKeys);
  for(const value of [...Object.values(r.deleted),...Object.values(r.retained)])assert.ok(Number.isSafeInteger(value)&&value>=0);
  assert.deepEqual(r.exclusions,exclusions);
  if(f.receipt)assert.deepEqual(r,f.receipt);
  return r;
}
async function complete(c,f){const r=receiptShape(JSON.parse(await service(c,execSQL(f))),f);f.receipt=r;await save();return r;}
async function fenceState(c,f){
  const r=JSON.parse(await service(c,`SELECT jsonb_build_object('state',state,'request_id',request_id,'receipt',receipt,'facts',erased_fact_ids,'entities',erased_entity_ids)::text FROM public.session_erasure_state WHERE org_id=${quote(f.org)} AND session_id=${quote(f.target)};`));
  assert.deepEqual(r,{state:'erasing',request_id:f.prepared.request_id,receipt:null,facts:[],entities:[]});
}
async function absent(c,f){
  assert.equal(await service(c,`SELECT count(*) FROM public.sessions WHERE id=${quote(f.target)};`),'0');
  for(const table of ['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'])assert.equal(await service(c,`SELECT count(*) FROM public.${table} WHERE session_id=${quote(f.target)};`),'0');
  for(const table of ['billing_records','pruning_logs','knowledge_entity_sessions','knowledge_edge_sessions'])assert.equal(await service(c,`SELECT count(*) FROM public.${table} WHERE session_id=${quote(f.target)};`),'0');
  assert.equal(await service(c,`SELECT count(*) FROM public.knowledge_entities WHERE id=${quote(f.ids.privateFn)};`),'0');
  const captured={knowledge_entities:[f.ids.privateFile,f.ids.privateFn],knowledge_edges:[f.ids.privateEdge],memory_vectors:[f.ids.vectorFact,f.ids.vectorOther,f.ids.vectorEntity],audit_conflicts:[f.ids.conflict,f.ids.ownAudit]};
  for(const [table,possible] of Object.entries(captured)){
    const ids=possible.filter(Boolean);if(ids.length)assert.equal(await service(c,`SELECT count(*) FROM public.${table} WHERE id IN(${ids.map(quote).join(',')});`),'0');
  }
  const facts=[...Object.values(f.facts),f.ids.newDecision].filter(Boolean).map(quote).join(',');
  assert.equal(await service(c,`SELECT (SELECT count(*) FROM public.audit_statuses WHERE org_id=${quote(f.org)} AND fact_id IN(${facts}))+(SELECT count(*) FROM public.source_fact_links WHERE org_id=${quote(f.org)} AND (function_change_id IN(${facts}) OR tech_decision_id IN(${facts})));`),'0');
  const state=JSON.parse(await service(c,`SELECT jsonb_build_object('facts',erased_fact_ids,'entities',erased_entity_ids)::text FROM public.session_erasure_state WHERE session_id=${quote(f.target)};`));
  assert.deepEqual(state.facts.slice().sort(),[...Object.values(f.facts),f.ids.newDecision,...(f.extraFacts??[])].filter(Boolean).sort());
  assert.deepEqual(state.entities.slice().sort(),[f.ids.privateFn,f.ids.privateFile].filter(Boolean).sort());
}
async function replay(c,f){
  assert.deepEqual(JSON.parse(await service(c,prepSQL(f))),f.receipt);
  assert.deepEqual(JSON.parse(await service(c,execSQL(f))),f.receipt);
}
async function unknownOrg(){
  const f={label:'unknown resurrection control',org:uuid(await service(a,"INSERT INTO public.organizations(name) VALUES('C4B transaction unknown control') RETURNING id;")),facts:{},ids:{}};
  fixtures.push(f);await save();
  f.survivor=uuid(await service(a,`SELECT id FROM public.create_session_if_under_cap(${quote(f.org)},'unknown',2);`));
  await save();return f;
}
let succeeded=false;let originalError;
try{
  await mkdir(proofDir,{recursive:true});
  const migrationDir=resolve(root,'runtime/supabase/migrations');
  const names=(await readdir(migrationDir)).filter((n)=>/^\d+_[\w-]+\.sql$/.test(n)&&n<='20261003050000_managed_session_erasure.sql').sort();
  assert.equal(names.length,69);
  journal.sourceBindings={driver:hash(await readFile(ownPath)),migrations:{}};
  for(const name of names)journal.sourceBindings.migrations[name]=hash(await readFile(resolve(migrationDir,name)));
  journal.sourceBindings.substantiveFixture=hash(await readFile(resolve(root,'runtime/test/integration/local-erasure-execution.sql')));
  await save(); // Source binding is durable before any database mutation/activation.
  a=await open('a');b=await open('b');
  assert.deepEqual(JSON.parse(await operator(a,'SELECT jsonb_agg(version ORDER BY version)::text FROM devops_local.migrations;')),names);
  originalDeployment=JSON.parse(await operator(a,'SELECT to_jsonb(d)::text FROM public.erasure_deployment d WHERE id;'));
  assert.equal(originalDeployment.enabled,false);assert.equal(originalDeployment.source_generation,'managed_explicit_session_v1');
  journal.originalDeployment=originalDeployment;journal.status='activation-prepared';await save();
  activated=true; // A lost UPDATE response must still attempt scoped disable.
  const activation=await operator(a,`UPDATE public.erasure_deployment SET enabled=true,activation_id=${quote(activationId)},activated_at=clock_timestamp() WHERE id AND NOT enabled AND to_jsonb(erasure_deployment)=${quote(JSON.stringify(originalDeployment))}::jsonb RETURNING activation_id;`);
  assert.equal(activation,activationId);journal.status='running';await save();

  const full=await fixture('durable lifecycle',true);
  full.beforeDigest=await digest(b,full);full.survivorDigest=await retainedDigest(b,full);await save();
  await prepare(a,full);await close(a);a=await open('a-reconnected');
  await fenceState(b,full);assert.equal(await digest(b,full),full.beforeDigest);await prepare(a,full);
  assert.equal(await b.try(`${todoSQL(full)};`),'55000');
  assert.equal(await service(b,`SELECT pg_temp.guard_try(${quote(`SELECT public.mark_erasure_coverage_unknown('${full.org}','protected_read')`)});`),'55000');
  journal.injection={triggerName,table:'billing_records',org:full.org,usage:full.ids.usage};injection=true;await save();
  await operator(a,`CREATE FUNCTION pg_temp.tx_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'transaction fixture usage failure'; END $$;
    DO $$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO devops_erasure_executor',(SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema())); END $$;
    GRANT EXECUTE ON FUNCTION pg_temp.tx_inject_failure() TO devops_erasure_executor;
    CREATE TRIGGER ${triggerName} BEFORE DELETE ON public.billing_records FOR EACH ROW WHEN(OLD.id=${quote(full.ids.usage)}::uuid) EXECUTE FUNCTION pg_temp.tx_inject_failure();`);
  assert.equal(await service(b,`SELECT pg_temp.guard_try(${quote(execSQL(full))});`),'P0001');
  assert.equal(await digest(b,full),full.beforeDigest);await fenceState(a,full);
  await operator(a,`DROP TRIGGER ${triggerName} ON public.billing_records;`);injection=false;
  await complete(b,full);await absent(a,full);assert.equal(await retainedDigest(a,full),full.survivorDigest);
  const expectedDeleted={sessions:1,billing_records:1,pruning_logs:1,function_changes:1,tech_decisions:2,policy_updates:1,todos:1,variable_changes:1,operational_references:1,audit_conflicts:2,audit_statuses:1,knowledge_entities:2,knowledge_edges:1,knowledge_entity_sessions:4,knowledge_edge_sessions:2,source_fact_links:3,memory_vectors:3};
  assert.deepEqual(full.receipt.deleted,expectedDeleted);
  assert.deepEqual(full.receipt.retained,{knowledge_entities:2,knowledge_edges:1,knowledge_entity_sessions:2,knowledge_edge_sessions:1,source_fact_links:1,memory_vectors:1,erasure_deployment:1,erasure_org_coverage:1,session_erasure_state:1,erased_fact_ids:7,erased_entity_ids:2});
  assert.equal(await service(a,`SELECT (SELECT count(*) FROM public.knowledge_entities WHERE id IN(${quote(full.ids.sharedFile)},${quote(full.ids.sharedFn)}) AND provenance_complete AND session_id=${quote(full.survivor)})=2 AND EXISTS(SELECT 1 FROM public.knowledge_edges WHERE id=${quote(full.ids.sharedEdge)} AND provenance_complete AND session_id=${quote(full.survivor)}) AND EXISTS(SELECT 1 FROM public.memory_vectors WHERE id=${quote(full.ids.vectorSurvivor)}) AND EXISTS(SELECT 1 FROM public.function_changes WHERE id=${quote(full.ids.survivorFact)});`),'t');
  await close(b);b=await open('b-reconnected');await replay(b,full);
  const unknown=await unknownOrg();
  assert.equal(await service(b,`SELECT public.prepare_session_erasure(${quote(unknown.org)},${quote(full.target)}) IS NULL;`),'t');
  await record('committed-prepare-failure-reconnect-replay',{fixture:full.org,rollbackDigest:full.beforeDigest,receipt:full.receipt,foreignScopeNull:true});

  const writerFirst=await fixture('writer first');const lateId=randomUUID();writerFirst.extraFacts=[lateId];await save();
  await service(b,`BEGIN;${todoSQL(writerFirst,lateId)};`);
  const waitingPrepare=service(a,`BEGIN;${prepSQL(writerFirst)}`);
  await b.barrier(a);await b.run('COMMIT;');
  writerFirst.prepared=JSON.parse(await waitingPrepare);assert.equal(writerFirst.prepared.status,'prepared');await a.run('COMMIT;');await save();
  await complete(a,writerFirst);await absent(b,writerFirst);assert.equal(writerFirst.receipt.deleted.todos,2);
  assert.equal(await service(b,`SELECT count(*) FROM public.todos WHERE id=${quote(lateId)};`),'0');
  await record('real-writer-first',{fixture:writerFirst.org,waited:true,deletedTodos:2});

  const fenceFirst=await fixture('prepare first');
  await service(a,'BEGIN;');await prepare(a,fenceFirst);
  const rejected=b.try(`${todoSQL(fenceFirst)};`);await a.barrier(b);await a.run('COMMIT;');assert.equal(await rejected,'55000');
  await fenceState(b,fenceFirst);await complete(a,fenceFirst);assert.equal(fenceFirst.receipt.deleted.todos,1);
  await record('real-prepare-first',{fixture:fenceFirst.org,waited:true,writerState:'55000'});

  const concurrent=await fixture('concurrent execute');await prepare(a,concurrent);
  await service(a,'BEGIN;');const firstReceipt=await complete(a,concurrent);
  const secondExecution=service(b,execSQL(concurrent));await a.barrier(b);await a.run('COMMIT;');
  assert.deepEqual(receiptShape(JSON.parse(await secondExecution),concurrent),firstReceipt);await absent(b,concurrent);await replay(b,concurrent);
  await record('concurrent-real-execute',{fixture:concurrent.org,waited:true,receipt:firstReceipt});

  for(const kind of ['fact','entity']){
    const f=await fixture(`${kind} retirement`);await prepare(a,f);await service(a,'BEGIN;');await complete(a,f);
    const id=kind==='fact'?f.facts.todos:f.ids.privateFn;
    const alias=`{${id.toUpperCase()}}`;
    const write=service(b,`SELECT pg_temp.guard_try(${quote(`INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES('${unknown.org}','${kind}','${alias}',${vector})`)});`);
    await a.barrier(b);await a.run('COMMIT;');assert.equal(await write,'55000');
    const reuse=kind==='fact'?factSQL('function_changes',{org:unknown.org,target:unknown.survivor},id):`INSERT INTO public.knowledge_entities(id,org_id,session_id,kind,name) VALUES('${id}','${unknown.org}','${unknown.survivor}','Function','unsafe retired reuse')`;
    assert.equal(await b.try(reuse),'55000');
    assert.equal(await b.try(`INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES('${unknown.org}','turn','${alias}',${vector})`),'55000');
    await absent(a,f);await replay(b,f);await record(`actual-${kind}-retirement`,{fixture:f.org,waited:true,crossOrgWriterState:'55000',reuseState:'55000'});
    const creation=await fixture(`${kind} identity creation race`);await prepare(a,creation);await service(a,'BEGIN;');await complete(a,creation);
    const createdId=kind==='fact'?creation.facts.todos:creation.ids.privateFn;
    const insert=kind==='fact'?factSQL('function_changes',{org:unknown.org,target:unknown.survivor},createdId):`INSERT INTO public.knowledge_entities(id,org_id,session_id,kind,name) VALUES('${createdId}','${unknown.org}','${unknown.survivor}','Function','unsafe concurrent reuse')`;
    const recreating=service(b,`SELECT pg_temp.guard_try(${quote(insert)});`);
    await a.barrier(b);await a.run('COMMIT;');assert.equal(await recreating,'55000');
    await absent(a,creation);await replay(b,creation);await record(`actual-${kind}-creation-race`,{fixture:creation.org,waited:true,differentOrg:true,writerState:'55000'});
  }
  await service(b,`INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(${quote(unknown.org)},'fact',${quote(randomUUID())},${vector});`);

  const shared=await fixture('shared graph reuse',true);await prepare(a,shared);
  assert.equal(await service(b,`SELECT pg_temp.guard_try(${quote(entitySQL(shared,shared.survivor,'shared.ts','File'))});`),'55000');
  await service(a,'BEGIN;');await complete(a,shared);
  const reuseShared=service(b,entitySQL(shared,shared.survivor,'shared.ts','File'));await a.barrier(b);await a.run('COMMIT;');
  assert.equal(await reuseShared,shared.ids.sharedFile);
  assert.equal(await service(b,edgeSQL(shared,shared.survivor,shared.ids.sharedFile,shared.ids.sharedFn)),shared.ids.sharedEdge);
  const next=uuid(await service(b,`SELECT id FROM public.create_session_if_under_cap(${quote(shared.org)},'reuse-new',10);`));
  assert.equal(await service(b,entitySQL(shared,next,'shared.ts','File')),shared.ids.sharedFile);
  assert.equal(await service(b,`SELECT (SELECT provenance_complete FROM public.knowledge_entities WHERE id=${quote(shared.ids.sharedFile)}) AND (SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=${quote(shared.org)}) AND NOT EXISTS(SELECT 1 FROM public.session_erasure_state WHERE session_id=${quote(shared.target)} AND erased_entity_ids @> ARRAY[${quote(shared.ids.sharedFile)}::uuid]);`),'t');
  await record('real-shared-reuse',{fixture:shared.org,waited:true,sameEntity:true,sameEdge:true,newSession:next});

  const dead=await fixture('executor inversion');const beforeDead=await digest(b,dead);await prepare(a,dead);
  await service(a,`BEGIN;SELECT public.lock_erasure_org(${quote(dead.org)});`);
  const updating=service(b,`SELECT pg_temp.guard_try(${quote(`UPDATE public.todos SET description='unsafe inversion' WHERE id='${dead.facts.todos}'`)});`);
  await a.barrier(b);
  const executing=a.try(execSQL(dead));
  const executorState=await executing;let states;
  if(executorState==='40P01'){
    await a.run('ROLLBACK;');states=[executorState,await updating];assert.equal(states[1],'55000');
    await fenceState(b,dead);assert.equal(await digest(b,dead),beforeDead);
    journal.deadlockAttempt={fixture:dead.org,states,executorTransaction:'rolled_back',baselineDigest:beforeDead};await save();
    await complete(a,dead);
  }else{
    assert.equal(executorState,'00000');await a.run('COMMIT;');states=[executorState,await updating];assert.equal(states[1],'40P01');
    journal.deadlockAttempt={fixture:dead.org,states,executorTransaction:'committed'};await save();
    dead.receipt=receiptShape(JSON.parse(await service(b,`SELECT receipt::text FROM public.session_erasure_state WHERE session_id=${quote(dead.target)};`)),dead);await save();
  }
  await absent(b,dead);await replay(b,dead);await record('actual-executor-inversion',{fixture:dead.org,states,complete:true});

  for(const isolation of ['REPEATABLE READ','SERIALIZABLE','READ COMMITTED']){
    const f=await fixture(`snapshot ${isolation}`);
    await service(b,`BEGIN ISOLATION LEVEL ${isolation};SELECT count(*) FROM public.todos WHERE org_id=${quote(f.org)};`);
    await prepare(a,f);await complete(a,f);
    const stale=b.try(`INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES('${unknown.org}','fact','${f.facts.todos}',${vector})`);
    assert.equal(await stale,isolation==='READ COMMITTED'?'55000':'0A000');await b.run('ROLLBACK;');await replay(b,f);
    await record(`actual-snapshot-${isolation}`,{fixture:f.org,writerState:isolation==='READ COMMITTED'?'55000':'0A000'});
  }

  // AC-B5 includes actual copy-marker and enrollment races, not just content
  // writers. Every case starts with a fresh normally minted organization.
  const markerFirst=await fixture('marker before prepare');const markerDigest=await digest(b,markerFirst);
  await service(a,`BEGIN;SELECT public.mark_erasure_coverage_unknown(${quote(markerFirst.org)},'protected_read');`);
  const blockedPrepare=service(b,prepSQL(markerFirst));await a.barrier(b);await a.run('COMMIT;');
  const blocked=JSON.parse(await blockedPrepare);assert.equal(blocked.status,'blocked');assert.equal(blocked.scope,'managed_explicit_session_v1');
  assert.equal(blocked.org_id,markerFirst.org);assert.equal(blocked.session_id,markerFirst.target);assert.ok(blocked.reasons.includes('coverage_unknown'));
  assert.equal(await service(b,`SELECT state='active' AND request_id IS NULL AND receipt IS NULL FROM public.session_erasure_state WHERE session_id=${quote(markerFirst.target)};`),'t');
  assert.equal(await digest(b,markerFirst),markerDigest);
  assert.equal(await service(b,`SELECT unknown_at IS NOT NULL AND unknown_reason='protected_read' FROM public.erasure_org_coverage WHERE org_id=${quote(markerFirst.org)};`),'t');
  await record('marker-first-prepare-blocked',{fixture:markerFirst.org,waited:true,blocked,contentDigest:markerDigest});

  const preparedMarker=await fixture('prepare before marker');await service(a,'BEGIN;');await prepare(a,preparedMarker);
  const deniedMarker=service(b,`SELECT pg_temp.guard_try(${quote(`SELECT public.mark_erasure_coverage_unknown('${preparedMarker.org}','protected_read')`)});`);
  await a.barrier(b);await a.run('COMMIT;');assert.equal(await deniedMarker,'55000');await fenceState(b,preparedMarker);
  assert.equal(await service(b,`SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=${quote(preparedMarker.org)};`),'t');
  await complete(a,preparedMarker);await absent(b,preparedMarker);
  await record('prepare-first-marker-denied',{fixture:preparedMarker.org,waited:true,markerState:'55000'});

  const capSQL=(f,project,limit)=>`SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb)::text FROM public.${project?'create_project_session_if_under_cap':'create_session_if_under_cap'}(${quote(f.org)},'race-enrollment',${limit}${project?`,${quote(project)}`:''}) s;`;
  const enrollmentFirst=await fixture('enrollment before marker');await service(a,'BEGIN;');
  const enrolled=JSON.parse(await service(a,capSQL(enrollmentFirst,'orion',3)));assert.equal(enrolled.length,1);enrollmentFirst.extraSessions=[uuid(enrolled[0].id)];await save();
  const afterEnrollment=service(b,`SELECT public.mark_erasure_coverage_unknown(${quote(enrollmentFirst.org)},'protected_read');`);
  await a.barrier(b);await a.run('COMMIT;');assert.equal(await afterEnrollment,'t');
  assert.equal(enrolled[0].kind,'explicit');assert.equal(enrolled[0].project_scope,'orion');
  assert.equal(await service(b,`SELECT EXISTS(SELECT 1 FROM public.session_erasure_state WHERE session_id=${quote(enrolled[0].id)} AND state='active') AND (SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id=${quote(enrollmentFirst.org)});`),'t');
  assert.equal(JSON.parse(await service(b,`SELECT public.inspect_managed_session_erasure(${quote(enrollmentFirst.org)},${quote(enrolled[0].id)})::text;`)).status,'blocked');
  const later=JSON.parse(await service(b,capSQL(enrollmentFirst,null,4)));assert.equal(later.length,1);enrollmentFirst.extraSessions.push(uuid(later[0].id));await save();
  assert.equal(await service(b,`SELECT NOT EXISTS(SELECT 1 FROM public.session_erasure_state WHERE session_id=${quote(later[0].id)});`),'t');
  await record('enrollment-first-marker',{fixture:enrollmentFirst.org,waited:true,oldEnrollmentRetainedButCoverageUnknown:true,futureUnenrolled:true});

  const markingFirst=await fixture('marker before enrollment');await service(a,`BEGIN;SELECT public.mark_erasure_coverage_unknown(${quote(markingFirst.org)},'protected_read');`);
  const afterMarker=service(b,capSQL(markingFirst,'orion',3));await a.barrier(b);await a.run('COMMIT;');
  const ordinary=JSON.parse(await afterMarker);assert.equal(ordinary.length,1);markingFirst.extraSessions=[uuid(ordinary[0].id)];await save();
  assert.equal(ordinary[0].kind,'explicit');assert.equal(ordinary[0].project_scope,'orion');
  assert.equal(await service(b,`SELECT NOT EXISTS(SELECT 1 FROM public.session_erasure_state WHERE session_id=${quote(ordinary[0].id)}) AND (SELECT unknown_at IS NOT NULL AND unknown_reason='protected_read' FROM public.erasure_org_coverage WHERE org_id=${quote(markingFirst.org)});`),'t');
  await record('marker-first-enrollment',{fixture:markingFirst.org,waited:true,ordinarySession:ordinary[0].id,noNewEnrollment:true,project:'orion'});

  // Both constructor variants contend for the final slot in opposite orders.
  for(const projectWinner of [false,true]){
    const f=await fixture(projectWinner?'project cap wins':'normal cap wins');await service(a,'BEGIN;');
    const winner=JSON.parse(await service(a,capSQL(f,projectWinner?'orion':null,3)));assert.equal(winner.length,1);f.extraSessions=[uuid(winner[0].id)];await save();
    const loser=service(b,capSQL(f,projectWinner?null:'orion',3));await a.barrier(b);await a.run('COMMIT;');assert.deepEqual(JSON.parse(await loser),[]);
    assert.equal(winner[0].kind,'explicit');assert.equal(winner[0].project_scope,projectWinner?'orion':null);
    assert.equal(await service(b,`SELECT (SELECT count(*) FROM public.sessions WHERE org_id=${quote(f.org)} AND kind='explicit' AND ended_at IS NULL)=3 AND (SELECT count(*) FROM public.session_erasure_state WHERE org_id=${quote(f.org)} AND state='active')=3 AND (SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=${quote(f.org)});`),'t');
    await record(projectWinner?'project-cap-last-slot':'normal-cap-last-slot',{fixture:f.org,waited:true,winner:winner[0].id,project:winner[0].project_scope,loserRows:0,activeCount:3,enrollmentCount:3});
  }

  assert.equal(await service(b,`SELECT public.mark_erasure_coverage_unknown(${quote(full.org)},'protected_read');`),'t');
  assert.equal(await b.try(`INSERT INTO public.sessions(id,org_id,model) VALUES('${full.target}','${unknown.org}','unsafe resurrection')`),'55000');
  for(const table of ['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'])assert.equal(await b.try(factSQL(table,{org:unknown.org,target:unknown.survivor},full.facts.function_changes)),'55000');
  assert.equal(await b.try(`INSERT INTO public.knowledge_entities(id,org_id,session_id,kind,name) VALUES('${full.ids.privateFn}','${unknown.org}','${unknown.survivor}','Function','unsafe resurrection')`),'55000');
  for(const ref of [full.facts.function_changes.toUpperCase(),`{${full.facts.function_changes}}`,full.facts.function_changes.replaceAll('-','')])assert.equal(await b.try(`INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES('${unknown.org}','fact','${ref}',${vector})`),'55000');
  await replay(b,full);await record('unknown-after-actual-completion',{fixture:full.org,receiptUnchanged:true,allFactKindsReject:true});

  // Privileged teardown only after real completion/replay evidence. This is not a
  // product reset or receipt-removal API; every row is scoped to recorded fixtures.
  const orgs=fixtures.map((f)=>quote(f.org)).join(',');
  await operator(a,`BEGIN;
    DELETE FROM public.session_erasure_state WHERE org_id IN(${orgs});
    DELETE FROM public.memory_vectors WHERE org_id IN(${orgs});
    DELETE FROM public.audit_statuses WHERE org_id IN(${orgs});
    DELETE FROM public.audit_conflicts WHERE org_id IN(${orgs});
    DELETE FROM public.source_fact_links WHERE org_id IN(${orgs});
    DELETE FROM public.knowledge_edge_sessions WHERE org_id IN(${orgs});
    DELETE FROM public.knowledge_entity_sessions WHERE org_id IN(${orgs});
    DELETE FROM public.knowledge_edges WHERE org_id IN(${orgs});
    DELETE FROM public.knowledge_entities WHERE org_id IN(${orgs});
    DELETE FROM public.billing_records WHERE org_id IN(${orgs});
    DELETE FROM public.pruning_logs WHERE session_id IN(SELECT id FROM public.sessions WHERE org_id IN(${orgs}));
    DELETE FROM public.function_changes WHERE org_id IN(${orgs});
    DELETE FROM public.tech_decisions WHERE org_id IN(${orgs});
    DELETE FROM public.policy_updates WHERE org_id IN(${orgs});
    DELETE FROM public.todos WHERE org_id IN(${orgs});
    DELETE FROM public.variable_changes WHERE org_id IN(${orgs});
    DELETE FROM public.operational_references WHERE org_id IN(${orgs});
    DELETE FROM public.sessions WHERE org_id IN(${orgs});
    DELETE FROM public.organizations WHERE id IN(${orgs});
    DELETE FROM public.erasure_org_coverage WHERE org_id IN(${orgs});
    COMMIT;`);
  assert.equal(await operator(a,`SELECT (SELECT count(*) FROM public.organizations WHERE id IN(${orgs}))+(SELECT count(*) FROM public.session_erasure_state WHERE org_id IN(${orgs}))+(SELECT count(*) FROM public.erasure_org_coverage WHERE org_id IN(${orgs}));`),'0');
  journal.cleanup='all own fixture content and positive receipts removed after proof';succeeded=true;
}catch(error){originalError=error;journal.status='failed';journal.error=error instanceof Error?error.message:String(error);journal.cleanup='committed fixtures/fences/receipts retained for diagnosis';await save();}
finally{
  // Release every owned transaction before taking the deployment UPDATE lock.
  const closures=await Promise.allSettled(allConnections.map(close));
  for(const result of closures)if(result.status==='rejected'){originalError??=result.reason;succeeded=false;}
  if(activated){
    let cleanup;
    try{
      cleanup=await open('operator-finally');
      if(injection)await operator(cleanup,`DROP TRIGGER IF EXISTS ${triggerName} ON public.billing_records;`);
      const disabled=await operator(cleanup,`UPDATE public.erasure_deployment SET enabled=false WHERE id AND activation_id=${quote(activationId)} RETURNING activation_id;`);
      assert.equal(disabled,activationId,'activation changed externally; refusing to overwrite another generation');
      if(succeeded)await operator(cleanup,`UPDATE public.erasure_deployment SET source_generation=${quote(originalDeployment.source_generation)},activation_id=${quote(originalDeployment.activation_id)},activated_at=${quote(originalDeployment.activated_at)},enabled=false WHERE id AND activation_id=${quote(activationId)};`);
      assert.equal(await operator(cleanup,'SELECT NOT enabled FROM public.erasure_deployment WHERE id;'),'t');
      if(succeeded)assert.deepEqual(JSON.parse(await operator(cleanup,'SELECT to_jsonb(d)::text FROM public.erasure_deployment d WHERE id;')),originalDeployment);
      assert.equal(await operator(cleanup,`SELECT count(*) FROM pg_trigger WHERE tgrelid='public.billing_records'::regclass AND tgname=${quote(triggerName)};`),'0');
      journal.activationCleanup=succeeded?'original disabled row restored exactly':'owned test activation disabled; failure binding retained';
    }catch(error){journal.activationCleanupError=error instanceof Error?error.message:String(error);originalError??=error;succeeded=false;}
    finally{
      const cleanupClosures=await Promise.allSettled(allConnections.map(close));
      for(const result of cleanupClosures)if(result.status==='rejected'){originalError??=result.reason;succeeded=false;}
    }
  }
  if(journal.connections.some((c)=>c.exit?.code!==0)){originalError??=new Error('owned psql connection did not exit cleanly');succeeded=false;}
  journal.status=succeeded?'passed':'failed';await save();
}
if(originalError){console.error(`Transaction proof failed; retained evidence ${journalPath}`);throw originalError;}
console.log(`Actual committed erasure transaction proof passed; evidence ${journalPath}`);
