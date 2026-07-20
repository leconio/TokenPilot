import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AUTHORITY_TABLES,
  authorityDigest,
  buildCopyQuery,
  psqlEnvironment,
  writePrivateJson,
} from "../remote/postgresql-authority-fingerprint.mjs";
import {
  compareAuthorityFingerprints,
  validateAuthorityFingerprint,
} from "../remote/compare-postgresql-authority-fingerprints.mjs";

const execFileAsync = promisify(execFile);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(capturedAt = "2026-07-16T00:00:00.000Z") {
  const document = {
    schema_version: "current",
    fingerprint_version: 1,
    captured_at: capturedAt,
    table_count: AUTHORITY_TABLES.length,
    tables: Object.fromEntries(
      AUTHORITY_TABLES.map((table) => [
        table,
        {
          row_count: "0",
          watermark: null,
          schema_sha256: hash(`schema:${table}`),
          rows_sha256: hash(`rows:${table}`),
        },
      ]),
    ),
  };
  return { ...document, authority_sha256: authorityDigest(document) };
}

test("fingerprint covers the complete current application authority", () => {
  for (const table of [
    "applications",
    "application_users",
    "application_usage_ratings",
    "model_definitions",
    "model_cost_versions",
    "model_aiu_versions",
    "user_aiu_quotas",
    "user_aiu_ledger_entries",
    "user_aiu_reservations",
    "virtual_models",
    "runtime_configuration_versions",
    "runtime_configuration_acknowledgements",
    "usage_event_registry",
    "ingestion_inbox",
    "pipeline_outbox",
    "reconciliation_runs",
    "reconciliation_diffs",
    "audit_logs",
  ]) {
    assert.ok(AUTHORITY_TABLES.includes(table), `${table} must be fingerprinted`);
  }
  assert.equal(AUTHORITY_TABLES.length, 44);
  assert.deepEqual(AUTHORITY_TABLES, [...new Set(AUTHORITY_TABLES)].sort());
});

test("COPY fingerprint is ordered by the primary key inside an imported snapshot", () => {
  const query = buildCopyQuery(
    "application_usage_ratings",
    ["application_id", "event_id"],
    "00000003-0000001B-1",
  );
  assert.match(query, /SET TRANSACTION SNAPSHOT '00000003-0000001B-1'/u);
  assert.match(
    query,
    /ORDER BY convert_to\("application_id"::text, 'UTF8'\), convert_to\("event_id"::text, 'UTF8'\)/u,
  );
  assert.match(query, /SELECT to_jsonb\(ordered_row\)::text/u);
  assert.throws(() => buildCopyQuery("audit_logs", [], "00000003-0000001B-1"), /primary key/u);
});

test("psql receives parsed connection fields only through its private child environment", () => {
  const databaseUrl = "postgresql://user:secret@postgres:5432/ai_control";
  const environment = psqlEnvironment(databaseUrl, {
    PGHOST: "wrong-host",
    PGPORT: "1",
    PGUSER: "wrong-user",
    PGPASSWORD: "wrong-password",
  });
  assert.equal(environment.PGHOST, "postgres");
  assert.equal(environment.PGPORT, "5432");
  assert.equal(environment.PGUSER, "user");
  assert.equal(environment.PGPASSWORD, "secret");
  assert.equal(environment.PGDATABASE, "ai_control");
  assert.equal(environment.PGSERVICE, undefined);
  assert.match(environment.PGOPTIONS, /timezone=UTC/u);
});

test("comparison ignores capture time but rejects any authority change or tampering", () => {
  const before = fingerprint();
  const after = fingerprint("2026-07-16T00:01:00.000Z");
  assert.deepEqual(compareAuthorityFingerprints(before, after), {
    authority_sha256: before.authority_sha256,
    table_count: AUTHORITY_TABLES.length,
  });

  const changed = structuredClone(after);
  changed.tables.user_aiu_reservations.row_count = "1";
  changed.authority_sha256 = authorityDigest(changed);
  assert.throws(() => compareAuthorityFingerprints(before, changed), /user_aiu_reservations/u);

  const tampered = structuredClone(before);
  tampered.tables.audit_logs.rows_sha256 = hash("tampered");
  assert.throws(() => validateAuthorityFingerprint(tampered), /digest/u);

  const leaked = structuredClone(before);
  leaked.tables.audit_logs.rows = [{ secret: "must-not-be-recorded" }];
  leaked.authority_sha256 = authorityDigest(leaked);
  assert.throws(() => validateAuthorityFingerprint(leaked), /audit_logs/u);
});

