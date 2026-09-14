import { expect, it } from 'vitest';
import { workerDatabaseTarget } from '../../workers/cms-audio/database-target';
it('allows only the named local worker test database without remote configuration',()=>{
  expect(workerDatabaseTarget('postgresql://localhost/steyoyoke_cms_test')).toEqual({database:'steyoyoke_cms_test',branch:null});
  expect(()=>workerDatabaseTarget('postgresql://localhost/other')).toThrow();
});
it('requires an explicit matching Neon database and branch',()=>{
  const url='postgresql://example.neon.tech/isolated';
  expect(()=>workerDatabaseTarget(url)).toThrow();
  expect(()=>workerDatabaseTarget(url,'isolated')).toThrow();
  expect(()=>workerDatabaseTarget(url,'different','br-explicit')).toThrow();
  expect(()=>workerDatabaseTarget('postgresql://example.invalid/isolated','isolated','br-explicit')).toThrow();
  expect(workerDatabaseTarget(url,'isolated','br-explicit')).toEqual({database:'isolated',branch:'br-explicit'});
});
