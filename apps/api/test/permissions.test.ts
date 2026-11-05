import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS } from '@crm/shared';

describe('permission matrix', () => {
  it('lets members read and write but not delete or manage', () => {
    expect(can('member', 'data:read')).toBe(true);
    expect(can('member', 'data:write')).toBe(true);
    expect(can('member', 'data:delete')).toBe(false);
    expect(can('member', 'members:manage')).toBe(false);
  });

  it('lets admins delete and manage members but not the workspace', () => {
    expect(can('admin', 'data:delete')).toBe(true);
    expect(can('admin', 'members:manage')).toBe(true);
    expect(can('admin', 'workspace:manage')).toBe(false);
  });

  it('lets only admins and owners read the audit log', () => {
    expect(can('member', 'audit:read')).toBe(false);
    expect(can('admin', 'audit:read')).toBe(true);
    expect(can('owner', 'audit:read')).toBe(true);
  });

  it('lets owners do everything', () => {
    for (const p of PERMISSIONS) {
      expect(can('owner', p)).toBe(true);
    }
  });
});
