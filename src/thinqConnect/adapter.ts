import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger, PlatformConfig } from 'homebridge';
import { ThinQApi, ThinQApiResponse, ThinQMQTTClient } from 'thinqconnect';
import { Device, type DeviceData } from '../lib/Device.js';
import { DeviceModel, type ModelData } from '../lib/DeviceModel.js';
import { DeviceType, PlatformType } from '../lib/constants.js';
import { PatSecretStore } from './secretStore.js';

const SUPPORTED_TYPES = new Map([
  ['DEVICE_WASHER', DeviceType.WASHER],
  ['DEVICE_DRYER', DeviceType.DRYER],
  ['DEVICE_WASHTOWER', DeviceType.WASH_TOWER],
  ['DEVICE_WASHTOWER_WASHER', DeviceType.WASH_TOWER],
  ['DEVICE_WASHTOWER_DRYER', DeviceType.DRYER],
]);
const MQTT_FILENAME = 'mqtt.json';
const CLIENT_ID_FILENAME = 'client-id';

type Json = Record<string, any>;
type OfficialDevice = {
  deviceId: string;
  deviceInfo: Json;
};

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null ? value as Json : {};
}

function firstString(...values: unknown[]): string {
  return values.find(value => typeof value === 'string' && value.trim())?.toString().trim() || '';
}

