import { randomUUID } from 'node:crypto';
import type { PluginLoader } from '@ethosagent/plugin-loader';
import { loadWidgetTemplates } from '@ethosagent/plugin-loader';
import Database from '@ethosagent/sqlite';
import { EthosError, type WidgetTemplate } from '@ethosagent/types';
import {
  assertSelectOnlySql,
  type DashboardImportPayload,
  findInvalidParamKeys,
  parseImportPayload,
} from './interpolate-params';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParamType = 'select' | 'options' | 'date-range';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  options?: string[];
  default: string;
}

export interface EmitRule {
  on: 'rowClick';
  param: string;
  column: string;
  default: string;
}

export interface Dashboard {
  id: string;
  userId: string;
  personalityId: string;
  title: string;
  description: string | null;
  cronSchedule: string | null;
  paramsSchema: ParamDef[];
  paramsCurrent: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardPanel {
  id: string;
  dashboardId: string;
  queryType: 'static' | 'prompt' | 'sql' | 'header';
  blockType: 'html' | 'image' | 'pdf' | 'text' | 'table';
  content: string;
  metadata: Record<string, unknown> | null;
  title: string | null;
  prompt: string | null;
  sqlQuery: string | null;
  pluginId: string | null;
  dataSourceId: string | null;
  renderHint: string | null;
  cronSchedule: string | null;
  htmlTemplate: string | null;
  emitConfig: EmitRule[] | null;
  dependsOn: string[] | null;
  paramDefaults: Record<string, string>;
  lastRunAt: number | null;
  lastError: string | null;
  sourceConversationId: string | null;
  sourceMessageSeq: number | null;
  col: number;
  row: number;
  w: number;
  h: number;
  createdAt: number;
  updatedAt: number;
}

export interface AddPanelInput {
  queryType: 'static' | 'prompt' | 'sql' | 'header';
  blockType: 'html' | 'image' | 'pdf' | 'text' | 'table';
  content: string;
  metadata?: Record<string, unknown>;
  title?: string;
  prompt?: string;
  sqlQuery?: string;
  pluginId?: string;
  dataSourceId?: string;
  renderHint?: string;
  cronSchedule?: string;
  htmlTemplate?: string;
  sourceConversationId?: string;
  sourceMessageSeq?: number;
}

export interface DashboardsServiceOptions {
  dbPath: string;
  pluginLoader?: PluginLoader;
}

// ---------------------------------------------------------------------------
// Default grid sizes by block type
// ---------------------------------------------------------------------------

const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  table: { w: 6, h: 4 },
  html: { w: 6, h: 5 },
  image: { w: 4, h: 4 },
  text: { w: 4, h: 3 },
  pdf: { w: 6, h: 6 },
};

const GRID_COLS = 12;

// ---------------------------------------------------------------------------
// Row helpers — map between snake_case DB rows and camelCase TS types
// ---------------------------------------------------------------------------

interface DashboardRow {
  id: string;
  user_id: string;
  personality_id: string;
  title: string;
  description: string | null;
  cron_schedule: string | null;
  params_schema: string | null;
  params_current: string | null;
  created_at: number;
  updated_at: number;
}

interface PanelRow {
  id: string;
  dashboard_id: string;
  query_type: string;
  block_type: string;
  content: string;
  metadata: string | null;
  title: string | null;
  prompt: string | null;
  sql_query: string | null;
  plugin_id: string | null;
  data_source_id: string | null;
  render_hint: string | null;
  cron_schedule: string | null;
  html_template: string | null;
  emit_config: string | null;
  depends_on: string | null;
  param_defaults: string | null;
  last_run_at: number | null;
  last_error: string | null;
  source_conversation_id: string | null;
  source_message_seq: number | null;
  col: number;
  row: number;
  w: number;
  h: number;
  created_at: number;
  updated_at: number;
}

