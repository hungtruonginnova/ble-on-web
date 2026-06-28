import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { Bluetooth, BLEScanOptions } from 'ble-tool';

// Minimal Web Bluetooth typings to avoid @types/web-bluetooth dependency
interface WebBluetoothCharacteristic extends EventTarget {
  uuid: string;
  properties: any;
  value: DataView | null;
  service: WebBluetoothService;
  readValue(): Promise<DataView>;
  writeValueWithResponse(value: ArrayBuffer | ArrayBufferView): Promise<void>;
  writeValueWithoutResponse(value: ArrayBuffer | ArrayBufferView): Promise<void>;
  startNotifications(): Promise<WebBluetoothCharacteristic>;
  stopNotifications(): Promise<WebBluetoothCharacteristic>;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: any) => void): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

interface WebBluetoothService {
  uuid: string;
  device: WebBluetoothDevice;
  getCharacteristic(characteristic: number | string): Promise<WebBluetoothCharacteristic>;
  getCharacteristics(): Promise<WebBluetoothCharacteristic[]>;
}

interface WebBluetoothGATTServer {
  device: WebBluetoothDevice;
  connected: boolean;
  connect(): Promise<WebBluetoothGATTServer>;
  disconnect(): void;
  getPrimaryService(service: number | string): Promise<WebBluetoothService>;
  getPrimaryServices(): Promise<WebBluetoothService[]>;
}

interface WebBluetoothDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: WebBluetoothGATTServer;
  addEventListener(type: 'gattserverdisconnected', listener: (event: any) => void): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

interface NavigatorBluetooth {
  getAvailability(): Promise<boolean>;
  requestDevice(options: any): Promise<WebBluetoothDevice>;
  addEventListener(type: 'availabilitychanged', listener: (event: any) => void): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

// All 16-bit UUIDs used by Innova tools declared upfront for requestDevice optionalServices
const INNOVA_SERVICE_UUIDS = [0xffe0, 0xffe5, 0xffe4, 0xffe9, 0xfff1, 0xfff2];

/**
 * Convert a 4-char or 8-char short UUID to a 16-bit number for Web Bluetooth API,
 * or normalise a full UUID to lowercase. Used in getPrimaryService / getCharacteristic.
 */
function toWebBTUUID(uuid: string): number | string {
  if (uuid.length === 4) {
    return parseInt(uuid, 16);
  }
  if (uuid.length === 8) {
    return parseInt(uuid.slice(4), 16);
  }
  return uuid.toLowerCase();
}

/**
 * Convert a full Bluetooth UUID ("0000ffe0-0000-1000-8000-00805f9b34fb") back to
 * its 4-char short form ("FFE0") so it matches ToolServiceUUID constants.
 */
function fullToShortUUID(uuid: string): string {
  const match = uuid.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i);
  if (match) {
    return match[1].toUpperCase();
  }
  return uuid.toUpperCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getNavigatorBluetooth(): NavigatorBluetooth | null {
  return (navigator as any).bluetooth ?? null;
}

@Injectable()
export class WebBluetoothDriver extends Bluetooth {
  /** Map of deviceId → BluetoothDevice, populated on scan */
  private readonly deviceMap = new Map<string, WebBluetoothDevice>();
  /** Map of deviceId → GATTServer, populated on connect */
  private readonly serverMap = new Map<string, WebBluetoothGATTServer>();
  /**
   * Characteristic cache key: `${deviceId}|${SHORT_SVC}|${SHORT_CHAR}` (e.g. FFE5|FFE9)
   * Caching avoids repeated getPrimaryService/getCharacteristic round-trips per GATT op.
   */
  private readonly charCache = new Map<string, WebBluetoothCharacteristic>();

  private stateSubject: Subject<string> | null = null;
  private availabilityHandler: ((e: any) => void) | null = null;

  // ─── Scan ─────────────────────────────────────────────────────────────────

  scan(services: string[], seconds: number): Observable<any> {
    return this.startScanWithOptions(services, {});
  }

  startScan(services: string[]): Observable<any> {
    return this.startScanWithOptions(services, {});
  }

  startScanWithOptions(services: string[], options: BLEScanOptions): Observable<any> {
    return new Observable(observer => {
      const bt = getNavigatorBluetooth();
      if (!bt) {
        observer.error(new Error('Web Bluetooth API not available. Open app in Chrome on a device with Bluetooth.'));
        return;
      }
      bt.requestDevice({
        acceptAllDevices: true,
        optionalServices: INNOVA_SERVICE_UUIDS,
      }).then((device: WebBluetoothDevice) => {
        this.deviceMap.set(device.id, device);
        observer.next({
          id: device.id,
          name: device.name ?? '',
          rssi: 0,
          advertising: {},
          services: [],
          characteristics: [],
        });
        observer.complete();
      }).catch((err: any) => {
        // User cancelled chooser → treat as stopScan, not error
        if (err?.name === 'NotFoundError' || err?.code === 8) {
          observer.complete();
        } else {
          observer.error(err);
        }
      });
    });
  }

