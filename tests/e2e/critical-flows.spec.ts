import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/create-app.js';
import { temporaryConfig } from '../helpers.js';

let app: FastifyInstance;
let baseUrl: string;

test.beforeAll(async () => {
  const config = temporaryConfig();
  config.registration.mode = 'open';
  config.security.masterKey = Buffer.alloc(32, 6).toString('base64url');
  app = await createApp(config);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = address;
});

test.afterAll(async () => {
  await app.close();
});

test('bootstrap, repository, palette, appearance, plugins, mobile, and keyboard access', async ({
  page,
}) => {
  await page.goto(`${baseUrl}/register`);
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Display name').fill('Alice');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('link', { name: 'Create repository' })).toBeVisible();

  await page.goto(`${baseUrl}/repositories/new`);
  await page.getByLabel('Name').fill('example');
  await page.getByLabel('Description').fill('A browser-tested repository');
  await page.getByLabel('Public').check();
  await page.getByRole('button', { name: 'Create repository' }).click();
  await expect(page).toHaveURL(/\/alice\/example$/);
  await expect(page.getByRole('link', { name: 'README.md' })).toBeVisible();

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Go anywhere' });
  await expect(palette).toBeVisible();
  await palette.getByRole('searchbox').fill('theme');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(`${baseUrl}/settings/appearance`);
  await page.locator('select[name="theme"]').selectOption('dark');
  await page.getByLabel('Reduce non-essential motion').check();
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.goto(`${baseUrl}/admin/plugins`);
  const localPluginForm = page.locator('form').filter({ has: page.getByLabel('Server directory') });
  await localPluginForm.getByLabel('Server directory').fill(resolve('plugins/example'));
  await localPluginForm.getByLabel('I accept trusted-code host risk').check();
  await localPluginForm.getByRole('button', { name: 'Validate and install' }).click();
  await expect(page.getByRole('heading', { name: 'Repository Word Count' })).toBeVisible();
  await expect(page.getByText('Trusted Node code can compromise the entire host.')).toBeVisible();
  await page.getByText('Settings', { exact: true }).click();
  await expect(page.getByLabel('Maximum bytes to inspect')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/alice/example`);
  await expect(page.getByRole('heading', { name: 'alice/example' })).toBeVisible();
  const viewportFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(viewportFits).toBe(true);

  await page.goto(`${baseUrl}/`);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});
