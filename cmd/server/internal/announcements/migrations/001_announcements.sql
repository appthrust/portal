CREATE TABLE portal_announcement (
    id text COLLATE "C" PRIMARY KEY,
    title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
    body text NOT NULL CHECK (octet_length(body) <= 20480),
    category text NOT NULL CHECK (category IN ('info', 'important', 'event')),
    pinned boolean NOT NULL,
    published_at timestamptz NOT NULL,
    expires_at timestamptz,
    author_subject text NOT NULL,
    author_name text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (expires_at IS NULL OR expires_at > published_at)
);

CREATE INDEX portal_announcement_order ON portal_announcement (pinned DESC, published_at DESC, id DESC);

CREATE TABLE portal_announcement_read (
    announcement_id text COLLATE "C" NOT NULL REFERENCES portal_announcement(id) ON DELETE CASCADE,
    subject text NOT NULL,
    PRIMARY KEY (announcement_id, subject)
);
