# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Windows productivity tool built with **Tauri** (Rust + React/TypeScript), similar to uTools. It provides a launcher with fuzzy app search, clipboard history, password manager, markdown notes, and quick tools.

## Common Commands

### Development
```bash
# Start the Tauri development server (runs both frontend and backend)
npm run tauri:dev

# Start only the Vite dev server (frontend only, useful for UI work)
npm run dev

# Build the production application
npm run tauri:build
```

### Rust Backend
```bash
cd src-tauri

# Build the Rust code
cargo build

# Build for release
cargo build --release

# Run clippy (linting)
cargo clippy

# Run Rust tests
cargo test
```

### Frontend
```bash
# Install dependencies
npm install

# Build frontend only
npm run build

# Run ESLint
npm run lint

# Type check
npx tsc --noEmit
```

## Architecture

### Project Structure

```
├── src/                          # Frontend (React + TypeScript)
│   ├── modules/                  # Feature modules
│   │   ├── launcher/            # App launcher with fuzzy search
│   │   ├── clipboard/           # Clipboard history UI
│   │   ├── password/            # Password manager UI
│   │   ├── markdown/            # Markdown notes UI
│   │   └── settings/            # Settings UI
│   ├── stores/                  # Zustand state management
│   └── hooks/                   # React hooks
│
├── src-tauri/                   # Backend (Rust)
│   └── src/
│       ├── lib.rs               # App entry point, plugin init, shortcuts
│       ├── clipboard/           # Clipboard watcher (Windows API)
│       ├── password/            # Password encryption (AES-GCM)
│       ├── notes/               # File-based notes storage
│       ├── search/              # App indexing and fuzzy search (nucleo)
│       ├── settings/            # SQLite settings storage
│       ├── db/                  # SQLite database initialization
│       └── commands/            # Tauri command handlers (bridged to frontend)
│
└── docs/                        # Documentation and roadmaps
```

### Key Architecture Patterns

**Plugin System**: Each feature is a self-contained module with both frontend (`src/modules/`) and backend (`src-tauri/src/`) components.

**State Management**:
- Frontend: Zustand stores in `src/stores/`
- Backend: Tauri-managed state via `app.manage()` in `lib.rs`

**Database**: SQLite with rusqlite. Schema defined in `src-tauri/src/db/mod.rs`. Key tables:
- `clipboard_history` - Stores clipboard items with content hash deduplication
- `password_entries` - Encrypted passwords
- `notes` - Metadata for file-based notes
- `app_usage` - Tracks app launch frequency for search ranking
- `settings` - User preferences

**Global Shortcuts**: Registered in `lib.rs::register_shortcuts()`. Default: `Ctrl+Shift+Space` to toggle window visibility.

**Window Behavior**:
- Frameless transparent window
- Always on top (configurable)
- Hides on blur (configurable)
- Positioned at top of screen when shown

## Technology Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, Zustand
- **Backend**: Rust, Tauri 2.0, tokio
- **Search**: nucleo (fuzzy matcher)
- **Crypto**: AES-GCM for passwords, PBKDF2 for key derivation
- **Storage**: SQLite (bundled), file system for notes and images

## Important Files

- `src-tauri/tauri.conf.json` - Tauri window config, bundle settings
- `src-tauri/Cargo.toml` - Rust dependencies
- `src-tauri/src/lib.rs` - Main app setup, command registration
- `src/App.tsx` - Main view router
- `docs/roadmap.md` - Feature roadmap and technical designs

## Notes for Development

- The clipboard watcher uses Windows API (`windows` crate) for monitoring clipboard changes
- App search uses `nucleo` for fuzzy matching and indexes Start Menu + Desktop shortcuts
- Password manager requires unlock with master password; uses AES-GCM encryption
- Notes are stored as files on disk with metadata in SQLite
- The search roadmap includes plans for usage-based ranking (P1) and Everything integration (P3)
