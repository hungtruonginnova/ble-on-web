import { Provider } from '@angular/core';
import { Bluetooth } from 'ble-tool';
import { WebBluetoothDriver } from './web-bluetooth-driver';

/**
 * Convenience provider for BleToolModule.forRoot({ bluetoothDriver: provideWebBluetooth() }).
 *
 * @example
 * BleToolModule.forRoot({
 *   bluetoothDriver: provideWebBluetooth(),
 *   supportedToolNames: MY_TOOL_NAMES,
 * })
 */
export function provideWebBluetooth(): Provider {
  return {
    provide: Bluetooth,
    useClass: WebBluetoothDriver,
  };
}