function toDashboard(row: DashboardRow): Dashboard {
  let paramsSchema: ParamDef[] = [];
  if (row.params_schema) {
    try {
      paramsSchema = JSON.parse(row.params_schema) as ParamDef[];
    } catch {
      paramsSchema = [];
    }
  }
  let paramsCurrent: Record<string, string> = {};
  if (row.params_current) {
    try {
      paramsCurrent = JSON.parse(row.params_current) as Record<string, string>;
    } catch {
      paramsCurrent = {};
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    personalityId: row.personality_id,
    title: row.title,
    description: row.description,
    cronSchedule: row.cron_schedule,
    paramsSchema,
    paramsCurrent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPanel(row: PanelRow): DashboardPanel {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  let emitConfig: EmitRule[] | null = null;
  if (row.emit_config) {
    try {
      emitConfig = JSON.parse(row.emit_config) as EmitRule[];
    } catch {
      emitConfig = null;
    }
  }
  let dependsOn: string[] | null = null;
  if (row.depends_on) {
    try {
      dependsOn = JSON.parse(row.depends_on) as string[];
    } catch {
      dependsOn = null;
    }
  }
  let paramDefaults: Record<string, string> = {};
  if (row.param_defaults) {
    try {
      paramDefaults = JSON.parse(row.param_defaults) as Record<string, string>;
    } catch {
      paramDefaults = {};
    }
  }
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    queryType: row.query_type as DashboardPanel['queryType'],
    blockType: row.block_type as DashboardPanel['blockType'],
    content: row.content,
    metadata,
    title: row.title,
    prompt: row.prompt,
    sqlQuery: row.sql_query,
    pluginId: row.plugin_id,
    dataSourceId: row.data_source_id,
    renderHint: row.render_hint,
    cronSchedule: row.cron_schedule,
    htmlTemplate: row.html_template,
    emitConfig,
    dependsOn,
    paramDefaults,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    sourceConversationId: row.source_conversation_id,
    sourceMessageSeq: row.source_message_seq,
    col: row.col,
    row: row.row,
    w: row.w,
    h: row.h,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DashboardsService {
  private readonly db: Database.Database;
  private readonly pluginLoader?: PluginLoader;

  constructor(opts: DashboardsServiceOptions) {
    this.db = new Database(opts.dbPath);
    this.pluginLoader = opts.pluginLoader;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createTables();
  }

  /** Expose the underlying DB handle so callers (e.g. DashboardStore) can
   *  share a single connection instead of opening a duplicate. */
  getDb(): Database.Database {
    return this.db;
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dashboards (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        personality_id TEXT NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT,
        cron_schedule  TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS dashboard_panels (
        id                     TEXT PRIMARY KEY,
        dashboard_id           TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        query_type             TEXT NOT NULL CHECK(query_type IN ('static','prompt','sql','header')),
        block_type             TEXT NOT NULL CHECK(block_type IN ('html','image','pdf','text','table')),
        content                TEXT NOT NULL,
        metadata               TEXT,
        prompt                 TEXT,
        sql_query              TEXT,
        plugin_id              TEXT,
        data_source_id         TEXT,
        render_hint            TEXT,
        cron_schedule          TEXT,
        html_template          TEXT,
        last_run_at            INTEGER,
        last_error             TEXT,
        source_conversation_id TEXT,
        source_message_seq     INTEGER,
        title                  TEXT,
        col                    INTEGER NOT NULL DEFAULT 0,
        row                    INTEGER NOT NULL DEFAULT 0,
        w                      INTEGER NOT NULL DEFAULT 6,
        h                      INTEGER NOT NULL DEFAULT 4,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_dashboard_panels_dashboard
        ON dashboard_panels(dashboard_id, row, col);
    `);
    const panelCols = this.db.prepare('PRAGMA table_info(dashboard_panels)').all() as {
      name: string;
    }[];
    if (!panelCols.some((c) => c.name === 'html_template')) {
      this.db.exec('ALTER TABLE dashboard_panels ADD COLUMN html_template TEXT');
    }
    const dashCols = this.db.prepare('PRAGMA table_info(dashboards)').all() as { name: string }[];
    if (!dashCols.some((c) => c.name === 'cron_schedule')) {
      this.db.exec('ALTER TABLE dashboards ADD COLUMN cron_schedule TEXT');
    }
    if (!dashCols.some((c) => c.name === 'params_schema')) {
      this.db.exec('ALTER TABLE dashboards ADD COLUMN params_schema TEXT');
    }
    if (!dashCols.some((c) => c.name === 'params_current')) {
      this.db.exec('ALTER TABLE dashboards ADD COLUMN params_current TEXT');
    }
    if (!panelCols.some((c) => c.name === 'emit_config')) {
      this.db.exec('ALTER TABLE dashboard_panels ADD COLUMN emit_config TEXT');
    }
    if (!panelCols.some((c) => c.name === 'depends_on')) {
      this.db.exec('ALTER TABLE dashboard_panels ADD COLUMN depends_on TEXT');
    }
    if (!panelCols.some((c) => c.name === 'param_defaults')) {
      this.db.exec('ALTER TABLE dashboard_panels ADD COLUMN param_defaults TEXT');
    }
  }

  // -------------------------------------------------------------------------
  // Dashboard CRUD
  // -------------------------------------------------------------------------

  create(userId: string, title: string, personalityId: string, description?: string): Dashboard {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO dashboards (id, user_id, personality_id, title, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, personalityId, title, description ?? null, now, now);
    return {
      id,
      userId,
      personalityId,
      title,
      description: description ?? null,
      cronSchedule: null,
      paramsSchema: [],
      paramsCurrent: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  list(userId: string): Dashboard[] {
    const rows = this.db
      .prepare('SELECT * FROM dashboards WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as DashboardRow[];
    return rows.map(toDashboard);
  }

  get(id: string): { dashboard: Dashboard; panels: DashboardPanel[] } | null {
    const row = this.db.prepare('SELECT * FROM dashboards WHERE id = ?').get(id) as
      | DashboardRow
      | undefined;
    if (!row) return null;
    const panelRows = this.db
      .prepare('SELECT * FROM dashboard_panels WHERE dashboard_id = ? ORDER BY row, col')
      .all(id) as PanelRow[];
    return { dashboard: toDashboard(row), panels: panelRows.map(toPanel) };
  }

  update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      cronSchedule?: string | null;
      paramsSchema?: ParamDef[];
    },
  ): void {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(patch.description);
    }
    if (patch.cronSchedule !== undefined) {
      sets.push('cron_schedule = ?');
      params.push(patch.cronSchedule);
    }
    if (patch.paramsSchema !== undefined) {
      sets.push('params_schema = ?');
      params.push(JSON.stringify(patch.paramsSchema));
    }
    params.push(id);
    this.db.prepare(`UPDATE dashboards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM dashboards WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Panel CRUD
  // -------------------------------------------------------------------------

  addPanel(dashboardId: string, panel: AddPanelInput): DashboardPanel {
    // SQL validation
    if (panel.queryType === 'sql') {
      if (!panel.sqlQuery) {
        throw new Error('sqlQuery is required for sql query type');
      }
      assertSelectOnlySql(panel.sqlQuery);
    }

    const defaults = DEFAULT_SIZES[panel.blockType] ?? { w: 6, h: 4 };
    const { col, row } = this.nextGridPosition(dashboardId, defaults.w);
    const now = Date.now();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO dashboard_panels
         (id, dashboard_id, query_type, block_type, content, metadata, prompt, sql_query,
          plugin_id, data_source_id, render_hint, cron_schedule, html_template, source_conversation_id,
          source_message_seq, title, col, row, w, h, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        dashboardId,
        panel.queryType,
        panel.blockType,
        panel.content,
        panel.metadata ? JSON.stringify(panel.metadata) : null,
        panel.prompt ?? null,
        panel.sqlQuery ?? null,
        panel.pluginId ?? null,
        panel.dataSourceId ?? null,
        panel.renderHint ?? null,
        panel.cronSchedule ?? null,
        panel.htmlTemplate ?? null,
        panel.sourceConversationId ?? null,
        panel.sourceMessageSeq ?? null,
        panel.title ?? null,
        col,
        row,
        defaults.w,
        defaults.h,
        now,
        now,
      );

    return {
      id,
      dashboardId,
      queryType: panel.queryType,
      blockType: panel.blockType,
      content: panel.content,
      metadata: panel.metadata ?? null,
      title: panel.title ?? null,
      prompt: panel.prompt ?? null,
      sqlQuery: panel.sqlQuery ?? null,
      pluginId: panel.pluginId ?? null,
      dataSourceId: panel.dataSourceId ?? null,
      renderHint: panel.renderHint ?? null,
      cronSchedule: panel.cronSchedule ?? null,
      htmlTemplate: panel.htmlTemplate ?? null,
      emitConfig: null,
      dependsOn: null,
      paramDefaults: {},
      lastRunAt: null,
      lastError: null,
      sourceConversationId: panel.sourceConversationId ?? null,
      sourceMessageSeq: panel.sourceMessageSeq ?? null,
      col,
      row,
      w: defaults.w,
      h: defaults.h,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * RPC addPanel marshalling — resolve the target dashboard (creating one
   * when `newDashboardTitle` is given), then add the panel to it.
   */
  addPanelResolving(
    input: {
      dashboardId?: string | null;
      newDashboardTitle?: string;
      personalityId?: string;
      panel: AddPanelInput;
    },
    userId: string,
  ): DashboardPanel {
    let dashboardId = input.dashboardId;
    if (!dashboardId && input.newDashboardTitle) {
      dashboardId = this.create(
        userId,
        input.newDashboardTitle,
        input.personalityId ?? 'default',
      ).id;
    }
    if (!dashboardId) throw new Error('dashboardId or newDashboardTitle required');
    return this.addPanel(dashboardId, input.panel);
  }

  updatePanel(
    panelId: string,
    patch: {
      title?: string;
      cronSchedule?: string | null;
      queryType?: 'static' | 'prompt' | 'sql' | 'header';
      prompt?: string | null;
      sqlQuery?: string | null;
      pluginId?: string | null;
      dataSourceId?: string | null;
      htmlTemplate?: string | null;
      emitConfig?: EmitRule[] | null;
      dependsOn?: string[] | null;
      paramDefaults?: Record<string, string>;
    },
  ): void {
    // Vet on the persist condition, not on a sibling field: `queryType` and
    // `sqlQuery` are independently optional, so an existing sql panel can be
    // patched with `sqlQuery` alone, and a non-sql panel can be given sql text
    // now and flipped to `queryType: 'sql'` in a later patch. Either way the
    // text ends up executed by refreshSinglePanel, so any SQL text that is
    // about to be stored is vetted regardless of what else is in the patch.
    if (patch.sqlQuery) {
      assertSelectOnlySql(patch.sqlQuery);
    }
    if (patch.paramDefaults !== undefined) {
      // Panel paramDefaults is a resolution source for interpolateParams, so it
      // is a SQL-injection sink like dashboard params. Vet it against the
      // owning dashboard's schema before persisting.
      const panel = this.getPanel(panelId);
      const schema = panel ? (this.get(panel.dashboardId)?.dashboard.paramsSchema ?? []) : [];
      const invalid = findInvalidParamKeys(schema, patch.paramDefaults);
      if (invalid.length > 0) {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `Dashboard param value(s) not permitted by the parameter schema: ${invalid.join(', ')}`,
          action:
            'Submit only values allowed by each parameter definition (a listed option, or a YYYY-MM-DD date).',
        });
      }
    }
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.cronSchedule !== undefined) {
      sets.push('cron_schedule = ?');
      params.push(patch.cronSchedule);
    }
    if (patch.queryType !== undefined) {
      sets.push('query_type = ?');
      params.push(patch.queryType);
    }
    if (patch.prompt !== undefined) {
      sets.push('prompt = ?');
      params.push(patch.prompt);
    }
    if (patch.sqlQuery !== undefined) {
      sets.push('sql_query = ?');
      params.push(patch.sqlQuery);
    }
    if (patch.pluginId !== undefined) {
      sets.push('plugin_id = ?');
      params.push(patch.pluginId);
    }
    if (patch.dataSourceId !== undefined) {
      sets.push('data_source_id = ?');
      params.push(patch.dataSourceId);
    }
    if (patch.htmlTemplate !== undefined) {
      sets.push('html_template = ?');
      params.push(patch.htmlTemplate);
    }
    if (patch.emitConfig !== undefined) {
      sets.push('emit_config = ?');
      params.push(patch.emitConfig ? JSON.stringify(patch.emitConfig) : null);
    }
    if (patch.dependsOn !== undefined) {
      sets.push('depends_on = ?');
      params.push(patch.dependsOn ? JSON.stringify(patch.dependsOn) : null);
    }
    if (patch.paramDefaults !== undefined) {
      sets.push('param_defaults = ?');
      params.push(JSON.stringify(patch.paramDefaults));
    }
    params.push(panelId);
    this.db.prepare(`UPDATE dashboard_panels SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  updatePanelLayout(
    panelId: string,
    layout: { col: number; row: number; w: number; h: number },
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE dashboard_panels SET col = ?, row = ?, w = ?, h = ?, updated_at = ? WHERE id = ?',
      )
      .run(layout.col, layout.row, layout.w, layout.h, now, panelId);
  }

  updatePanelContent(panelId: string, content: string, blockType?: string): void {
    const now = Date.now();
    if (blockType) {
      this.db
        .prepare(
          'UPDATE dashboard_panels SET content = ?, block_type = ?, updated_at = ? WHERE id = ?',
        )
        .run(content, blockType, now, panelId);
    } else {
      this.db
        .prepare('UPDATE dashboard_panels SET content = ?, updated_at = ? WHERE id = ?')
        .run(content, now, panelId);
    }
  }

  setPanelError(panelId: string, error: string): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE dashboard_panels SET last_error = ?, last_run_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(error, now, now, panelId);
  }

  clearPanelError(panelId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE dashboard_panels SET last_error = NULL, last_run_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(now, now, panelId);
  }

  deletePanel(panelId: string): void {
    this.db.prepare('DELETE FROM dashboard_panels WHERE id = ?').run(panelId);
  }

  getPanel(panelId: string): DashboardPanel | null {
    const row = this.db.prepare('SELECT * FROM dashboard_panels WHERE id = ?').get(panelId) as
      | PanelRow
      | undefined;
    return row ? toPanel(row) : null;
  }

  listLivePanels(dashboardId: string): DashboardPanel[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM dashboard_panels WHERE dashboard_id = ? AND query_type NOT IN ('static', 'header') ORDER BY row, col",
      )
      .all(dashboardId) as PanelRow[];
    return rows.map(toPanel);
  }

  // -------------------------------------------------------------------------
  // Params
  // -------------------------------------------------------------------------

  updateDashboardParams(id: string, paramsCurrent: Record<string, string>): void {
    // Validate every incoming (key, value) against the dashboard's param schema
    // before persisting. These values later flow into `interpolateParams` and
    // are spliced into a user-authored SQL/prompt template, so a value that
    // escapes its definition's allowlist is a SQL-injection vector. Rejecting
    // unknown params (no matching def) keeps this a strict allowlist.
    const schema = this.get(id)?.dashboard.paramsSchema ?? [];
    const invalid = findInvalidParamKeys(schema, paramsCurrent);
    if (invalid.length > 0) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Dashboard param value(s) not permitted by the parameter schema: ${invalid.join(', ')}`,
        action:
          'Submit only values allowed by each parameter definition (a listed option, or a YYYY-MM-DD date).',
      });
    }
    const now = Date.now();
    this.db
      .prepare('UPDATE dashboards SET params_current = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(paramsCurrent), now, id);
  }

  updatePanelParamDefaults(panelId: string, values: Record<string, string>): void {
    const row = this.db
      .prepare('SELECT param_defaults FROM dashboard_panels WHERE id = ?')
      .get(panelId) as { param_defaults: string | null } | undefined;
    const existing = row?.param_defaults
      ? (JSON.parse(row.param_defaults) as Record<string, string>)
      : {};
    const merged = { ...existing, ...values };
    const now = Date.now();
    this.db
      .prepare('UPDATE dashboard_panels SET param_defaults = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), now, panelId);
  }

  // -------------------------------------------------------------------------
  // Export / Import
  // -------------------------------------------------------------------------

  exportDashboard(id: string): object | null {
    const result = this.get(id);
    if (!result) return null;
    const { dashboard, panels } = result;

    // Build dependencies from panels
    const depMap = new Map<string, { pluginId: string; dataSourceId: string; titles: string[] }>();
    for (const p of panels) {
      if (p.pluginId && p.dataSourceId) {
        const key = `${p.pluginId}:${p.dataSourceId}`;
        const entry = depMap.get(key);
        if (entry) {
          entry.titles.push(p.title ?? '(untitled)');
        } else {
          depMap.set(key, {
            pluginId: p.pluginId,
            dataSourceId: p.dataSourceId,
            titles: [p.title ?? '(untitled)'],
          });
        }
      }
    }

    const dependencies = [...depMap.values()].map((d) => ({
      type: 'plugin' as const,
      pluginId: d.pluginId,
      dataSourceId: d.dataSourceId,
      requiredBy: d.titles,
    }));

    // Build panel ID to index map for dependsOn remapping
    const idToIndex = new Map(panels.map((p, i) => [p.id, i]));

    const exportPanels = panels.map((p) => ({
      title: p.title,
      queryType: p.queryType,
      blockType: p.blockType,
      content: p.content,
      prompt: p.prompt,
      sqlQuery: p.sqlQuery,
      pluginId: p.pluginId,
      dataSourceId: p.dataSourceId,
      cronSchedule: p.cronSchedule,
      htmlTemplate: p.htmlTemplate,
      emitConfig: p.emitConfig,
      dependsOnIndices: (p.dependsOn ?? [])
        .map((depId) => idToIndex.get(depId) ?? -1)
        .filter((i) => i >= 0),
      paramDefaults: p.paramDefaults,
      col: p.col,
      row: p.row,
      w: p.w,
      h: p.h,
    }));

    return {
      version: 1,
      title: dashboard.title,
      dependencies,
      paramsSchema: dashboard.paramsSchema,
      paramsCurrent: dashboard.paramsCurrent,
      cronSchedule: dashboard.cronSchedule,
      panels: exportPanels,
    };
  }

  /**
   * Insert a validated dashboard-import payload. Callers MUST pass a payload
   * that has been through `parseImportPayload` (see `importDashboardJson`),
   * which safeParses the structure and vets every SQL query + param sink.
   */
  importDashboard(
    data: DashboardImportPayload,
    userId: string,
    personalityId: string,
  ): { dashboardId: string; warnings: string[] } {
    const now = Date.now();
    const dashId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO dashboards (id, user_id, personality_id, title, description, params_schema, params_current, cron_schedule, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dashId,
        userId,
        personalityId,
        data.title ?? 'Imported Dashboard',
        null,
        data.paramsSchema ? JSON.stringify(data.paramsSchema) : null,
        data.paramsCurrent ? JSON.stringify(data.paramsCurrent) : null,
        data.cronSchedule ?? null,
        now,
        now,
      );

    // Create panels, collecting new IDs
    const panels = data.panels ?? [];
    const newPanelIds: string[] = [];
    for (const p of panels) {
      const panelId = randomUUID();
      newPanelIds.push(panelId);
      this.db
        .prepare(
          `INSERT INTO dashboard_panels
           (id, dashboard_id, query_type, block_type, content, prompt, sql_query,
            plugin_id, data_source_id, cron_schedule, html_template, title,
            emit_config, param_defaults,
            col, row, w, h, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          panelId,
          dashId,
          p.queryType ?? 'static',
          p.blockType ?? 'html',
          p.content ?? '',
          p.prompt ?? null,
          p.sqlQuery ?? null,
          p.pluginId ?? null,
          p.dataSourceId ?? null,
          p.cronSchedule ?? null,
          p.htmlTemplate ?? null,
          p.title ?? null,
          p.emitConfig ? JSON.stringify(p.emitConfig) : null,
          p.paramDefaults ? JSON.stringify(p.paramDefaults) : null,
          p.col ?? 0,
          p.row ?? 0,
          p.w ?? 6,
          p.h ?? 4,
          now,
          now,
        );
    }

    // Remap dependsOnIndices to new panel UUIDs
    for (let i = 0; i < panels.length; i++) {
      const indices = panels[i]?.dependsOnIndices ?? [];
      if (indices.length > 0) {
        const depIds = indices
          .map((idx) => newPanelIds[idx])
          .filter((id): id is string => id !== undefined);
        if (depIds.length > 0) {
          const pid = newPanelIds[i];
          if (pid) {
            this.db
              .prepare('UPDATE dashboard_panels SET depends_on = ? WHERE id = ?')
              .run(JSON.stringify(depIds), pid);
          }
        }
      }
    }

    const warnings: string[] = [];
    return { dashboardId: dashId, warnings };
  }

  /** RPC exportDashboard marshalling — serialize the export payload. */
  exportDashboardJson(id: string): { json: string; panelCount: number; title: string } | null {
    const result = this.exportDashboard(id);
    if (!result) return null;
    const panels = (result as { panels?: unknown[] }).panels ?? [];
    return {
      json: JSON.stringify(result),
      panelCount: panels.length,
      title: (result as { title: string }).title,
    };
  }

  /** RPC importDashboard marshalling — parse the export JSON and import it. */
  importDashboardJson(
    exportJson: string,
    userId: string,
  ): { dashboardId: string; title: string; warnings: string[] } {
    let raw: unknown;
    try {
      raw = JSON.parse(exportJson);
    } catch {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'Dashboard import JSON is malformed',
        action: 'Provide the exact JSON produced by dashboard export.',
      });
    }
    const data = parseImportPayload(raw);
    const result = this.importDashboard(data, userId, data.personalityId ?? 'default');
    return {
      dashboardId: result.dashboardId,
      title: data.title ?? 'Imported Dashboard',
      warnings: result.warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Widget templates — delegates to plugin loader (stub for now)
  // -------------------------------------------------------------------------

  async listWidgetTemplates(): Promise<WidgetTemplate[]> {
    if (!this.pluginLoader) return [];
    const manifests = this.pluginLoader.listManifests();
    const templates: WidgetTemplate[] = [];
    for (const m of manifests) {
      if (!m.hasWidgets) continue;
      const pluginDir = this.pluginLoader.getPluginPath(m.id);
      if (!pluginDir) continue;
      templates.push(...loadWidgetTemplates(pluginDir, m.id));
    }
    return templates;
  }

  // -------------------------------------------------------------------------
  // Grid placement
  // -------------------------------------------------------------------------

  private nextGridPosition(dashboardId: string, panelWidth: number): { col: number; row: number } {
    const rows = this.db
      .prepare(
        'SELECT col, row, w, h FROM dashboard_panels WHERE dashboard_id = ? ORDER BY row DESC, col DESC',
      )
      .all(dashboardId) as Array<{ col: number; row: number; w: number; h: number }>;

    if (rows.length === 0) {
      return { col: 0, row: 0 };
    }

    // Find the maximum row bottom
    let maxRowBottom = 0;
    for (const r of rows) {
      const bottom = r.row + r.h;
      if (bottom > maxRowBottom) maxRowBottom = bottom;
    }

    // Build an occupancy set for quick lookup
    const occupied = new Set<string>();
    for (const r of rows) {
      for (let c = r.col; c < r.col + r.w; c++) {
        for (let ry = r.row; ry < r.row + r.h; ry++) {
          occupied.add(`${c},${ry}`);
        }
      }
    }

    // Scan row by row, left to right, looking for space
    for (let ry = 0; ry <= maxRowBottom; ry++) {
      for (let c = 0; c <= GRID_COLS - panelWidth; c++) {
        let fits = true;
        for (let dc = 0; dc < panelWidth; dc++) {
          if (occupied.has(`${c + dc},${ry}`)) {
            fits = false;
            break;
          }
        }
        if (fits) return { col: c, row: ry };
      }
    }

    // No space found in existing rows — place on the next row
    return { col: 0, row: maxRowBottom };
  }
}

/**
 * RPC summarizePrompt marshalling — condense a conversation into a prompt
 * the dashboard panel can replay to produce the same kind of output.
 */
export function buildPromptSummary(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (text.length > 500) {
      parts.push(`${role}: ${text.slice(0, 500)}...`);
    } else {
      parts.push(`${role}: ${text}`);
    }
  }
  return `Based on the following conversation, produce the same kind of output:\n\n${parts.join('\n\n')}`;
}

/**
 * Execute a read-only SQL query against a plugin data source.
 */
export async function runPluginQuery(
  pluginLoader: { getDataSourcePath(pluginId: string, sourceId: string): string | null },
  pluginId: string,
  sourceId: string,
  sql: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const dbPath = pluginLoader.getDataSourcePath(pluginId, sourceId);
  if (!dbPath) {
    throw new Error(`Data source '${sourceId}' not registered by plugin '${pluginId}'`);
  }

  // Reject mutating SQL
  const trimmed = sql.trim().toUpperCase();
  const MUTATING = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'PRAGMA', 'ATTACH'];
  for (const kw of MUTATING) {
    if (trimmed.startsWith(kw)) {
      throw new Error(`Mutating SQL not allowed: ${kw}`);
    }
  }

  const { default: Database } = await import('@ethosagent/sqlite');
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
    return { columns, rows };
  } finally {
    db.close();
  }
}