function stableUuid(value: string): string {
  const hex = createHash('sha1').update(`homebridge-lg-thinq-connect:${value}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function responseBody(response: ThinQApiResponse): any {
  if (response.status < 200 || response.status >= 300 || response.errorCode) {
    const error = new Error(response.errorMessage || `ThinQ Connect API returned HTTP ${response.status}`) as Error & {
      status?: number;
      code?: string | null;
      retryAfter?: number;
    };
    error.status = response.status;
    error.code = response.errorCode;
    const retryAfter = Number(record(response.body).retryAfter || record(response.body)['retry-after']);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      error.retryAfter = retryAfter;
    }
    throw error;
  }
  return response.body;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

function applianceState(value: unknown): Json {
  const root = record(value);
  const nested = root.response ?? root.state ?? root.reported ?? value;
  if (Array.isArray(nested)) {
    const preferred = nested.find(item => {
      const location = firstString(record(record(item).location).locationName).toUpperCase();
      return ['MAIN', 'WASHER'].includes(location);
    });
    return record(preferred || nested[0]);
  }
  return record(nested);
}

function stateString(state: Json, fallback = true): string | undefined {
  const raw = firstString(
    record(state.runState).currentState,
    state.currentState,
    state.state,
  );
  if (!raw) {
    return fallback ? 'POWEROFF' : undefined;
  }
  const canonical = raw.split('.').at(-1)!.toUpperCase();
  const aliases: Record<string, string> = {
    COMPLETE: 'END',
    COMPLETED: 'END',
    COOL_DOWN: 'COOLDOWN',
    PAUSED: 'PAUSE',
    POWER_FAIL: 'POWERFAIL',
    POWER_OFF: 'POWEROFF',
    STANDBY: 'POWEROFF',
  };
  return aliases[canonical] || canonical;
}

function owns(value: Json, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeOfficialState(value: unknown, partial = false): Json {
  const state = applianceState(value);
  const timer = record(state.timer);
  const remote = record(state.remoteControlEnable);
  const door = record(state.doorLock);
  const runState = record(state.runState);
  const operation = record(state.operation);
  const tubClean = record(state.tubClean);
  const normalized: Json = {};
  const currentState = stateString(state, !partial);
  if (currentState !== undefined) {
    normalized.state = currentState;
  }
  if (!partial || owns(runState, 'previousState') || owns(state, 'preState')) {
    normalized.preState = firstString(runState.previousState, state.preState);
  }
  if (!partial || owns(operation, 'washerOperationMode') || owns(operation, 'dryerOperationMode')) {
    normalized.processState = firstString(operation.washerOperationMode, operation.dryerOperationMode);
  }
  if (!partial || owns(timer, 'remainHour') || owns(state, 'remainTimeHour')) {
    normalized.remainTimeHour = Number(timer.remainHour ?? state.remainTimeHour ?? 0);
  }
  if (!partial || owns(timer, 'remainMinute') || owns(state, 'remainTimeMinute')) {
    normalized.remainTimeMinute = Number(timer.remainMinute ?? state.remainTimeMinute ?? 0);
  }
  if (!partial || owns(remote, 'remoteControlEnabled') || owns(state, 'remoteControlEnabled')) {
    normalized.remoteStart = (remote.remoteControlEnabled ?? state.remoteControlEnabled)
      ? 'REMOTE_START_ON' : 'REMOTE_START_OFF';
  }
  if (!partial || owns(door, 'doorLockEnabled') || owns(door, 'locked') || owns(state, 'doorLockEnabled')) {
    normalized.doorLock = (door.doorLockEnabled ?? door.locked ?? state.doorLockEnabled)
      ? 'DOORLOCK_ON' : 'DOORLOCK_OFF';
  }
  if (!partial || owns(tubClean, 'count') || owns(state, 'TCLCount')) {
    normalized.TCLCount = Number(tubClean.count ?? state.TCLCount ?? 0);
  }
  return { washerDryer: normalized };
}

function mergeOfficialSnapshot(previous: Json | undefined, update: Json): Json {
  return {
    ...previous,
    ...update,
    washerDryer: {
      ...record(previous?.washerDryer),
      ...record(update.washerDryer),
    },
  };
}

function minimalModel(device: Device): DeviceModel {
  return new DeviceModel({
    Info: {
      productType: device.type,
      productCode: '',
      country: '',
      modelType: device.type,
      model: device.model,
      modelName: device.model,
      networkType: 'ThinQ Connect',
      version: '1',
    },
    Value: {},
    Monitoring: { type: 'THINQ2', protocol: {} },
  } as ModelData);
}

function configuredItems(config: PlatformConfig): Json[] {
  return Array.isArray(config.devices) ? config.devices.map(record) : [];
}

export class ThinQConnectAdapter {
  private api?: ThinQApi;
  private mqtt?: ThinQMQTTClient;
  private clientId = '';
  private readonly stateDirectory: string;
  private readonly apiToAccessory = new Map<string, string>();
  private readonly snapshots = new Map<string, Json>();

  constructor(
    private readonly config: PlatformConfig,
    private readonly logger: Logger,
    private readonly secrets: PatSecretStore,
    storagePath: string,
  ) {
    this.stateDirectory = path.join(storagePath, '@0modfather0-homebridge-lg-thinq', 'persist', 'thinq-connect');
  }

  public async ready(): Promise<void> {
    const pat = await this.secrets.read();
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(this.stateDirectory, 0o700);
    }
    this.clientId = await this.loadClientId();
    this.api = new ThinQApi(pat, String(this.config.country), this.clientId);
    await this.listOfficialDevices();
    this.logger.warn('ThinQ Connect mode is experimental, has limited real-world testing, and is used at your own risk.');
  }

  public async devices(): Promise<Device[]> {
    const official = await this.listOfficialDevices();
    const supported = official.filter(item => SUPPORTED_TYPES.has(firstString(item.deviceInfo.deviceType)));
    const configured = configuredItems(this.config);
    const assigned = new Set<string>();

    return Promise.all(supported.map(async item => {
      const info = item.deviceInfo;
      const typeName = firstString(info.deviceType);
      const serial = firstString(info.serialNumber, info.serialNo, record(info.manufacture).serialNo);
      const alias = firstString(info.alias, info.name, item.deviceId);
      const candidates = configured.filter(candidate => {
        if (candidate.api_device_id === item.deviceId || candidate.id === item.deviceId) {
          return true;
        }
        if (serial && firstString(candidate.serial_number) === serial) {
          return true;
        }
        return firstString(candidate.name) === alias && this.configuredTypeMatches(candidate.type, typeName);
      });
      if (candidates.length > 1) {
        throw new Error(`Ambiguous migration for ${alias}; more than one configured accessory matches. No changes were made.`);
      }
      const candidate = candidates[0];
      if (candidate?.id && assigned.has(candidate.id)) {
        throw new Error(`Ambiguous migration: accessory ${candidate.id} matched more than one ThinQ Connect device.`);
      }
      const accessoryId = firstString(candidate?.id) || stableUuid(item.deviceId);
      assigned.add(accessoryId);
      this.apiToAccessory.set(item.deviceId, accessoryId);

      const status = await this.getStatus(item.deviceId);
      const normalizedSnapshot = { online: true, ...normalizeOfficialState(status) };
      this.snapshots.set(item.deviceId, normalizedSnapshot);
      const data: DeviceData = {
        deviceId: accessoryId,
        apiDeviceId: item.deviceId,
        officialDeviceType: typeName,
        alias,
        modelJsonUri: '',
        deviceType: SUPPORTED_TYPES.get(typeName)!,
        modelName: firstString(info.modelName, info.model),
        manufacture: { serialNo: serial },
        snapshot: normalizedSnapshot,
        platformType: PlatformType.ThinQ2,
        online: true,
      };
      const device = new Device(data);
      device.deviceModel = minimalModel(device);
      return device;
    }));
  }

  public async setup(device: Device): Promise<boolean> {
    device.deviceModel = minimalModel(device);
    return true;
  }

  public async poll(device: Device): Promise<Device> {
    device.snapshot = { online: true, ...normalizeOfficialState(await this.getStatus(device.apiDeviceId)) };
    this.snapshots.set(device.apiDeviceId, device.snapshot);
    return device;
  }

  public async registerEvents(callback: (data: any) => void): Promise<void> {
    const api = this.requireApi();
    const devices = await this.listOfficialDevices();
    for (const device of devices.filter(item => SUPPORTED_TYPES.has(firstString(item.deviceInfo.deviceType)))) {
      await this.withBackoff(() => api.asyncPostEventSubscribe(device.deviceId));
    }
    this.mqtt = new ThinQMQTTClient(
      api,
      this.clientId,
      (_topic, payload) => {
        try {
          const message = JSON.parse(Buffer.from(payload).toString('utf8')) as Json;
          const apiDeviceId = firstString(message.deviceId);
          const accessoryId = this.apiToAccessory.get(apiDeviceId);
          if (accessoryId) {
            const update = normalizeOfficialState(message.report, true);
            const snapshot = mergeOfficialSnapshot(this.snapshots.get(apiDeviceId), update);
            this.snapshots.set(apiDeviceId, snapshot);
            callback({ deviceId: accessoryId, data: { state: { reported: snapshot } } });
          }
        } catch (error) {
          this.logger.warn('Ignored an invalid ThinQ Connect MQTT event:', this.safeError(error));
        }
      },
      error => this.logger.warn('ThinQ Connect MQTT interrupted:', this.safeError(error)),
      () => this.logger.info('ThinQ Connect MQTT connected.'),
      error => this.logger.warn('ThinQ Connect MQTT connection failed:', this.safeError(error)),
      () => this.logger.info('ThinQ Connect MQTT connection closed.'),
    );
    await this.mqtt.asyncInit();
    const restored = await this.restoreMqtt(this.mqtt);
    if (!restored && !await this.mqtt.asyncPrepareMqtt()) {
      throw new Error('ThinQ Connect could not create MQTT credentials.');
    }
    if (!restored) {
      await this.saveMqtt(this.mqtt);
    }
    await this.mqtt.asyncConnectMqtt();
    if (this.mqtt.state !== 'client_connected' && restored) {
      this.logger.warn('Stored ThinQ Connect MQTT certificate was rejected; renewing it once.');
      if (!await this.mqtt.asyncPrepareMqtt()) {
        throw new Error('ThinQ Connect could not renew MQTT credentials.');
      }
      await this.saveMqtt(this.mqtt);
      await this.mqtt.asyncConnectMqtt();
    }
    if (this.mqtt.state !== 'client_connected') {
      throw new Error('ThinQ Connect MQTT connection did not become ready.');
    }
  }

  public async close(): Promise<void> {
    await this.mqtt?.asyncDisconnectMqtt();
  }

  public static async validatePat(pat: string, country: string): Promise<void> {
    const response = await new ThinQApi(pat, country, randomUUID()).asyncGetDeviceList();
    responseBody(response);
  }

  private async listOfficialDevices(): Promise<OfficialDevice[]> {
    const body = responseBody(await this.withBackoff(() => this.requireApi().asyncGetDeviceList()));
    const list: unknown[] = Array.isArray(body) ? body : Array.isArray(record(body).devices) ? record(body).devices : [];
    return list.map((item: unknown) => record(item)).filter((item: Json) => firstString(item.deviceId)).map((item: Json) => ({
      deviceId: firstString(item.deviceId),
      deviceInfo: record(item.deviceInfo),
    }));
  }

  private async getStatus(deviceId: string): Promise<unknown> {
    return responseBody(await this.withBackoff(() => this.requireApi().asyncGetDeviceStatus(deviceId)));
  }

  private async withBackoff(operation: () => Promise<ThinQApiResponse>): Promise<ThinQApiResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await operation();
        if (response.status !== 429 && response.status < 500) {
          return response;
        }
        const body = record(response.body);
        const retryAfter = Number(body.retryAfter || body['retry-after']);
        await wait(Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 300_000)
          : Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 30_000));
        lastError = new Error(response.errorMessage || `ThinQ Connect API returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        await wait(Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 30_000));
      }
    }
    throw lastError;
  }

  private requireApi(): ThinQApi {
    if (!this.api) {
      throw new Error('ThinQ Connect API is not initialized.');
    }
    return this.api;
  }

  private configuredTypeMatches(configuredType: unknown, officialType: string): boolean {
    const mapped = SUPPORTED_TYPES.get(officialType);
    return !configuredType || configuredType === DeviceType[mapped!];
  }

  private async loadClientId(): Promise<string> {
    const location = path.join(this.stateDirectory, CLIENT_ID_FILENAME);
    try {
      const stats = await fs.lstat(location);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('ThinQ Connect client ID path is not a regular file.');
      }
      return (await fs.readFile(location, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const clientId = randomUUID();
    await fs.writeFile(location, `${clientId}\n`, { flag: 'wx', mode: 0o600 });
    return clientId;
  }

  private async restoreMqtt(client: ThinQMQTTClient): Promise<boolean> {
    try {
      const location = path.join(this.stateDirectory, MQTT_FILENAME);
      const stats = await fs.lstat(location);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('ThinQ Connect MQTT credential path is not a regular file.');
      }
      const saved = JSON.parse(await fs.readFile(location, 'utf8')) as Json;
      for (const key of ['rootCa', 'privateKey', 'certificate', 'csrStr', 'topicSubscription'] as const) {
        if (!firstString(saved[key])) {
          return false;
        }
        client[key] = saved[key];
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private async saveMqtt(client: ThinQMQTTClient): Promise<void> {
    const location = path.join(this.stateDirectory, MQTT_FILENAME);
    const temporary = `${location}.${process.pid}.tmp`;
    const data = {
      rootCa: client.rootCa,
      privateKey: client.privateKey,
      certificate: client.certificate,
      csrStr: client.csrStr,
      topicSubscription: client.topicSubscription,
    };
    await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, location);
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message.replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]') : 'Unknown error';
  }
}
