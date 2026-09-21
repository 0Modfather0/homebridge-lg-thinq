import { describe, expect, test } from '@jest/globals';
import { normalizeOfficialState } from './adapter.js';

describe('ThinQ Connect state adapter', () => {
  test('normalizes sanitized washer fixture state', () => {
    expect(normalizeOfficialState({
      runState: { currentState: 'RUNNING' },
      operation: { washerOperationMode: 'NORMAL' },
      timer: { remainHour: 1, remainMinute: 12 },
      remoteControlEnable: { remoteControlEnabled: true },
      doorLock: { locked: true },
    })).toEqual({
      washerDryer: {
        state: 'RUNNING',
        preState: '',
        processState: 'NORMAL',
        remainTimeHour: 1,
        remainTimeMinute: 12,
        remoteStart: 'REMOTE_START_ON',
        doorLock: 'DOORLOCK_ON',
        TCLCount: 0,
      },
    });
  });

  test('normalizes MQTT wrappers without retaining unrelated fields', () => {
    const state = normalizeOfficialState({ response: { timer: { remainMinute: 7 }, state: 'END', token: 'fixture-secret' } });
    expect(state.washerDryer.state).toBe('END');
    expect(state.washerDryer.remainTimeMinute).toBe(7);
    expect(JSON.stringify(state)).not.toContain('fixture-secret');
  });
});