  stopScan(): Promise<any> {
    return Promise.resolve();
  }

  // ─── Connect ──────────────────────────────────────────────────────────────

  connect(deviceId: string): Observable<any> {
    return new Observable(observer => {
      const device = this.deviceMap.get(deviceId);
      if (!device) {
        observer.error(new Error(
          `Device "${deviceId}" not found. Scan and select it first.`
        ));
        return;
      }

      const onDisconnected = () => {
        this.serverMap.delete(deviceId);
        this._clearCharCache(deviceId);
        // ToolService treats error() on the connect Observable as "disconnected"
        observer.error({ id: deviceId, name: device.name });
      };

      device.addEventListener('gattserverdisconnected', onDisconnected);

      device.gatt!.connect().then(async (server: WebBluetoothGATTServer) => {
        this.serverMap.set(deviceId, server);

        // Discover all services & characteristics to populate cache and build charList
        const charList: Array<{
          service: string;
          characteristic: string;
          properties: any;
          isNotifying: boolean;
          value: ArrayBuffer;
        }> = [];

        try {
          const webServices = await server.getPrimaryServices();
          for (const svc of webServices) {
            const shortSvc = fullToShortUUID(svc.uuid);
            try {
              const chars = await svc.getCharacteristics();
              for (const ch of chars) {
                const shortChar = fullToShortUUID(ch.uuid);
                const cacheKey = `${deviceId}|${shortSvc}|${shortChar}`;
                this.charCache.set(cacheKey, ch);
                charList.push({
                  service: shortSvc,
                  characteristic: shortChar,
                  properties: ch.properties,
                  isNotifying: false,
                  value: new ArrayBuffer(0),
                });
              }
            } catch (_) {
              // Some services may be protected; skip silently
            }
          }
        } catch (_) {
          // Discovery failed; Tool model defaults (FFE0/FFE5/FFE4/FFE9) will be used
        }

        const peripheral = {
          id: deviceId,
          name: device.name ?? '',
          rssi: 0,
          advertising: {},
          services: charList.map(c => c.service).filter((v, i, a) => a.indexOf(v) === i),
          characteristics: charList,
        };

        observer.next(peripheral);
        // Observable stays open; next disconnect triggers observer.error() via gattserverdisconnected
      }).catch((err: any) => {
        device.removeEventListener('gattserverdisconnected', onDisconnected);
        observer.error(err);
      });

      // Teardown: remove disconnect listener if consumer unsubscribes early
      return () => {
        device.removeEventListener('gattserverdisconnected', onDisconnected);
      };
    });
  }

  async disconnect(deviceId: string): Promise<any> {
    const server = this.serverMap.get(deviceId);
    if (server?.connected) {
      server.disconnect();
    }
    this.serverMap.delete(deviceId);
    this._clearCharCache(deviceId);
    return;
  }

  autoConnect(deviceId: string, connectCallback: any, disconnectCallback: any): void {
    // Web Bluetooth does not support background auto-connect without user gesture.
    // Fire disconnectCallback so ToolService knows and can prompt a manual reconnect.
    console.warn('[WebBluetoothDriver] autoConnect not supported — triggering disconnect callback');
    disconnectCallback({ id: deviceId });
  }

  async isConnected(deviceId: string): Promise<any> {
    const server = this.serverMap.get(deviceId);
    if (server?.connected) {
      return;
    }
    throw new Error('Not connected');
  }

  async peripheralsWithIdentifiers(uuids: string[]): Promise<any[]> {
    // iOS-only; not available in Web Bluetooth
    return [];
  }

  // ─── Read / Write ─────────────────────────────────────────────────────────

  async read(deviceId: string, serviceUUID: string, characteristicUUID: string): Promise<any> {
    const ch = await this._getCharacteristic(deviceId, serviceUUID, characteristicUUID);
    const value = await ch.readValue();
    return value.buffer;
  }

  async write(
    deviceId: string,
    serviceUUID: string,
    characteristicUUID: string,
    value: ArrayBuffer
  ): Promise<any> {
    const ch = await this._getCharacteristic(deviceId, serviceUUID, characteristicUUID);
    await ch.writeValueWithResponse(value);
  }

  async writeWithoutResponse(
    deviceId: string,
    serviceUUID: string,
    characteristicUUID: string,
    value: ArrayBuffer
  ): Promise<any> {
    const ch = await this._getCharacteristic(deviceId, serviceUUID, characteristicUUID);
    await ch.writeValueWithoutResponse(value);
  }