test("private fingerprint evidence is mode 0600 and cannot overwrite an existing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "authority-fingerprint-"));
  const output = join(directory, "fingerprint.json");
  try {
    await writePrivateJson(output, fingerprint());
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateJson(output, fingerprint()), { code: "EEXIST" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("fresh current backup drill fingerprints restore and proves migrate and seed idempotency", async () => {
  const source = await readFile(
    new URL("../remote/backup-restore-in-container.sh", import.meta.url),
    "utf8",
  );
  for (const evidence of [
    "source-before.json",
    "restore-current.json",
    "after-migrate-first.json",
    "after-migrate-second.json",
    "after-seed-first.json",
    "after-seed-second.json",
    "final-authority-comparison.txt",
  ]) {
    assert.match(source, new RegExp(evidence.replaceAll(".", "\\."), "u"));
  }
  assert.equal(source.match(/db:migrate/gu)?.length, 2);
  assert.equal(source.match(/db:seed/gu)?.length, 2);
  assert.equal(source.match(/No pending migrations/gu)?.length, 2);
  assert.match(source, /ACCEPTANCE_BACKUP_EVIDENCE/u);
  assert.match(source, /database_host" == postgres/u);
  assert.doesNotMatch(source, /production|controlled|transition/iu);
  assert.match(
    source,
    /compare "\$evidence\/after-migrate-first\.json" "\$evidence\/after-seed-first\.json"/u,
  );
});

test("PostgreSQL backup lifecycle uses only the current authority manifest", async () => {
  const entries = await Promise.all(
    ["backup-postgres.sh", "verify-backup.sh", "restore-postgres.sh"].map(async (file) => [
      file,
      await readFile(new URL(`../../${file}`, import.meta.url), "utf8"),
    ]),
  );
  const scripts = Object.fromEntries(entries);
  assert.match(scripts["backup-postgres.sh"], /postgresql-authority\.json/u);
  assert.match(scripts["backup-postgres.sh"], /postgresql_authority_sha256/u);
  assert.match(scripts["backup-postgres.sh"], /compare-postgresql-authority-fingerprints/u);
  assert.match(scripts["verify-backup.sh"], /--validate/u);
  assert.match(scripts["restore-postgres.sh"], /postgresql-authority\.json/u);
  assert.match(scripts["restore-postgres.sh"], /compare_script/u);
});

test("shell backup verifier accepts a current manifest and rejects hidden row data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "authority-backup-"));
  const backup = join(directory, "tokenpilot-current");
  const binaryDirectory = join(directory, "bin");
  const verifier = fileURLToPath(new URL("../../verify-backup.sh", import.meta.url));
  const authorityPath = join(backup, "postgresql-authority.json");
  const manifestPath = join(backup, "manifest.json");
  const authority = fingerprint();
  const dump = "custom-format-test-placeholder\n";
  const writeFixture = async (document) => {
    const authorityText = `${JSON.stringify(document, null, 2)}\n`;
    const authoritySha = hash(authorityText);
    await writeFile(authorityPath, authorityText, { mode: 0o600 });
    await writeFile(
      join(backup, "postgresql-authority.json.sha256"),
      `${authoritySha}  postgresql-authority.json\n`,
      { mode: 0o600 },
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schema_version: "2.0",
        database_name: "ai_control",
        created_at_epoch: Math.floor(Date.now() / 1000),
        dump_file: "database.dump",
        dump_format: "custom",
        dump_sha256: hash(dump),
        postgresql_authority_file: "postgresql-authority.json",
        postgresql_authority_sha256: authoritySha,
      })}\n`,
      { mode: 0o600 },
    );
    await Promise.all(
      [authorityPath, join(backup, "postgresql-authority.json.sha256"), manifestPath].map(
        async (path) => chmod(path, 0o600),
      ),
    );
  };
  try {
    await mkdir(backup, { mode: 0o700 });
    await mkdir(binaryDirectory, { mode: 0o700 });
    await writeFile(join(backup, "database.dump"), dump, { mode: 0o600 });
    await writeFile(join(backup, "database.dump.sha256"), `${hash(dump)}  database.dump\n`, {
      mode: 0o600,
    });
    await writeFile(join(binaryDirectory, "pg_restore"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFixture(authority);
    const environment = { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH}` };
    const result = await execFileAsync("bash", [verifier, "--backup", backup], {
      env: environment,
    });
    assert.match(result.stdout, /Backup verified/u);

    const unexpectedSnapshot = join(backup, "unexpected-snapshot.json");
    await writeFile(unexpectedSnapshot, "{}\n", { mode: 0o600 });
    await assert.rejects(
      execFileAsync("bash", [verifier, "--backup", backup], { env: environment }),
      /unexpected backup entry/u,
    );
    await rm(unexpectedSnapshot);

    const leaked = { ...authority, raw_rows: [{ secret: "must-not-be-recorded" }] };
    await writeFixture(leaked);
    await assert.rejects(
      execFileAsync("bash", [verifier, "--backup", backup], { env: environment }),
      /fingerprint header is invalid/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
