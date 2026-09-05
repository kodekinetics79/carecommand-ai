import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

type EnvEntry = {
  key?: string;
  value?: string | boolean;
  sync?: boolean;
  generateValue?: boolean;
  fromGroup?: string;
  fromService?: Record<string, string>;
};
type Service = {
  type: string;
  name: string;
  plan?: string;
  startCommand?: string;
  healthCheckPath?: string;
  autoDeploy?: boolean;
  preDeployCommand?: string;
  envVars?: EnvEntry[];
};
type Blueprint = {
  services: Service[];
  envVarGroups: Array<{ name: string; envVars: EnvEntry[] }>;
};

const blueprintText = read('render.pilot.yaml');
const blueprint = parse(blueprintText) as Blueprint;
const service = (type: string) => blueprint.services.find(item => item.type === type)!;
const keyed = (entries: EnvEntry[] = []) => new Map(entries.filter(item => item.key).map(item => [item.key!, item]));
const externalKeys = [
  'DATABASE_URL', 'PLATFORM_DATABASE_URL', 'CORS_ORIGINS', 'PUBLIC_API_URL',
  'PAYMENT_PROVIDER', 'INSURANCE_PROVIDER', 'AI_PROVIDER', 'ALLOWED_MOCK_INTEGRATIONS',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_SUCCESS_URL', 'STRIPE_CANCEL_URL',
  'STEDI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'RETELL_API_KEY', 'RETELL_FROM_NUMBER',
  'CAMPAIGN_WEBHOOK_SECRET', 'EMAIL_HTTP_API_URL', 'EMAIL_HTTP_API_KEY',
  'EMAIL_FROM_ADDRESS', 'OTEL_ENABLED', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS',
];

