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

  test.each([
    ['POWER_OFF', 'POWEROFF'],
    ['POWER_FAIL', 'POWERFAIL'],
    ['COOL_DOWN', 'COOLDOWN'],
    ['PAUSED', 'PAUSE'],
    ['COMPLETED', 'END'],
    ['RUNNING', 'RUNNING'],
  ])('normalizes official run state %s to %s', (official, expected) => {
    expect(normalizeOfficialState({ runState: { currentState: official } }).washerDryer.state).toBe(expected);
  });

  test('selects the main appliance state from location-based washer responses', () => {
    const state = normalizeOfficialState({
      response: [
        { location: { locationName: 'MINI' }, runState: { currentState: 'POWER_OFF' } },
        {
          location: { locationName: 'MAIN' },
          runState: { currentState: 'RUNNING' },
          timer: { remainHour: 0, remainMinute: 38 },
        },
      ],
    });
    expect(state.washerDryer.state).toBe('RUNNING');
    expect(state.washerDryer.remainTimeMinute).toBe(38);
  });

  test('does not invent an off state for partial MQTT timer events', () => {
    const state = normalizeOfficialState({ timer: { remainMinute: 37 } }, true);
    expect(state).toEqual({ washerDryer: { remainTimeMinute: 37 } });
    expect(state.washerDryer).not.toHaveProperty('state');
  });
});
