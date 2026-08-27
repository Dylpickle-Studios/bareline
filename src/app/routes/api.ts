import type { AppRouteContext } from './route-context.js';
import { registerApiAccountRoutes } from './api-account.js';
import { registerApiAdministrationRoutes } from './api-administration.js';
import { registerApiRepositoryContentRoutes } from './api-repository-content.js';
import { registerApiRepositoryManagementRoutes } from './api-repository-management.js';

export function registerApiRoutes(context: AppRouteContext): void {
  registerApiRepositoryManagementRoutes(context);
  registerApiRepositoryContentRoutes(context);
  registerApiAccountRoutes(context);
  registerApiAdministrationRoutes(context);
}
