export * from './constants';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
}

export * from './permissions';
export * from './schemas';
export * from './crm';
export * from './deals';
export * from './activities';
export * from './audit';
export * from './csv';
