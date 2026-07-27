import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FileText, Plus, Folder, Loader2, Search, Maximize2, Minimize2, Download, Pencil, X } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { NoteItemData, CreateNoteRequest } from './types';
import { useNotes } from './hooks/useNotes';
import { Modal, EmptyState, SortableNoteTree, ErrorBoundary, VditorEditor, ContextMenu, MenuIcons, DeleteConfirmDialog } from './components';
import { exportNoteAsImage } from './utils/export';
import type { MenuItem } from './components/ContextMenu';
import { THEME } from '@/constants/theme';
import { WINDOW_SIZE } from '@/constants/window';
import { immediateResize } from '@/utils/tauri';
import { useAppStore } from '@/stores/appStore';

// Count notes contained in a tree item (recursive for folders)
function countFolderNotes(item: NoteItemData): number {
  if (!item.is_folder) return 1;
  return (item.children ?? []).reduce((sum, child) => sum + countFolderNotes(child), 0);
}

export function MarkdownView() {
  // Resize window when view mounts
  useEffect(() => {
    immediateResize(WINDOW_SIZE.MARKDOWN.height, WINDOW_SIZE.MARKDOWN.width);
  }, []);

  const {
    notes,
    selectedNote,
    setSelectedNote,
    noteContent,
    editorContent,
    setEditorContent,
    isLoading,
    isSaving,
    error,
    saveError,
    retrySave,
    contentError,
    loadNoteContent,
    expandedFolders,
    setExpandedFolders,
    loadNoteTree,
    toggleFolder,
  } = useNotes();

  // 打开外部指定的笔记（如陪伴设置「在笔记中查看」→ 陪伴日报/备忘.md）
  const pendingOpenNotePath = useAppStore((s) => s.pendingOpenNotePath);
  useEffect(() => {
    if (!pendingOpenNotePath) return;
    useAppStore.getState().setPendingOpenNotePath(null);
    const parent = pendingOpenNotePath.split('/').slice(0, -1).join('/');
    if (parent) {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(parent);
        return next;
      });
    }
    setSelectedNote(pendingOpenNotePath);
  }, [pendingOpenNotePath, setSelectedNote, setExpandedFolders]);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'folder'>('file');
  const [createPath, setCreatePath] = useState('');
  const [createParent, setCreateParent] = useState('');

  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameItem, setRenameItem] = useState<NoteItemData | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Operation-level errors surface as an inline bar and never replace the tree
  const [operationError, setOperationError] = useState<string | null>(null);

  // Delete confirmation target — replaces native confirm()
  const [deleteTarget, setDeleteTarget] = useState<NoteItemData | null>(null);

  const handleCreate = async () => {
    if (!createPath.trim()) return;

    setOperationError(null);
    try {
      const fullPath = createParent ? `${createParent}/${createPath}` : createPath;

      await invoke('create_note', {
        request: { path: fullPath, is_folder: createType === 'folder' } as CreateNoteRequest,
      });

      setShowCreateModal(false);
      setCreatePath('');
      setCreateParent('');
      loadNoteTree();

      if (createType === 'file') {
        const selectedPath = fullPath.endsWith('.md') ? fullPath : `${fullPath}.md`;
        setSelectedNote(selectedPath);
      }
    } catch (err) {
      console.error('Failed to create:', err);
      setOperationError(`创建失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const handleRename = async () => {
    if (!renameItem || !renameValue.trim()) return;

    setOperationError(null);
    try {
      // 确保文件名以 .md 结尾
      let finalName = renameValue.trim();
      if (!finalName.endsWith('.md')) {
        finalName += '.md';
      }

      const newPath = await invoke<string>('rename_note', {
        request: { old_path: renameItem.path, new_name: finalName },
      });

      setShowRenameModal(false);
      setRenameItem(null);
      setRenameValue('');
      loadNoteTree();

      if (selectedNote === renameItem.path) {
        setSelectedNote(newPath);
      }
    } catch (err) {
      console.error('Failed to rename:', err);
      setOperationError(`重命名失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const requestDelete = useCallback((item: NoteItemData) => {
    setOperationError(null);
    setDeleteTarget(item);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);

    try {
      await invoke('delete_note', { path: target.path });

      // Clear selection if the open note was deleted directly or inside a deleted folder
      if (
        selectedNote === target.path ||
        (target.is_folder && selectedNote?.startsWith(`${target.path}/`))
      ) {
        setSelectedNote(null);
      }

      loadNoteTree();
    } catch (err) {
      console.error('Failed to delete:', err);
      setOperationError(`删除失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  }, [deleteTarget, selectedNote, setSelectedNote, loadNoteTree]);

  const handleMove = async (sourcePath: string, targetFolder: string) => {
    setOperationError(null);
    try {
      await invoke('move_note', {
        request: {
          source_path: sourcePath,
          target_folder: targetFolder,
        },
      });
      loadNoteTree();
    } catch (err: unknown) {
      console.error('Failed to move note:', err);
      setOperationError(`移动笔记失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const handleReorder = async (parentPath: string, itemNames: string[]) => {
    setOperationError(null);
    try {
      await invoke('reorder_notes', {
        request: {
          parent_path: parentPath,
          item_names: itemNames,
        },
      });
      loadNoteTree();
    } catch (err: unknown) {
      console.error('Failed to reorder notes:', err);
      setOperationError(`排序更新失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const openCreateModal = useCallback((type: 'file' | 'folder', parent: string = '') => {
    setCreateType(type);
    setCreateParent(parent);
    setCreatePath('');
    setShowCreateModal(true);
  }, [setCreateType, setCreateParent, setCreatePath, setShowCreateModal]);

  // Listen for menu actions from navigation bar (must be after openCreateModal)
  useEffect(() => {
    const handleNewNote = () => openCreateModal('file');
    const handleNewFolder = () => openCreateModal('folder');

    window.addEventListener('markdown:new-note', handleNewNote);
    window.addEventListener('markdown:new-folder', handleNewFolder);

    return () => {
      window.removeEventListener('markdown:new-note', handleNewNote);
      window.removeEventListener('markdown:new-folder', handleNewFolder);
    };
  }, [openCreateModal]);

  // Editor fullscreen state - hides sidebar when true
  const [isEditorFullscreen, setIsEditorFullscreen] = useState(false);

  // View-level shortcuts: Ctrl+N new note, Ctrl+F focus search
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== 'n' && key !== 'f') return;

      // Don't disturb modal flows
      if (showCreateModal || showRenameModal || deleteTarget) return;

      const target = e.target as HTMLElement;

      if (key === 'n') {
        e.preventDefault();
        openCreateModal('file');
      } else if (key === 'f') {
        // Let the editor keep its own find while typing inside it
        if (target.isContentEditable) return;
        if (isEditorFullscreen) return;
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCreateModal, showRenameModal, deleteTarget, isEditorFullscreen, openCreateModal]);

  // Export state
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Empty area context menu state
  const [emptyAreaMenu, setEmptyAreaMenu] = useState<{
    visible: boolean;
    position: { x: number; y: number };
    parentPath: string;
  }>({
    visible: false,
    position: { x: 0, y: 0 },
    parentPath: '',
  });

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    const flatten = (items: NoteItemData[]): NoteItemData[] =>
      items.flatMap((item) => [
        ...(!item.is_folder ? [item] : []),
        ...(item.children ? flatten(item.children) : []),
      ]);
    return flatten(notes).filter((item) => item.name.toLowerCase().includes(query));
  }, [searchQuery, notes]);

  // Search keyboard flow: Enter opens first result, ArrowDown moves into results, Esc clears
  const firstResultRef = useRef<HTMLButtonElement>(null);
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && searchResults.length > 0) {
        e.preventDefault();
        setSelectedNote(searchResults[0].path);
      } else if (e.key === 'ArrowDown' && searchResults.length > 0) {
        e.preventDefault();
        firstResultRef.current?.focus();
      } else if (e.key === 'Escape' && searchQuery) {
        e.preventDefault();
        setSearchQuery('');
      }
    },
    [searchResults, searchQuery, setSelectedNote]
  );

  const [editingTitle, setEditingTitle] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);

  // Enter explicit rename mode (pencil / click / F2)
  const startTitleEdit = useCallback(() => {
    if (!noteContent) return;
    setEditingTitle(noteContent.name.replace(/\.md$/, ''));
    setIsEditingTitle(true);
  }, [noteContent]);

  // Cancel rename and restore the original title
  const cancelTitleEdit = useCallback(() => {
    if (noteContent) {
      setEditingTitle(noteContent.name.replace(/\.md$/, ''));
    }
    setIsEditingTitle(false);
  }, [noteContent]);

  // Commit rename on Enter or blur; empty input cancels instead
  const commitTitleRename = useCallback(async () => {
    if (!isEditingTitle) return;
    if (!selectedNote || !noteContent) {
      setIsEditingTitle(false);
      return;
    }

    const trimmedTitle = editingTitle.trim();
    if (!trimmedTitle) {
      cancelTitleEdit();
      return;
    }

    // 确保文件名以 .md 结尾
    const finalName = trimmedTitle.endsWith('.md') ? trimmedTitle : `${trimmedTitle}.md`;
    setIsEditingTitle(false);

    // Only rename if title actually changed
    if (finalName === noteContent.name) return;

    setOperationError(null);
    try {
      const newPath = await invoke<string>('rename_note', {
        request: { old_path: selectedNote, new_name: finalName },
      });
      loadNoteTree();
      setSelectedNote(newPath);
    } catch (err) {
      console.error('Failed to rename:', err);
      setOperationError(`重命名失败：${err instanceof Error ? err.message : '未知错误'}`);
      // Reset to original name on error
      setEditingTitle(noteContent.name.replace(/\.md$/, ''));
    }
  }, [isEditingTitle, selectedNote, noteContent, editingTitle, cancelTitleEdit, loadNoteTree, setSelectedNote]);

  // Sync editing title when note changes
  const noteName = noteContent?.name;
  useEffect(() => {
    if (noteName) {
      setEditingTitle(noteName.replace(/\.md$/, ''));
    }
  }, [noteName]);

  const openRenameModal = (item: NoteItemData) => {
    setRenameItem(item);
    // 不显示 .md 后缀
    setRenameValue(item.name.replace(/\.md$/, ''));
    setShowRenameModal(true);
  };

  // Handle reveal item in explorer
  const handleRevealInExplorer = useCallback(async (item: NoteItemData) => {
    try {
      // Get notes directory and construct absolute path
      const notesDir = await invoke<string>('get_notes_directory');
      // Convert forward slashes to backslashes for Windows and join paths
      const relativePath = item.path.replace(/\//g, '\\');
      const fullPath = `${notesDir}\\${relativePath}`;
      await revealItemInDir(fullPath);
    } catch (err) {
      console.error('Failed to reveal item:', err);
      setOperationError(`打开文件位置失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  }, []);

  // Handle empty area context menu
  const handleEmptyAreaContextMenu = useCallback(
    (e: React.MouseEvent, parentPath: string = '') => {
      e.preventDefault();
      e.stopPropagation();
      setEmptyAreaMenu({
        visible: true,
        position: { x: e.clientX, y: e.clientY },
        parentPath,
      });
    },
    []
  );

  // Handle export as PNG
  const handleExportPNG = async () => {
    if (!selectedNote || !noteContent) return;

    setIsExporting(true);
    setExportError(null);

    try {
      // 导出为图片 - 直接传入 markdown 内容
      const blob = await exportNoteAsImage(editorContent, noteContent.name);

      // 选择保存位置
      const defaultFileName = noteContent.name.replace(/\.md$/, '.png');
      const filePath = await save({
        defaultPath: defaultFileName,
        filters: [
          { name: 'PNG 图片', extensions: ['png'] },
        ],
      });

      if (filePath) {
        // 将 Blob 转换为 base64
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64data = reader.result as string;
            // 移除 data:image/png;base64, 前缀
            resolve(base64data.split(',')[1]);
          };
          reader.readAsDataURL(blob);
        });

        await invoke('save_image_to_path', {
          base64Data: base64,
          path: filePath,
        });

        // 打开文件资源管理器显示保存的图片
        await revealItemInDir(filePath);
      }
    } catch (err) {
      console.error('Export failed:', err);
      setExportError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setIsExporting(false);
    }
  };

  // Close empty area context menu
  const closeEmptyAreaMenu = useCallback(() => {
    setEmptyAreaMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // Get empty area context menu items
  const getEmptyAreaMenuItems = useCallback(
    (parentPath: string): MenuItem[] => [
      {
        id: 'new-note',
        label: '新建笔记',
        icon: MenuIcons.newNote,
        onClick: () => openCreateModal('file', parentPath),
      },
      {
        id: 'new-folder',
        label: '新建文件夹',
        icon: MenuIcons.newFolder,
        onClick: () => openCreateModal('folder', parentPath),
      },
    ],
    [openCreateModal]
  );

  return (
    <div className="w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
      {/* File Tree Sidebar */}
      {!isEditorFullscreen && (
        <aside
          className="flex flex-col transition-all duration-300"
          style={{
            width: '192px',
            borderRight: `1px solid ${THEME.BORDER_DEFAULT}`,
          }}
        >
          {/* Search and toolbar */}
            <div
              className="flex items-center gap-1 px-2 py-2"
              style={{ borderBottom: `1px solid ${THEME.BORDER_DEFAULT}` }}
            >
          <div
            className="flex-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 min-w-0"
            style={{ backgroundColor: 'rgba(63, 63, 70, 0.4)' }}
          >
            <Search size={12} className="shrink-0" style={{ color: THEME.TEXT_DISABLED }} />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索笔记..."
              aria-label="搜索笔记"
              className="bg-transparent text-[12px] outline-none flex-1 min-w-0"
              style={{ color: THEME.TEXT_SECONDARY }}
            />
          </div>
          <button
            onClick={() => openCreateModal('file')}
            className="p-1.5 rounded-lg transition-all duration-200 cursor-pointer shrink-0"
            style={{ color: THEME.TEXT_DISABLED }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = THEME.TEXT_PRIMARY;
              e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = THEME.TEXT_DISABLED;
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title="新建笔记"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => openCreateModal('folder')}
            className="p-1.5 rounded-lg transition-all duration-200 cursor-pointer shrink-0"
            style={{ color: THEME.TEXT_DISABLED }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = THEME.TEXT_PRIMARY;
              e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = THEME.TEXT_DISABLED;
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title="新建文件夹"
          >
            <Folder size={14} />
          </button>
        </div>

        {/* Operation error bar — inline, never replaces the tree */}
        {operationError && (
          <div
            className="flex items-start gap-2 px-3 py-2 text-xs"
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.12)',
              borderBottom: `1px solid ${THEME.BORDER_DEFAULT}`,
              color: THEME.ERROR_TEXT,
            }}
            role="alert"
          >
            <span className="flex-1 leading-5">{operationError}</span>
            <button
              onClick={() => setOperationError(null)}
              aria-label="关闭错误提示"
              className="shrink-0 p-0.5 rounded transition-colors hover:bg-white/10 cursor-pointer"
              style={{ color: THEME.ERROR_TEXT }}
            >
              <X size={12} />
            </button>
          </div>
        )}

        <div
          className="flex-1 overflow-y-auto p-2"
          onContextMenu={(e) => handleEmptyAreaContextMenu(e, '')}
        >
          {isLoading ? (
            <div className="flex items-center justify-center h-full" style={{ color: THEME.TEXT_DISABLED }}>
              <Loader2 size={20} className="animate-spin mr-2" />
              <span className="text-xs">加载中...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center" style={{ color: THEME.TEXT_DISABLED }}>
              <p className="text-sm mb-2" style={{ color: THEME.ERROR }}>{error}</p>
              <button
                onClick={loadNoteTree}
                className="text-sm transition-colors cursor-pointer"
                style={{ color: THEME.INFO }}
              >
                重试
              </button>
            </div>
          ) : searchQuery.trim() ? (
            searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
                <p className="text-sm" style={{ color: THEME.TEXT_TERTIARY }}>
                  没有名称包含「{searchQuery.trim()}」的笔记
                </p>
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-xs underline cursor-pointer"
                  style={{ color: THEME.INFO }}
                >
                  清空搜索
                </button>
              </div>
            ) : (
              <div className="space-y-0.5">
                {searchResults.map((item, index) => (
                  <button
                    key={item.path}
                    ref={index === 0 ? firstResultRef : undefined}
                    onClick={() => setSelectedNote(item.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp' && index === 0) {
                        e.preventDefault();
                        searchInputRef.current?.focus();
                      }
                    }}
                    className="w-full text-left px-2 py-1.5 rounded-md text-sm truncate transition-colors cursor-pointer"
                    style={{
                      color: selectedNote === item.path ? '#93c5fd' : THEME.TEXT_TERTIARY,
                      backgroundColor: selectedNote === item.path ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                    }}
                    onMouseEnter={(e) => {
                      if (selectedNote !== item.path) {
                        e.currentTarget.style.color = THEME.TEXT_PRIMARY;
                        e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.4)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (selectedNote !== item.path) {
                        e.currentTarget.style.color = THEME.TEXT_TERTIARY;
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }
                    }}
                  >
                    {item.name.replace(/\.md$/, '')}
                  </button>
                ))}
              </div>
            )
          ) : notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center" style={{ color: THEME.TEXT_DISABLED }}>
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
                style={{ backgroundColor: 'rgba(63, 63, 70, 0.3)' }}
              >
                <FileText size={24} className="opacity-50" />
              </div>
              <p className="text-xs" style={{ color: THEME.TEXT_SECONDARY }}>暂无笔记</p>
              <p className="text-xs mt-1" style={{ color: THEME.TEXT_DISABLED }}>点击 + 或按 Ctrl+N 新建</p>
            </div>
          ) : (
            <ErrorBoundary>
              <SortableNoteTree
                items={notes}
                selectedId={selectedNote}
                expandedFolders={expandedFolders}
                onSelect={setSelectedNote}
                onToggle={toggleFolder}
                onCreate={(parent) => openCreateModal('file', parent)}
                onRename={openRenameModal}
                onDelete={requestDelete}
                onMove={handleMove}
                onReorder={handleReorder}
                onRevealInExplorer={handleRevealInExplorer}
              />
            </ErrorBoundary>
          )}
        </div>
      </aside>
      )}

      {/* Editor Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedNote && noteContent ? (
          <>
            {/* Title Bar */}
            <div
              className="px-6 py-3 flex items-center justify-between"
              style={{ borderBottom: `1px solid ${THEME.BORDER_DEFAULT}` }}
            >
              <div className="flex-1 flex items-center gap-1.5 min-w-0">
                {isEditingTitle ? (
                  <input
                    type="text"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={commitTitleRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void commitTitleRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelTitleEdit();
                      }
                    }}
                    onFocus={(e) => e.target.select()}
                    autoFocus
                    className="bg-transparent text-sm font-semibold flex-1 min-w-0 rounded-md px-1.5 py-0.5 -mx-1.5"
                    style={{
                      color: THEME.TEXT_PRIMARY,
                      outline: `1px solid ${THEME.SELECTED}`,
                    }}
                    placeholder="笔记标题"
                    aria-label="重命名笔记"
                  />
                ) : (
                  <>
                    <button
                      onClick={startTitleEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'F2') {
                          e.preventDefault();
                          startTitleEdit();
                        }
                      }}
                      className="text-sm font-semibold text-left truncate cursor-text rounded-md px-1.5 py-0.5 -mx-1.5 transition-colors hover:bg-white/5 min-w-0"
                      style={{ color: THEME.TEXT_PRIMARY }}
                      title="点击重命名（F2）"
                    >
                      {noteContent.name.replace(/\.md$/, '')}
                    </button>
                    <button
                      onClick={startTitleEdit}
                      aria-label="重命名笔记"
                      className="p-1 rounded-md transition-colors hover:bg-white/10 cursor-pointer shrink-0"
                      style={{ color: THEME.TEXT_TERTIARY }}
                    >
                      <Pencil size={12} />
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Status indicators */}
                <div className="flex items-center gap-3 mr-2">
                  {isSaving ? (
                    <span className="text-xs flex items-center gap-1" style={{ color: THEME.TEXT_TERTIARY }}>
                      <Loader2 size={12} className="animate-spin" />
                      保存中...
                    </span>
                  ) : saveError ? (
                    <span className="text-xs flex items-center gap-1" title={saveError}>
                      <span style={{ color: THEME.ERROR_TEXT }}>保存失败</span>
                      <button
                        onClick={retrySave}
                        className="underline cursor-pointer"
                        style={{ color: THEME.INFO }}
                      >
                        重试
                      </button>
                    </span>
                  ) : editorContent !== noteContent.content ? (
                    <span className="text-xs" style={{ color: THEME.TEXT_TERTIARY }}>待保存</span>
                  ) : (
                    <span className="text-xs" style={{ color: THEME.TEXT_TERTIARY }}>已保存</span>
                  )}
                  {isExporting && (
                    <span className="text-xs flex items-center gap-1" style={{ color: THEME.TEXT_DISABLED }}>
                      <Loader2 size={12} className="animate-spin" />
                      导出中...
                    </span>
                  )}
                  {exportError && (
                    <span className="text-xs flex items-center gap-1">
                      <span style={{ color: THEME.ERROR }}>{exportError}</span>
                      <button
                        onClick={() => {
                          setExportError(null);
                          handleExportPNG();
                        }}
                        className="underline cursor-pointer"
                        style={{ color: THEME.INFO }}
                      >
                        重试
                      </button>
                    </span>
                  )}
                  <span className="text-xs tabular-nums" style={{ color: THEME.TEXT_DISABLED }}>
                    {editorContent.length.toLocaleString()} 字符
                  </span>
                </div>

                {/* Toolbar buttons */}
                <div className="flex items-center gap-0.5">
                  {/* Export Button — single action, exports PNG directly */}
                  <Tooltip content="导出为 PNG" placement="bottom">
                    <button
                      onClick={handleExportPNG}
                      disabled={isExporting}
                      className="w-7 h-7 rounded-md flex items-center justify-center transition-all duration-200 cursor-pointer"
                      style={{ color: THEME.TEXT_DISABLED }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = THEME.TEXT_PRIMARY;
                        e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = THEME.TEXT_DISABLED;
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      <Download size={14} />
                    </button>
                  </Tooltip>

                  {/* Fullscreen Button */}
                  <Tooltip content={isEditorFullscreen ? '退出全屏' : '全屏编辑'} placement="bottom">
                    <button
                      onClick={() => setIsEditorFullscreen(!isEditorFullscreen)}
                      className="w-7 h-7 rounded-md flex items-center justify-center transition-all duration-200 cursor-pointer"
                      style={{ color: THEME.TEXT_DISABLED }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = THEME.TEXT_PRIMARY;
                        e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = THEME.TEXT_DISABLED;
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      {isEditorFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* WYSIWYG Markdown Editor */}
            <div className="flex-1 overflow-hidden vditor-container">
              <VditorEditor
                value={editorContent}
                onChange={setEditorContent}
                placeholder="开始写作..."
              />
            </div>
          </>
        ) : selectedNote && contentError ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <p className="text-sm mb-3" style={{ color: THEME.ERROR_TEXT }}>
              加载笔记失败：{contentError}
            </p>
            <button
              onClick={() => loadNoteContent(selectedNote)}
              className="text-sm px-4 py-2 rounded-lg transition-colors cursor-pointer hover:bg-white/10"
              style={{ color: THEME.INFO }}
            >
              重试
            </button>
          </div>
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <Modal onClose={() => setShowCreateModal(false)}>
          <h3 className="font-medium mb-4" style={{ color: THEME.TEXT_PRIMARY }}>
            新建 {createType === 'file' ? '笔记' : '文件夹'}
          </h3>
          <input
            type="text"
            value={createPath}
            onChange={(e) => setCreatePath(e.target.value)}
            placeholder={createType === 'file' ? '笔记名称.md' : '文件夹名称'}
            className="w-full rounded-lg px-4 py-2 outline-none transition-colors"
            style={{
              backgroundColor: 'rgba(63, 63, 70, 0.5)',
              border: `1px solid ${THEME.BORDER_EMPHASIS}`,
              color: THEME.TEXT_PRIMARY,
            }}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setShowCreateModal(false)}
              className="px-4 py-2 rounded-lg transition-all duration-200 cursor-pointer"
              style={{ color: THEME.TEXT_TERTIARY }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = THEME.TEXT_PRIMARY;
                e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = THEME.TEXT_TERTIARY;
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!createPath.trim()}
              className="px-4 py-2 rounded-lg transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                backgroundColor: 'rgba(59, 130, 246, 0.2)',
                color: '#60a5fa',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.3)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
              }}
            >
              创建
            </button>
          </div>
        </Modal>
      )}

      {/* Rename Modal */}
      {showRenameModal && renameItem && (
        <Modal onClose={() => setShowRenameModal(false)}>
          <h3 className="font-medium mb-4" style={{ color: THEME.TEXT_PRIMARY }}>重命名</h3>
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="w-full rounded-lg px-4 py-2 outline-none transition-colors"
            style={{
              backgroundColor: 'rgba(63, 63, 70, 0.5)',
              border: `1px solid ${THEME.BORDER_EMPHASIS}`,
              color: THEME.TEXT_PRIMARY,
            }}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setShowRenameModal(false)}
              className="px-4 py-2 rounded-lg transition-all duration-200 cursor-pointer"
              style={{ color: THEME.TEXT_TERTIARY }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = THEME.TEXT_PRIMARY;
                e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = THEME.TEXT_TERTIARY;
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              取消
            </button>
            <button
              onClick={handleRename}
              disabled={!renameValue.trim()}
              className="px-4 py-2 rounded-lg transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                backgroundColor: 'rgba(59, 130, 246, 0.2)',
                color: '#60a5fa',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.3)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
              }}
            >
              重命名
            </button>
          </div>
        </Modal>
      )}

      {/* Empty Area Context Menu */}
      {emptyAreaMenu.visible && (
        <ContextMenu
          items={getEmptyAreaMenuItems(emptyAreaMenu.parentPath)}
          position={emptyAreaMenu.position}
          onClose={closeEmptyAreaMenu}
        />
      )}

      {/* Delete Confirm Dialog */}
      {deleteTarget && (
        <DeleteConfirmDialog
          item={deleteTarget}
          noteCount={countFolderNotes(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