  async writeQ(
    deviceId: string,
    serviceUUID: string,
    characteristicUUID: string,
    value: ArrayBuffer,
    chunkSize: number,
    chunkDelay: number
  ): Promise<any> {
    const ch = await this._getCharacteristic(deviceId, serviceUUID, characteristicUUID);
    let offset = 0;
    while (offset < value.byteLength) {
      const chunk = value.slice(offset, offset + chunkSize);
      await ch.writeValueWithoutResponse(chunk);
      offset += chunkSize;
      if (chunkDelay > 0 && offset < value.byteLength) {
        await sleep(chunkDelay);
      }
    }
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  startNotification(
    deviceId: string,
    serviceUUID: string,
    characteristicUUID: string
  ): Observable<any> {
    return new Observable(observer => {
      let ch: WebBluetoothCharacteristic | null = null;
      let handler: ((event: any) => void) | null = null;

      this._getCharacteristic(deviceId, serviceUUID, characteristicUUID).then(characteristic => {
        ch = characteristic;
        return ch.startNotifications();
      }).then(() => {
        handler = (event: any) => {
          observer.next(event.target.value.buffer as ArrayBuffer);
        };
        ch!.addEventListener('characteristicvaluechanged', handler);
      }).catch(err => observer.error(err));

      // Teardown on unsubscribe
      return () => {
        if (ch && handler) {
          ch.removeEventListener('characteristicvaluechanged', handler);
          ch.stopNotifications().catch(() => {});
        }
      };
    });
  }

  async stopNotification(
    deviceId: string,
    serviceUUID: string,
    characteristicUUID: string
  ): Promise<any> {
    const cacheKey = this._charCacheKey(deviceId, serviceUUID, characteristicUUID);
    const ch = this.charCache.get(cacheKey);
    if (ch) {
      await ch.stopNotifications();
    }
  }

  // ─── State ────────────────────────────────────────────────────────────────

  async isEnabled(): Promise<void> {
    const bt = getNavigatorBluetooth();
    if (!bt) {
      throw new Error('Web Bluetooth API not available');
    }
    const available = await bt.getAvailability();
    if (!available) {
      throw new Error('Bluetooth is not available');
    }
  }

  startStateNotifications(): Observable<any> {
    return new Observable(observer => {
      const bt = getNavigatorBluetooth();
      if (!bt) {
        observer.error(new Error('Web Bluetooth API not available'));
        return;
      }
      this.availabilityHandler = (event: any) => {
        observer.next(event.value ? 'on' : 'off');
      };
      bt.addEventListener('availabilitychanged', this.availabilityHandler);

      return () => {
        if (this.availabilityHandler) {
          bt.removeEventListener('availabilitychanged', this.availabilityHandler);
          this.availabilityHandler = null;
        }
      };
    });
  }

  async stopStateNotifications(): Promise<any> {
    const bt = getNavigatorBluetooth();
    if (bt && this.availabilityHandler) {
      bt.removeEventListener('availabilitychanged', this.availabilityHandler);
      this.availabilityHandler = null;
    }
  }

  // ─── Native-only no-ops ───────────────────────────────────────────────────

  async requestMtu(deviceId: string, mtuSize: number): Promise<any> {
    return; // Not available in Web Bluetooth
  }

  async requestConnectionPriority(
    deviceId: string,
    priority: 'low' | 'balanced' | 'high'
  ): Promise<boolean> {
    return true; // Not available in Web Bluetooth
  }

  async readRSSI(deviceId: string): Promise<any> {
    return 0;
  }

  async refreshDeviceCache(deviceId: string, timeoutMillis: number): Promise<any> {
    return;
  }

  async enable(): Promise<any> {
    return;
  }

  async showBluetoothSettings(): Promise<any> {
    return;
  }

  async bondedDevices(): Promise<any[]> {
    return [];
  }

  async connectedPeripheralsWithServices(services: string[]): Promise<any[]> {
    return [];
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private _charCacheKey(deviceId: string, serviceUUID: string, charUUID: string): string {
    const svc = serviceUUID.length <= 8 ? serviceUUID.toUpperCase() : fullToShortUUID(serviceUUID);
    const ch = charUUID.length <= 8 ? charUUID.toUpperCase() : fullToShortUUID(charUUID);
    return `${deviceId}|${svc}|${ch}`;
  }

  private async _getCharacteristic(
    deviceId: string,
    serviceUUID: string,
    characteristicUUID: string
  ): Promise<WebBluetoothCharacteristic> {
    const cacheKey = this._charCacheKey(deviceId, serviceUUID, characteristicUUID);
    const cached = this.charCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const server = this.serverMap.get(deviceId);
    if (!server?.connected) {
      throw new Error(`Device "${deviceId}" is not connected`);
    }

    const svc = await server.getPrimaryService(toWebBTUUID(serviceUUID));
    const ch = await svc.getCharacteristic(toWebBTUUID(characteristicUUID));
    this.charCache.set(cacheKey, ch);
    return ch;
  }

  private _clearCharCache(deviceId: string): void {
    for (const key of Array.from(this.charCache.keys())) {
      if (key.startsWith(`${deviceId}|`)) {
        this.charCache.delete(key);
      }
    }
  }
}
