import type { BarApi, HostApi } from '../../shared/api';

declare global {
  interface Window {
    hostApi: HostApi;
    barApi: BarApi;
  }
}
