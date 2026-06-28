# ble-web-driver

Angular library that implements the `Bluetooth` abstract class from [`ble-tool`](https://github.com/hungtruonginnova) using the **Web Bluetooth API** (`navigator.bluetooth`).

This lets you scan/connect/read/write Bluetooth LE tools directly from **Chrome on desktop** (e.g. at `http://localhost:8100` during Ionic dev) — no native app required.

## Install

```bash
npm install ble-web-driver
# peerDeps: ble-tool, @angular/core, @angular/common, rxjs
```

Or as a git submodule inside an Angular workspace:

```bash
git submodule add git@github.com:hungtruonginnova/ble-on-web.git projects/ble-web-driver
```

## Usage

```typescript
// app.module.ts
import { BleToolModule, Bluetooth } from 'ble-tool';
import { WebBluetoothDriver } from 'ble-web-driver';

BleToolModule.forRoot({
  bluetoothDriver: {
    provide: Bluetooth,
    useClass: WebBluetoothDriver,
  },
  supportedToolNames: MY_TOOL_NAMES,
})
```

Or use the convenience helper:

```typescript
import { provideWebBluetooth } from 'ble-web-driver';

BleToolModule.forRoot({
  bluetoothDriver: provideWebBluetooth(),
  supportedToolNames: MY_TOOL_NAMES,
})
```

## Auto-select driver by platform

Use `bleDriverFactory` to automatically pick the right driver:
- **Native (Android/iOS)** → `BluetoothAdapter` (Cordova)
- **Chrome at `http://localhost`** → `WebBluetoothDriver`
- **Other browsers** → `BluetoothFaker`

```typescript
import { bleDriverFactory } from './providers/ble-driver.factory';

BleToolModule.forRoot({
  bluetoothDriver: { provide: Bluetooth, useFactory: bleDriverFactory },
  supportedToolNames: MY_TOOL_NAMES,
})
```

## Build (as workspace library)

```bash
ng build ble-tool        # build peer dependency first
ng build ble-web-driver  # outputs to dist/ble-web-driver
```

## Requirements

- Chrome (desktop) with Bluetooth hardware
- App served at **`http://localhost`** (Web Bluetooth requires a secure context — LAN IP URLs won't work)
- Bluetooth enabled on the machine

## Limitations

| Feature | Native (Cordova) | Web Bluetooth |
|---------|-----------------|---------------|
| Scan (list devices) | Auto-list | Browser chooser dialog (1 device) |
| Connect / Read / Write / Notify | ✅ | ✅ |
| MTU / Connection priority | ✅ | No-op |
| Auto-connect after reload | ✅ | Not supported |
