import type { AppRouteContext } from './route-context.js';
import { registerAuthCredentialRoutes } from './auth-credentials.js';
import { registerAuthPublicRoutes } from './auth-public.js';

export function registerAuthRoutes(context: AppRouteContext): void {
  registerAuthPublicRoutes(context);
  registerAuthCredentialRoutes(context);
}
