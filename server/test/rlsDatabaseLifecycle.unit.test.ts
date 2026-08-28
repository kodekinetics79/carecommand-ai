import { describe, expect, it } from 'vitest';
import {
  assertGeneratedDisposableName,
  assertLocalServerAddress,
  buildDisposableDatabasePlan,
  DISPOSABLE_ACK,
  DISPOSABLE_PREFIX,
} from '../scripts/withDisposableRlsDatabase';

const localUrl = 'postgresql://owner:secret@127.0.0.1:5432/carecommand?schema=public';

describe('guarded disposable RLS database lifecycle', () => {
  it('builds owner/runtime URLs only for a generated local disposable database', () => {
    const plan = buildDisposableDatabasePlan({
      migrationUrl: localUrl,
      acknowledgement: DISPOSABLE_ACK,
      nodeEnv: 'test',
      suffix: 'unit_123',
    });
    expect(plan.databaseName).toBe(`${DISPOSABLE_PREFIX}unit_123`);
    expect(new URL(plan.ownerUrl).pathname).toBe(`/${plan.databaseName}`);
    expect(new URL(plan.runtimeUrl).searchParams.get('options')).toBe('-c role=app_rls');
    expect(new URL(plan.adminUrl).pathname).toBe('/carecommand');
  });

  it('accepts bracketed IPv6 loopback URLs and verified loopback server addresses', () => {
    expect(() => buildDisposableDatabasePlan({
      migrationUrl: 'postgresql://owner:secret@[::1]:5432/carecommand',
      acknowledgement: DISPOSABLE_ACK,
      nodeEnv: 'test',
      suffix: 'ipv6',
    })).not.toThrow();
    expect(() => assertLocalServerAddress('127.0.0.1')).not.toThrow();
    expect(() => assertLocalServerAddress('::1')).not.toThrow();
    expect(() => assertLocalServerAddress('172.24.0.2/32')).not.toThrow();
    expect(() => assertLocalServerAddress('192.168.1.10')).not.toThrow();
  });

  it.each([null, '', '203.0.113.10', '8.8.8.8'])(
    'refuses verified non-local/private server address %j', server => {
      expect(() => assertLocalServerAddress(server)).toThrow('non-local/private PostgreSQL server');
    },
  );

  it.each([
    [undefined, DISPOSABLE_ACK, 'missing migration URL'],
    [localUrl, undefined, 'missing acknowledgement'],
    [localUrl, 'yes', 'incorrect acknowledgement'],
    ['postgresql://owner:secret@db.example.com:5432/carecommand', DISPOSABLE_ACK, 'remote host'],
    ['https://127.0.0.1/carecommand', DISPOSABLE_ACK, 'non-PostgreSQL protocol'],
    ['postgresql://owner:secret@127.0.0.1:5432', DISPOSABLE_ACK, 'unnamed admin database'],
  ])('refuses %s (%s): %s', (migrationUrl, acknowledgement, reason) => {
    expect(reason).toBeTruthy();
    expect(() => buildDisposableDatabasePlan({ migrationUrl, acknowledgement, nodeEnv: 'test' })).toThrow();
  });

  it('refuses every production invocation even with an acknowledgement', () => {
    expect(() => buildDisposableDatabasePlan({
      migrationUrl: localUrl,
      acknowledgement: DISPOSABLE_ACK,
      nodeEnv: 'production',
    })).toThrow('NODE_ENV=production');
  });

  it.each(['carecommand', 'postgres', 'carecommand_test', '/', '', 'carecommand_rls_behavior_bad-name'])(
    'refuses destructive targeting of %j', databaseName => {
      expect(() => assertGeneratedDisposableName(databaseName)).toThrow('Refusing destructive operation');
    },
  );

  it('refuses unsafe generated suffixes and overlong names', () => {
    expect(() => buildDisposableDatabasePlan({
      migrationUrl: localUrl,
      acknowledgement: DISPOSABLE_ACK,
      nodeEnv: 'test',
      suffix: '../shared',
    })).toThrow('unsafe characters');
    expect(() => buildDisposableDatabasePlan({
      migrationUrl: localUrl,
      acknowledgement: DISPOSABLE_ACK,
      nodeEnv: 'test',
      suffix: 'a'.repeat(60),
    })).toThrow('identifier length');
  });
});
