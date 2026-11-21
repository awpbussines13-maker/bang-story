import Database from 'better-sqlite3'
import { dbPath } from '../paths'

let db: Database.Database | null = null

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    synopsis TEXT NOT NULL DEFAULT '',
    duration_sec INTEGER NOT NULL DEFAULT 60,
    language TEXT NOT NULL DEFAULT 'id',
    aspect_ratio TEXT NOT NULL DEFAULT '16:9',
    style_id TEXT NOT NULL DEFAULT 'stickman',
    tts_provider TEXT NOT NULL DEFAULT 'gemini',
    tts_voice TEXT NOT NULL DEFAULT 'Charon',
    image_model TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    step INTEGER NOT NULL DEFAULT 1,
    cover_asset_id TEXT,
    editor_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sheet_asset_id TEXT,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX characters_project ON characters(project_id);
  CREATE TABLE clips (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sort INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    visual_prompt TEXT NOT NULL DEFAULT '',
    narration TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 5000,
    character_ids TEXT NOT NULL DEFAULT '[]',
    motion_type TEXT NOT NULL DEFAULT 'camera',
    camera_preset TEXT NOT NULL DEFAULT 'zoomin',
    motion_strength TEXT NOT NULL DEFAULT 'halus',
    video_prompt TEXT NOT NULL DEFAULT '',
    transition TEXT NOT NULL DEFAULT 'fade',
    image_asset_id TEXT,
    video_asset_id TEXT,
    audio_asset_id TEXT
  );
  CREATE INDEX clips_project ON clips(project_id, sort);
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    clip_id TEXT,
    character_id TEXT,
    kind TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    prompt TEXT,
    remote_id TEXT,
    remote_url TEXT,
    local_path TEXT NOT NULL,
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX assets_project ON assets(project_id);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    clip_id TEXT,
    character_id TEXT,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    remote_id TEXT,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    message TEXT,
    error TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_asset_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_project ON jobs(project_id, status);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE secrets (
    provider TEXT PRIMARY KEY,
    value BLOB NOT NULL,
    last_ok INTEGER,
    last_message TEXT,
    checked_at INTEGER
  );
  `,
  `
  CREATE TABLE cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE projects ADD COLUMN video_model TEXT;
  `,
  // The script step sits between idea and storyboard, so later steps move up by one.
  `
  ALTER TABLE clips ADD COLUMN story TEXT NOT NULL DEFAULT '';
  ALTER TABLE clips ADD COLUMN visual_source TEXT;
  UPDATE projects SET step = step + 1 WHERE step >= 2;
  `,
  // Video resolution picked per project; null keeps the model's recommended one.
  `
  ALTER TABLE projects ADD COLUMN video_resolution TEXT;
  `,
  // Editor: camera over AI video, transition length, narration volume per clip.
  `
  ALTER TABLE clips ADD COLUMN video_camera TEXT NOT NULL DEFAULT 'static';
  ALTER TABLE clips ADD COLUMN video_strength TEXT NOT NULL DEFAULT 'halus';
  ALTER TABLE clips ADD COLUMN transition_ms INTEGER;
  ALTER TABLE clips ADD COLUMN voice_gain_db REAL NOT NULL DEFAULT 0;
  `,
  // Timeline editing: video in-point, voice trim and placement.
  `
  ALTER TABLE clips ADD COLUMN media_in_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clips ADD COLUMN voice_in_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clips ADD COLUMN voice_out_ms INTEGER;
  ALTER TABLE clips ADD COLUMN voice_start_ms INTEGER NOT NULL DEFAULT 0;
  `,
  // Script shape pinned by the user: scene count and seconds per scene. Null keeps the derived defaults.
  `
  ALTER TABLE projects ADD COLUMN scene_count INTEGER;
  ALTER TABLE projects ADD COLUMN scene_sec INTEGER;
  `,
  // Move the former default image model once, while allowing users to choose it again later.
  `
  UPDATE settings
  SET value = '"cf/@cf/black-forest-labs/flux-2-klein-9b"'
  WHERE key = 'nineRouterImageModel'
    AND value = '"ag/gemini-3.1-flash-image"';
  `,
  // Some deployed databases already recorded v9 before the model migration shipped.
  `
  UPDATE settings
  SET value = '"cf/@cf/black-forest-labs/flux-2-klein-9b"'
  WHERE key = 'nineRouterImageModel'
    AND value = '"ag/gemini-3.1-flash-image"';
  `,
  // Projects can override the image provider; null keeps using the app default.
  `
  ALTER TABLE projects ADD COLUMN image_provider TEXT;
  `,
  `
  CREATE TABLE atm_workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, channel_url TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'en', notes TEXT NOT NULL DEFAULT '', active_skill_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE atm_references (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES atm_workspaces(id) ON DELETE CASCADE, url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, thumbnail_url TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', transcript TEXT NOT NULL DEFAULT '', transcript_status TEXT NOT NULL DEFAULT 'missing', video_analysis TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', view_count INTEGER, published_at TEXT NOT NULL DEFAULT '', captured_at INTEGER NOT NULL);
  CREATE INDEX atm_references_workspace ON atm_references(workspace_id);
  CREATE TABLE atm_skills (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES atm_workspaces(id) ON DELETE CASCADE, version INTEGER NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, analysis TEXT NOT NULL DEFAULT '', source_ids TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT 'metadata', created_at INTEGER NOT NULL, UNIQUE(workspace_id,version));
  CREATE TABLE atm_productions (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES atm_workspaces(id), skill_id TEXT NOT NULL REFERENCES atm_skills(id), skill_snapshot TEXT NOT NULL, brief TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, outline_json TEXT, outline_hash TEXT, package_json TEXT, export_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(workspace_id,idempotency_key));
  CREATE INDEX atm_productions_workspace ON atm_productions(workspace_id);
  CREATE TABLE atm_tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES atm_workspaces(id), project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, reference_id TEXT, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, error TEXT, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(workspace_id,idempotency_key));
  CREATE INDEX atm_tasks_workspace ON atm_tasks(workspace_id,status);
  `,
  `
  CREATE TABLE character_reviews (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, input_hash TEXT NOT NULL, verdict TEXT NOT NULL, report_json TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX character_reviews_lookup ON character_reviews(clip_id,asset_id,input_hash,created_at);
  `,
  `
  CREATE TABLE atm_channel_identities (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES atm_workspaces(id), channel_id TEXT NOT NULL, version INTEGER NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(workspace_id,channel_id,version), UNIQUE(workspace_id,idempotency_key));
  ALTER TABLE atm_productions ADD COLUMN identity_snapshot TEXT;
  `,
  `
  CREATE TABLE atm_editorial_revisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, before_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(project_id,idempotency_key));
  `,
  `
  ALTER TABLE characters ADD COLUMN reference_prompt TEXT NOT NULL DEFAULT '';
  ALTER TABLE characters ADD COLUMN reference_image_asset_id TEXT;
  ALTER TABLE clips ADD COLUMN imported_image_asset_id TEXT;
  ALTER TABLE clips ADD COLUMN image_fit TEXT NOT NULL DEFAULT 'cover';
  `
]

export function getDb(): Database.Database {
  if (db) return db
  db = new Database(dbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const version = db.pragma('user_version', { simple: true }) as number
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db!.exec(MIGRATIONS[v])
      db!.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
