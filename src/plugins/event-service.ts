import type { Database } from '../database/database.js';
import { PluginContributionService } from './contribution-service.js';
import { PluginManager } from './plugin-manager.js';
import { pluginEventNames } from './manifest.js';

export type PluginEventName = (typeof pluginEventNames)[number];

export class PluginEventService {
  constructor(
    private readonly database: Database,
    private readonly plugins: PluginManager,
    private readonly contributions: PluginContributionService,
  ) {}

  publish(event: PluginEventName, payload: Readonly<Record<string, unknown>>): number {
    const now = new Date().toISOString();
    let queued = 0;
    this.database.transaction(() => {
      const insert = this.database.prepare(
        `INSERT INTO plugin_event_jobs
          (plugin_id, event_name, handler, payload_json, available_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const plugin of this.plugins.list()) {
        if (!plugin.enabled || !this.plugins.hasCapability(plugin.id, 'events.subscribe')) continue;
        const filtered = this.filterPayload(plugin.id, payload);
        const encoded = JSON.stringify(filtered);
        if (Buffer.byteLength(encoded) > 64 * 1024) continue;
        for (const contribution of plugin.manifest.contributes.events) {
          if (contribution.event !== event) continue;
          insert.run(plugin.id, event, contribution.handler, encoded, now, now);
          queued += 1;
        }
      }
    })();
    return queued;
  }

  async processNext(): Promise<boolean> {
    const now = new Date();
    const job = this.database.transaction(() => {
      const candidate = this.database
        .prepare(
          `SELECT id, plugin_id AS pluginId, event_name AS eventName, handler, payload_json AS payloadJson
           FROM plugin_event_jobs
           WHERE available_at <= ? AND (state = 'pending' OR (state = 'running' AND lease_until < ?))
           ORDER BY id LIMIT 1`,
        )
        .get(now.toISOString(), now.toISOString()) as
        | { id: number; pluginId: string; eventName: string; handler: string; payloadJson: string }
        | undefined;
      if (!candidate) return null;
      const updated = this.database
        .prepare(
          `UPDATE plugin_event_jobs SET state = 'running', attempts = attempts + 1, lease_until = ?
           WHERE id = ? AND (state = 'pending' OR lease_until < ?)`,
        )
        .run(new Date(now.getTime() + 60_000).toISOString(), candidate.id, now.toISOString());
      return updated.changes === 1 ? candidate : null;
    })();
    if (!job) return false;
    try {
      await this.contributions.dispatchEvent(
        job.pluginId,
        job.handler,
        job.eventName,
        JSON.parse(job.payloadJson) as unknown,
      );
      this.database.prepare('DELETE FROM plugin_event_jobs WHERE id = ?').run(job.id);
    } catch (error) {
      const attempts = (
        this.database
          .prepare('SELECT attempts FROM plugin_event_jobs WHERE id = ?')
          .get(job.id) as {
          attempts: number;
        }
      ).attempts;
      this.database
        .prepare(
          `UPDATE plugin_event_jobs SET state = ?, lease_until = NULL, available_at = ?, error = ? WHERE id = ?`,
        )
        .run(
          attempts >= 5 ? 'failed' : 'pending',
          new Date(Date.now() + Math.min(3600, 2 ** attempts * 5) * 1000).toISOString(),
          error instanceof Error ? error.message.slice(0, 1000) : 'Unknown event error',
          job.id,
        );
    }
    return true;
  }

  private filterPayload(pluginId: string, payload: Readonly<Record<string, unknown>>) {
    const mayReadRepositories = this.plugins.hasCapability(pluginId, 'repositories.read');
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (
        mayReadRepositories &&
        ['repositoryId', 'owner', 'repository', 'visibility', 'branch', 'tag'].includes(key)
      )
        safe[key] = value;
    }
    return safe;
  }
}
