/** Apply the source-fact migration over pre-existing rows in a disposable local database. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd(), "..");
if (resolve(process.cwd()) !== join(root, "stratum")) throw new Error("run from stratum/");
const database = `devops_link_backfill_${randomUUID().replaceAll("-", "")}`;
const dockerEnv = { ...process.env, DEVOPS_LOCAL_JWT_SECRET: "placeholder" };

function sql(target: string, statement: string): string {
  return execFileSync(
    "docker",
    [
      "compose",
      "-f",
      "supabase/docker-compose.local.yml",
      "-p",
      "devops-stratum-compose",
      "exec",
      "-T",
      "db",
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      target,
      "-At",
      "-f",
      "-",
    ],
    { cwd: process.cwd(), env: dockerEnv, input: statement, encoding: "utf8" },
  );
}

let failure: unknown;
try {
  sql("postgres", `CREATE DATABASE ${database};`);
  sql(
    database,
    `
    CREATE TABLE public.organizations(id uuid PRIMARY KEY);
    CREATE TABLE public.knowledge_entities(id uuid PRIMARY KEY, org_id uuid NOT NULL, kind text NOT NULL, name text NOT NULL, file_path text);
    ALTER TABLE public.knowledge_entities ADD CONSTRAINT knowledge_entities_org_id_id_key UNIQUE (org_id,id);
    CREATE TABLE public.function_changes(id uuid PRIMARY KEY, org_id uuid NOT NULL, is_suppressed boolean NOT NULL,
      file_path text, old_name text NOT NULL, new_name text, change_type text NOT NULL, created_at timestamptz NOT NULL);
    CREATE TABLE public.tech_decisions(id uuid PRIMARY KEY, org_id uuid NOT NULL, is_suppressed boolean NOT NULL,
      domain text NOT NULL, decision_text text NOT NULL, created_at timestamptz NOT NULL);
    ALTER TABLE public.tech_decisions ADD CONSTRAINT tech_decisions_org_id_id_key UNIQUE (org_id,id);
    INSERT INTO public.organizations VALUES ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
    INSERT INTO public.knowledge_entities VALUES
      ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','File','src/auth.ts','src/auth.ts'),
      ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000002','File','src/auth.ts','src/auth.ts');
    INSERT INTO public.function_changes VALUES
      ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001',false,'src/auth.ts','active',null,'deprecated',now()),
      ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000001',true,'src/auth.ts','suppressed',null,'deprecated',now()),
      ('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000002',false,'src/auth.ts','foreign',null,'deprecated',now());
    INSERT INTO public.tech_decisions VALUES
      ('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000001',false,'src/auth.ts','exact',now()),
      ('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000001',false,'auth','generic',now());
  `,
  );
  sql(database, readFileSync("supabase/migrations/20260923080000_source_fact_links.sql", "utf8"));
  sql(database, readFileSync("supabase/migrations/20260923090000_source_fact_link_validation.sql", "utf8"));
  sql(database, readFileSync("supabase/migrations/20260923100000_source_fact_link_indexes.sql", "utf8"));
  const rows = sql(
    database,
    `SELECT org_id::text || ':' || COALESCE(function_change_id,tech_decision_id)::text
    FROM public.source_fact_links ORDER BY org_id, COALESCE(function_change_id,tech_decision_id);`,
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const expected = [
    "00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000021",
    "00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000031",
    "00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000023",
  ];
  if (rows.join(",") !== expected.join(",")) throw new Error(`migration backfill mismatch: ${rows.join(",")}`);
  const privileges = sql(
    database,
    `SELECT has_table_privilege('anon','public.source_fact_links','SELECT'),
    has_table_privilege('authenticated','public.source_fact_links','SELECT'),
    has_table_privilege('anon','public.source_fact_links','INSERT'),
    has_table_privilege('authenticated','public.source_fact_links','INSERT'),
    has_table_privilege('service_role','public.source_fact_links','SELECT'),
    has_table_privilege('service_role','public.source_fact_links','INSERT'),
    has_function_privilege('anon','public.list_source_related_facts(uuid,uuid,integer)','EXECUTE'),
    has_function_privilege('service_role','public.list_source_related_facts(uuid,uuid,integer)','EXECUTE'),
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.source_fact_links'::regclass);`,
  ).trim();
  if (privileges !== "f|f|f|f|t|t|f|t|t") throw new Error(`unexpected source-link privileges: ${privileges}`);
  process.stdout.write("source-fact migration backfilled only active exact-path rows across two organizations\n");
} catch (error) {
  failure = error;
} finally {
  try {
    sql("postgres", `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