describe('production engineering repository gates', () => {
  it('parses into separate always-on API, worker, and persistent queue services', () => {
    expect(blueprint.services).toHaveLength(3);
    expect(blueprint.services.map(item => item.type).sort()).toEqual(['keyvalue', 'web', 'worker']);
    expect(blueprint.services.every(item => item.plan === 'starter')).toBe(true);
    expect(service('web').healthCheckPath).toBe('/health/ready');
    expect(service('web').startCommand).toBe('npm run api:start');
    expect(service('worker').startCommand).toBe('npm run worker:start');
    expect(service('web').autoDeploy).toBe(false);
    expect(service('worker').autoDeploy).toBe(false);
    expect(service('web').preDeployCommand).toBeUndefined();
  });

  it('fails configuration toward production, RLS, queues, and protected metrics', () => {
    const group = blueprint.envVarGroups.find(item => item.name === 'carecommand-pilot-shared');
    expect(group).toBeDefined();
    const shared = keyed(group?.envVars);
    expect(shared.get('NODE_ENV')?.value).toBe('production');
    expect(shared.get('DEPLOYMENT_PROFILE')?.value).toBe('pilot');
    expect(shared.get('INGRESS_MODE')?.value).toBe('trusted_proxy');
    expect(shared.get('QUEUES_ENABLED')?.value).toBe('true');
    expect(shared.get('QUEUE_NAMESPACE')?.value).toBe('carecommand-pilot');
    expect(shared.get('RLS_ENFORCE_RUNTIME_ROLE')?.value).toBe('true');
    expect(shared.get('PLATFORM_LEGACY_TOKEN_ENABLED')?.value).toBe('false');
    expect(shared.get('COOKIE_SAMESITE')?.value).toBe('none');
    expect(shared.get('METRICS_ENABLED')?.value).toBe('true');
    expect(shared.get('METRICS_TOKEN')?.generateValue).toBe(true);
    expect(shared.get('ELIGIBILITY_HMAC_SECRET')?.generateValue).toBe(true);
    expect(keyed(service('web').envVars).get('TRUSTED_PROXY_CIDRS')?.sync).toBe(false);
  });

  it('uses a dedicated fail-fast Redis client for Retell callback limits', () => {
    const source = read('server/lib/receptionist/retellRateStore.ts');
    expect(source).toContain('enableOfflineQueue: false');
    expect(source).toContain('maxRetriesPerRequest: 0');
    expect(source).toContain('retryStrategy: () => null');
    expect(source).toContain('disconnect(false)');
  });

  it('uses sync:false only on services, never in an environment group', () => {
    for (const group of blueprint.envVarGroups) {
      expect(group.envVars.filter(entry => entry.sync !== undefined), `${group.name} contains unsupported sync`).toEqual([]);
    }
    for (const runtime of [service('web'), service('worker')]) {
      const environment = keyed(runtime.envVars);
      for (const key of externalKeys) {
        expect(environment.get(key)?.sync, `${runtime.name} must request ${key}`).toBe(false);
      }
      expect(environment.get('DATABASE_MIGRATION_URL')).toBeUndefined();
    }
  });

  it('contains no embedded provider mode, credential, loopback URL, or automatic deployment', () => {
    expect(blueprintText).not.toMatch(/value:\s*mock\b/);
    expect(blueprintText).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(blueprintText).not.toMatch(/(?:sk_live|whsec_|AKIA|Bearer\s+[A-Za-z0-9])/);
  });

  it('provides a reproducible clean-clone verifier that installs from the lockfile', () => {
    const verifier = read('scripts/verify-clean-clone.sh');
    expect(verifier).toContain('git clone --quiet --local --no-hardlinks');
    expect(verifier).toContain('npm ci');
    expect(verifier).toContain('npm run check');
    expect(verifier).toContain('npm test');
    expect(verifier).toContain('npm run test:rls:behavior');
    expect(verifier).toContain('npm run verify:db-lifecycle');
    expect(verifier).toContain('npm run test:e2e');
  });

  it('keeps the schema-owner secret in an explicit isolated migration command', () => {
    const migration = read('scripts/deploy-migrations.sh');
    expect(migration).toContain('RELEASE_MIGRATION_ACK');
    expect(migration).toContain('DATABASE_MIGRATION_URL');
    expect(migration).toContain('DATABASE_MIGRATION_PRINCIPAL');
    expect(migration).toContain("<<'NODE'");
    expect(migration).toContain('schema-owner and runtime database principals must be distinct');
    expect(migration).toContain('npx prisma migrate deploy');
  });

  it('rejects migration-owner aliases despite URL query differences and rejects runtime migration principals', () => {
    const runGuard = (migrationUrl: string, tenantUrl: string) => spawnSync('bash', ['scripts/deploy-migrations.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_MIGRATION_ACK: 'APPLY_REVIEWED_CARECOMMAND_MIGRATIONS',
        DATABASE_MIGRATION_URL: migrationUrl,
        DATABASE_MIGRATION_PRINCIPAL: new URL(migrationUrl).username,
        DATABASE_URL: tenantUrl,
        PLATFORM_DATABASE_URL: 'postgresql://app_platform:secret@db.carecommand.example.com/carecommand',
      },
    });
    const alias = runGuard(
      'postgresql://same_owner:secret@db.carecommand.example.com/carecommand',
      'postgresql://same_owner:secret@db.carecommand.example.com/carecommand?application_name=bypass',
    );
    expect(alias.status).not.toBe(0);
    expect(alias.stderr).toContain('schema-owner and runtime database principals must be distinct');

    const runtimePrincipal = runGuard(
      'postgresql://app_rls:secret@db.carecommand.example.com/carecommand',
      'postgresql://tenant_runtime:secret@db.carecommand.example.com/carecommand',
    );
    expect(runtimePrincipal.status).not.toBe(0);
    expect(runtimePrincipal.stderr).toContain('runtime principals app_rls/app_platform cannot own schema migrations');
  });

  it('does not require runtime database secrets in the isolated migration job', () => {
    const result = spawnSync('bash', ['scripts/deploy-migrations.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_MIGRATION_ACK: 'APPLY_REVIEWED_CARECOMMAND_MIGRATIONS',
        DATABASE_MIGRATION_URL: 'postgresql://app_rls:secret@db.carecommand.example.com/carecommand',
        DATABASE_MIGRATION_PRINCIPAL: 'app_rls',
        DATABASE_URL: '',
        PLATFORM_DATABASE_URL: '',
      },
    });
    expect(result.stderr).not.toContain('DATABASE_URL and PLATFORM_DATABASE_URL');
    expect(result.stderr).toContain('runtime principals app_rls/app_platform cannot own schema migrations');
  });

  it('keeps local and platform-generated environment files outside version control', () => {
    const ignore = read('.gitignore');
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^\.env\.\*$/m);
    expect(ignore).toMatch(/^\.vercel$/m);
  });
});
