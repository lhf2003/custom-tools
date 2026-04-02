import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { NoteItemData, NoteContentData } from '../types';
import { AUTO_SAVE_DELAY } from '../constants';

const LS_SELECTED_NOTE = 'markdown:lastSelectedNote';
const LS_EXPANDED_FOLDERS = 'markdown:lastExpandedFolders';

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
  const [expandedFolders, setExpandedFoldersState] = useState<Set<string>>(loadExpandedFolders);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveContent = useRef<string | null>(null);

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

  // Load note content when selected
  useEffect(() => {
    if (!selectedNote) {
      setNoteContent(null);
      setEditorContent('');
      return;
    }

    const loadContent = async () => {
      try {
        const content = await invoke<NoteContentData>('read_note', { path: selectedNote });
        setNoteContent(content);
        setEditorContent(content.content);
      } catch (err) {
        console.error('Failed to load note:', err);
      }
    };

    loadContent();
  }, [selectedNote]);

  // Auto save with race condition fix
  useEffect(() => {
    if (!selectedNote || !noteContent || editorContent === noteContent.content) {
      return;
    }

    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
    }

    const contentToSave = editorContent;
    pendingSaveContent.current = contentToSave;

    autoSaveTimer.current = setTimeout(async () => {
      try {
        setIsSaving(true);
        await invoke('save_note', {
          request: { path: selectedNote, content: contentToSave },
        });
        // Only update if content hasn't changed since we started saving
        if (pendingSaveContent.current === contentToSave) {
          setNoteContent((prev) => (prev ? { ...prev, content: contentToSave } : null));
        }
      } catch (err) {
        console.error('Failed to save note:', err);
      } finally {
        setIsSaving(false);
      }
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
      }
    };
  }, [editorContent, selectedNote, noteContent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
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
    expandedFolders,
    setExpandedFolders,
    loadNoteTree,
    toggleFolder,
    getItemsAtPath,
  };
}
