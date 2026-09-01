import type { AppRouteContext } from './route-context.js';
import { registerIssueHtmlRoutes } from './repository-issues.js';
import { registerRepositoryContentHtmlRoutes } from './repository-content-html.js';
import { registerRepositorySettingsRoutes } from './repository-settings.js';

export function registerRepositoryHtmlRoutes(context: AppRouteContext): void {
  registerRepositorySettingsRoutes(context);
  registerIssueHtmlRoutes(context);
  registerRepositoryContentHtmlRoutes(context);
}
