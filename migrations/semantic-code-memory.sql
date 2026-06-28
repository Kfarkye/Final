-- Phase 2: Semantic Code Memory
-- Enables pgvector extension if not already present
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE code_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner, name)
);

CREATE TABLE code_index_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES code_repositories(id),
  git_sha TEXT NOT NULL,
  branch TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  files_seen INTEGER DEFAULT 0,
  chunks_written INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE code_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES code_repositories(id),
  path TEXT NOT NULL,
  language TEXT,
  size_bytes BIGINT,
  sha256 TEXT NOT NULL,
  last_git_sha TEXT,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repository_id, path)
);

CREATE TABLE code_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES code_repositories(id),
  file_id UUID NOT NULL REFERENCES code_files(id),
  index_run_id UUID NOT NULL REFERENCES code_index_runs(id),

  path TEXT NOT NULL,
  language TEXT,
  symbol_name TEXT,
  symbol_kind TEXT,

  start_line INTEGER,
  end_line INTEGER,

  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,

  -- Assuming 1536 dimensions for the embedding model (e.g. text-embedding-3-small)
  embedding vector(1536),

  git_sha TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(repository_id, path, content_sha256, git_sha)
);

CREATE TABLE code_chunk_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id UUID NOT NULL REFERENCES code_chunks(id),
  reference_type TEXT NOT NULL,
  reference_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX code_files_repository_path_idx ON code_files(repository_id, path);
CREATE INDEX code_chunks_repository_path_idx ON code_chunks(repository_id, path);
CREATE INDEX code_chunks_git_sha_idx ON code_chunks(repository_id, git_sha);

-- Full text search index
CREATE INDEX code_chunks_content_search_idx ON code_chunks USING GIN (to_tsvector('english', content));

-- Vector index for fast similarity search
CREATE INDEX code_chunks_embedding_idx ON code_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
