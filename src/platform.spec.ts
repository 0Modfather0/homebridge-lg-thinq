import { EventEmitter } from 'events';
import { describe, expect, jest, test } from '@jest/globals';
import { NotConnectedError } from './errors/index.js';
import { PlatformType } from './lib/constants.js';
import { LGThinQHomebridgePlatform } from './platform.js';

function fakeLog() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
}

function fakeThinQ2Accessory() {
  return {
    context: {
      device: {
        id: 'device-1',
        platform: PlatformType.ThinQ2,
      },
    },
  };
}

describe('LGThinQHomebridgePlatform monitor startup', () => {
  test('retries a transient official API startup failure and then discovers devices', async () => {
    jest.useFakeTimers();
    const platform = Object.create(LGThinQHomebridgePlatform.prototype) as any;
    platform.config = { auth_mode: 'thinq_connect' };
    platform.log = fakeLog();
    platform.shuttingDown = false;
    platform.readyRetry = undefined;
    platform.ThinQ = {
      isReady: jest.fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('Unexpected Error'))
        .mockResolvedValueOnce(undefined),
    };
    platform.discoverDevicesWithRetry = jest.fn();

    platform.connectThinQWithRetry();
    await Promise.resolve();
    await Promise.resolve();

    expect(platform.log.warn).toHaveBeenCalledWith('ThinQ Connect startup is temporarily unavailable; retrying in 30 seconds.');
    expect(platform.ThinQ.isReady).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30000);

    expect(platform.ThinQ.isReady).toHaveBeenCalledTimes(2);
    expect(platform.discoverDevicesWithRetry).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('clears partial monitor startup state when MQTT listener registration fails', async () => {
    const platform = Object.create(LGThinQHomebridgePlatform.prototype) as any;

    platform.accessories = [fakeThinQ2Accessory()];
    platform.config = {};
    platform.enable_thinq1 = false;
    platform.events = new EventEmitter();
    platform.intervalTime = 1000;
    platform.log = fakeLog();
    platform.monitorIntervals = [];
    platform.monitorStarted = false;
    platform.ThinQ = {
      devices: jest.fn(async () => []),
      registerMQTTListener: jest.fn(async () => {
        throw new NotConnectedError('mqtt unavailable');
      }),
    };

    await expect(platform.startMonitor()).rejects.toThrow(NotConnectedError);

    expect(platform.monitorStarted).toBe(false);
    expect(platform.monitorIntervals).toEqual([]);
  });
});
