import type { HelperApi } from '../../shared/api';

declare global {
  interface Window {
    helperApi: HelperApi;
  }
}
