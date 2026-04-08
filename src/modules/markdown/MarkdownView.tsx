import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FileText, Plus, Folder, Loader2, Search, Maximize2, Minimize2, Download, Image as ImageIcon } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { NoteItemData, NoteContentData, CreateNoteRequest } from './types';
import { useNotes } from './hooks/useNotes';
import { Modal, EmptyState, SortableNoteTree, ErrorBoundary, VditorEditor, ContextMenu, MenuIcons } from './components';
import { exportNoteAsImage } from './utils/export';
import type { MenuItem } from './components/ContextMenu';
import { THEME } from '@/constants/theme';
import { WINDOW_SIZE } from '@/constants/window';
import { immediateResize } from '@/utils/tauri';

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
    setError,
    expandedFolders,
    setExpandedFolders,
    loadNoteTree,
    toggleFolder,
  } = useNotes();

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'folder'>('file');
  const [createPath, setCreatePath] = useState('');
  const [createParent, setCreateParent] = useState('');

  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameItem, setRenameItem] = useState<NoteItemData | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleCreate = async () => {
    if (!createPath.trim()) return;

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
      setError(err instanceof Error ? err.message : '创建失败');
    }
  };

  const handleRename = async () => {
    if (!renameItem || !renameValue.trim()) return;

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
      setError(err instanceof Error ? err.message : '重命名失败');
    }
  };

  const handleDelete = async (item: NoteItemData) => {
    if (!confirm(`确定要删除 "${item.name}" 吗？`)) return;

    try {
      await invoke('delete_note', { path: item.path });

      if (selectedNote === item.path) {
        setSelectedNote(null);
      }

      loadNoteTree();
    } catch (err) {
      console.error('Failed to delete:', err);
      setError(err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleMove = async (sourcePath: string, targetFolder: string) => {
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
      setError(err instanceof Error ? err.message : '移动笔记失败');
    }
  };

  const handleReorder = async (parentPath: string, itemNames: string[]) => {
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
      setError(err instanceof Error ? err.message : '排序更新失败');
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

  // Export state
  const [isExporting, setIsExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

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

  const [editingTitle, setEditingTitle] = useState('');

  // Handle title rename on blur
  const handleTitleRename = async () => {
    if (!selectedNote || !noteContent || !editingTitle.trim()) return;

    const trimmedTitle = editingTitle.trim();
    // 确保文件名以 .md 结尾
    const finalName = trimmedTitle.endsWith('.md') ? trimmedTitle : `${trimmedTitle}.md`;

    // Only rename if title actually changed
    if (finalName === noteContent.name) return;

    try {
      const newPath = await invoke<string>('rename_note', {
        request: { old_path: selectedNote, new_name: finalName },
      });
      loadNoteTree();
      setSelectedNote(newPath);
    } catch (err) {
      console.error('Failed to rename:', err);
      setError(err instanceof Error ? err.message : '重命名失败');
      // Reset to original name on error
      setEditingTitle(noteContent.name.replace(/\.md$/, ''));
    }
  };

  // Sync editing title when note changes
  useEffect(() => {
    if (noteContent) {
      setEditingTitle(noteContent.name.replace(/\.md$/, ''));
    }
  }, [noteContent?.name]);

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
      setError(err instanceof Error ? err.message : '打开文件位置失败');
    }
  }, [setError]);

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

  // Close export menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    };

    if (showExportMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showExportMenu]);

  // Handle export as PNG
  const handleExportPNG = async () => {
    console.log('[MarkdownView] Export PNG clicked');
    console.log('[MarkdownView] selectedNote:', selectedNote);
    console.log('[MarkdownView] noteContent:', noteContent?.name);
    console.log('[MarkdownView] editorContent length:', editorContent?.length || 0);

    if (!selectedNote || !noteContent) {
      console.log('[MarkdownView] Missing selectedNote or noteContent, returning');
      return;
    }

    setIsExporting(true);
    setShowExportMenu(false);

    try {
      // 导出为图片 - 直接传入 markdown 内容
      console.log('[MarkdownView] Calling exportNoteAsImage...');
      const blob = await exportNoteAsImage(editorContent, noteContent.name);
      console.log('[MarkdownView] exportNoteAsImage returned, blob size:', blob?.size || 0);

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

        setError('导出成功');
        setTimeout(() => setError(null), 2000);

        // 打开文件资源管理器显示保存的图片
        await revealItemInDir(filePath);
      }
    } catch (err) {
      console.error('Export failed:', err);
      setError(err instanceof Error ? err.message : '导出失败');
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
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索笔记..."
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
              <div className="flex items-center justify-center h-full">
                <p className="text-sm" style={{ color: THEME.TEXT_DISABLED }}>无匹配结果</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {searchResults.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => setSelectedNote(item.path)}
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
              <p className="text-[10px] mt-1" style={{ color: THEME.TEXT_DISABLED }}>点击 + 创建新笔记</p>
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
                onDelete={handleDelete}
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
              <input
                type="text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={handleTitleRename}
                onKeyDown={(e) => e.key === 'Enter' && handleTitleRename()}
                className="bg-transparent text-lg font-semibold outline-none flex-1"
                style={{ color: THEME.TEXT_PRIMARY }}
                placeholder="笔记标题"
              />
              <div className="flex items-center gap-2">
                {isSaving && (
                  <span className="text-xs flex items-center gap-1" style={{ color: THEME.TEXT_DISABLED }}>
                    <Loader2 size={12} className="animate-spin" />
                    保存中...
                  </span>
                )}
                {isExporting && (
                  <span className="text-xs flex items-center gap-1" style={{ color: THEME.TEXT_DISABLED }}>
                    <Loader2 size={12} className="animate-spin" />
                    导出中...
                  </span>
                )}
                <span className="text-xs" style={{ color: THEME.TEXT_DISABLED }}>{editorContent.length} 字符</span>
                {/* Export Button */}
                <div className="relative" ref={exportMenuRef}>
                  <button
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    disabled={isExporting}
                    className="p-1.5 rounded-lg transition-all duration-200 cursor-pointer"
                    style={{ color: THEME.TEXT_DISABLED }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = THEME.TEXT_PRIMARY;
                      e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = THEME.TEXT_DISABLED;
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    title="导出笔记"
                  >
                    <Download size={14} />
                  </button>
                  {showExportMenu && (
                    <div
                      className="absolute right-0 top-full mt-1 py-1 rounded-lg shadow-lg z-50 min-w-[120px]"
                      style={{
                        backgroundColor: THEME.BG_SECONDARY,
                        border: `1px solid ${THEME.BORDER_DEFAULT}`,
                      }}
                    >
                      <button
                        onClick={handleExportPNG}
                        className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 transition-colors"
                        style={{ color: THEME.TEXT_SECONDARY }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
                          e.currentTarget.style.color = THEME.TEXT_PRIMARY;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = 'transparent';
                          e.currentTarget.style.color = THEME.TEXT_SECONDARY;
                        }}
                      >
                        <ImageIcon size={12} />
                        导出为 PNG
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setIsEditorFullscreen(!isEditorFullscreen)}
                  className="p-1.5 rounded-lg transition-all duration-200 cursor-pointer"
                  style={{ color: THEME.TEXT_DISABLED }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = THEME.TEXT_PRIMARY;
                    e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = THEME.TEXT_DISABLED;
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  title={isEditorFullscreen ? '退出全屏' : '全屏编辑'}
                >
                  {isEditorFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
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
              className="px-4 py-2 rounded-lg transition-all duration-200 cursor-pointer"
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
              className="px-4 py-2 rounded-lg transition-all duration-200 cursor-pointer"
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
    </div>
  );
}
