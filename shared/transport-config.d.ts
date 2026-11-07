export interface TransportConfig {
  readonly mode: 'emulator' | 'production';
  readonly apiUrl: string;
  readonly authEmulatorUrl?: string;
  readonly firestoreEmulatorUrl?: string;
}
export function httpsOrigin(value: unknown, label: string): string;
export function resolveTransportConfig(values: {
  mode?: string; apiUrl?: string; authEmulatorUrl?: string;
  firestoreEmulatorUrl?: string; legacyEmulatorHost?: string;
}, development?: boolean): TransportConfig;
