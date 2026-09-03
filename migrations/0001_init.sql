-- Cloudflare D1 Initial Migration

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    oauth_provider TEXT NOT NULL DEFAULT 'oauth',
    oauth_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Admin',
    custom_ai_endpoint TEXT,
    custom_ai_key TEXT,
    custom_ai_model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    is_deletable INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    subject TEXT,
    sender TEXT,
    recipient TEXT,
    cc TEXT,
    bcc TEXT,
    date TEXT,
    read INTEGER DEFAULT 0,
    starred INTEGER DEFAULT 0,
    body TEXT,
    in_reply_to TEXT,
    email_references TEXT,
    thread_id TEXT,
    message_id TEXT,
    raw_headers TEXT,
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    email_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_id TEXT,
    disposition TEXT,
    storage_key TEXT NOT NULL,
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mailboxes_user_id ON mailboxes(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_mailbox_id ON folders(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_folder ON emails(mailbox_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_thread ON emails(mailbox_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(mailbox_id, date);
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_mailbox_id ON attachments(mailbox_id);
