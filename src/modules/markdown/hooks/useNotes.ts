import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { NoteItemData, NoteContentData } from '../types';
import { AUTO_SAVE_DELAY } from '../constants';

const LS_SELECTED_NOTE = 'markdown:lastSelectedNote';
const LS_EXPANDED_FOLDERS = 'markdown:lastExpandedFolders';
const SAVE_RETRY_DELAYS = [3000, 8000];

function loadSelectedNote(): string | null {
  try {
    return localStorage.getItem(LS_SELECTED_NOTE);
  } catch {
    return null;
  }
}

function saveSelectedNote(path: string | null) {
  try {
    if (path) {
      localStorage.setItem(LS_SELECTED_NOTE, path);
    } else {
      localStorage.removeItem(LS_SELECTED_NOTE);
    }
  } catch {
    // ignore
  }
}

function loadExpandedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_EXPANDED_FOLDERS);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveExpandedFolders(folders: Set<string>) {
  try {
    localStorage.setItem(LS_EXPANDED_FOLDERS, JSON.stringify(Array.from(folders)));
  } catch {
    // ignore
  }
}

// Build a flattened path-to-items map for O(1) lookups
function buildPathIndex(items: NoteItemData[]): Map<string, NoteItemData[]> {
  const index = new Map<string, NoteItemData[]>();

  function traverse(items: NoteItemData[], parentPath: string) {
    index.set(parentPath, items);
    for (const item of items) {
      if (item.children && item.children.length > 0) {
        traverse(item.children, item.path);
      }
    }
  }

  traverse(items, '');
  return index;
}

export function useNotes() {
  const [notes, setNotes] = useState<NoteItemData[]>([]);
  const [selectedNote, setSelectedNoteState] = useState<string | null>(loadSelectedNote);
  const [noteContent, setNoteContent] = useState<NoteContentData | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFoldersState] = useState<Set<string>>(loadExpandedFolders);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const pendingSave = useRef<{ path: string; content: string } | null>(null);

  const setSelectedNote = useCallback((path: string | null) => {
    setSelectedNoteState(path);
    saveSelectedNote(path);
  }, []);

  const setExpandedFolders = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setExpandedFoldersState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveExpandedFolders(next);
      return next;
    });
  }, []);

  // Load note tree
  const loadNoteTree = useCallback(async () => {
    try {
      setIsLoading(true);
      const tree = await invoke<NoteItemData[]>('get_note_tree');
      setNotes(tree);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载笔记失败');
      console.error('Failed to load note tree:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNoteTree();
  }, [loadNoteTree]);

  // Save note content with a stale-write guard; on failure surfaces saveError and retries with backoff
  const performSaveRef = useRef<(path: string, content: string) => Promise<void>>(async () => {});
  const performSave = useCallback(async (path: string, content: string) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await invoke('save_note', {
        request: { path, content },
      });
      // Only clear pending if this save is still the latest intent
      if (pendingSave.current?.path === path && pendingSave.current.content === content) {
        pendingSave.current = null;
      }
      setNoteContent((prev) => (prev && prev.path === path ? { ...prev, content } : prev));
      retryCount.current = 0;
    } catch (err) {
      console.error('Failed to save note:', err);
      setSaveError(err instanceof Error ? err.message : '保存失败');
      // Automatic retry with backoff, guarded by the latest pending intent
      if (retryCount.current < SAVE_RETRY_DELAYS.length) {
        const delay = SAVE_RETRY_DELAYS[retryCount.current++];
        if (retryTimer.current) {
          clearTimeout(retryTimer.current);
        }
        retryTimer.current = setTimeout(() => {
          const pending = pendingSave.current;
          if (pending?.path === path && pending.content === content) {
            void performSaveRef.current(path, content);
          }
        }, delay);
      }
    } finally {
      setIsSaving(false);
    }
  }, []);

  // Keep the ref pointing at the latest performSave for the retry timer
  useEffect(() => {
    performSaveRef.current = performSave;
  }, [performSave]);

  const loadNoteContent = useCallback(async (path: string) => {
    setContentError(null);
    try {
      const content = await invoke<NoteContentData>('read_note', { path });
      setNoteContent(content);
      setEditorContent(content.content);
    } catch (err) {
      // The file may have been removed externally — surface it in the editor area
      console.error('Failed to load note:', err);
      setNoteContent(null);
      setContentError(err instanceof Error ? err.message : '加载笔记内容失败');
    }
  }, []);

  // Load note content when selected
  useEffect(() => {
    // Flush the previous note's pending save before switching away from it
    const pending = pendingSave.current;
    if (pending && pending.path !== selectedNote) {
      void performSave(pending.path, pending.content);
    }
    setSaveError(null);
    retryCount.current = 0;

    if (!selectedNote) {
      setNoteContent(null);
      setEditorContent('');
      setContentError(null);
      return;
    }

    void loadNoteContent(selectedNote);
  }, [selectedNote, loadNoteContent, performSave]);

  // Auto save with race condition fix
  useEffect(() => {
    // Guard against the stale pair while the newly selected note is still loading
    if (!selectedNote || !noteContent || noteContent.path !== selectedNote) {
      return;
    }
    if (editorContent === noteContent.content) {
      return;
    }

    pendingSave.current = { path: selectedNote, content: editorContent };

    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
    }

    autoSaveTimer.current = setTimeout(() => {
      const pending = pendingSave.current;
      if (pending) {
        void performSave(pending.path, pending.content);
      }
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
      }
    };
  }, [editorContent, selectedNote, noteContent, performSave]);

  // Flush pending save and clear timers on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
      }
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
      }
      const pending = pendingSave.current;
      if (pending) {
        invoke('save_note', {
          request: { path: pending.path, content: pending.content },
        }).catch((err) => console.error('Failed to flush save on unmount:', err));
      }
    };
  }, []);

  // Build flattened path index for O(1) lookups
  const pathIndex = useMemo(() => buildPathIndex(notes), [notes]);

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // O(1) lookup using path index instead of O(n) recursive search
  const getItemsAtPath = useCallback((parentPath: string): NoteItemData[] => {
    return pathIndex.get(parentPath) || [];
  }, [pathIndex]);

  // Manual retry for a failed save (auto-retry budget is reset)
  const retrySave = useCallback(() => {
    const pending = pendingSave.current;
    if (pending) {
      retryCount.current = 0;
      void performSave(pending.path, pending.content);
    }
  }, [performSave]);

  return {
    notes,
    setNotes,
    selectedNote,
    setSelectedNote,
    noteContent,
    setNoteContent,
    editorContent,
    setEditorContent,
    isLoading,
    isSaving,
    error,
    setError,
    saveError,
    contentError,
    retrySave,
    loadNoteContent,
    expandedFolders,
    setExpandedFolders,
    loadNoteTree,
    toggleFolder,
    getItemsAtPath,
  };
}
