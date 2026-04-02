import { useState, useEffect, useCallback, useMemo } from 'react';
import { FileText, Plus, Folder, Loader2, Search } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import MDEditor from '@uiw/react-md-editor';
import type { NoteItemData, NoteContentData, CreateNoteRequest } from './types';
import { useNotes } from './hooks/useNotes';
import { Modal, EmptyState, SortableNoteTree, ErrorBoundary } from './components';
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

  return (
    <div className="w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
      {/* File Tree Sidebar */}
      <aside className="w-48 border-r border-zinc-600/30 flex flex-col">
        <div className="flex items-center gap-1 px-2 py-2 border-b border-zinc-600/30">
          <div className="flex-1 flex items-center gap-1.5 bg-zinc-700/40 rounded-lg px-2 py-1.5 min-w-0">
            <Search size={12} className="text-zinc-500 shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索笔记..."
              className="bg-transparent text-xs text-zinc-300 placeholder:text-zinc-500 outline-none flex-1 min-w-0"
            />
          </div>
          <button
            onClick={() => openCreateModal('file')}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer shrink-0"
            title="新建笔记"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => openCreateModal('folder')}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer shrink-0"
            title="新建文件夹"
          >
            <Folder size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-zinc-500">
              <Loader2 size={20} className="animate-spin mr-2" />
              <span className="text-sm">加载中...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500 p-4 text-center">
              <p className="text-red-400 text-sm mb-2">{error}</p>
              <button
                onClick={loadNoteTree}
                className="text-sm text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
              >
                重试
              </button>
            </div>
          ) : searchQuery.trim() ? (
            searchResults.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-xs text-zinc-500">无匹配结果</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {searchResults.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => setSelectedNote(item.path)}
                    className={`w-full text-left px-2 py-1.5 rounded-md text-xs truncate transition-colors cursor-pointer ${
                      selectedNote === item.path
                        ? 'bg-blue-500/20 text-blue-300'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/40'
                    }`}
                  >
                    {item.name.replace(/\.md$/, '')}
                  </button>
                ))}
              </div>
            )
          ) : notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500 p-4 text-center">
              <div className="w-12 h-12 rounded-xl bg-zinc-700/30 flex items-center justify-center mb-3">
                <FileText size={24} className="opacity-50" />
              </div>
              <p className="text-sm text-zinc-300">暂无笔记</p>
              <p className="text-xs mt-1 text-zinc-500">点击 + 创建新笔记</p>
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
              />
            </ErrorBoundary>
          )}
        </div>
      </aside>

      {/* Editor Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedNote && noteContent ? (
          <>
            {/* Title Bar */}
            <div className="px-6 py-3 border-b border-zinc-600/30 flex items-center justify-between">
              <input
                type="text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={handleTitleRename}
                onKeyDown={(e) => e.key === 'Enter' && handleTitleRename()}
                className="bg-transparent text-lg font-semibold text-zinc-200 outline-none flex-1"
                placeholder="笔记标题"
              />
              <div className="flex items-center gap-2">
                {isSaving && (
                  <span className="text-zinc-500 text-xs flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" />
                    保存中...
                  </span>
                )}
                <span className="text-zinc-500 text-xs">{editorContent.length} 字符</span>
              </div>
            </div>

            {/* WYSIWYG Markdown Editor */}
            <div className="flex-1 overflow-hidden" data-color-mode="dark">
              <MDEditor
                value={editorContent}
                onChange={(value) => setEditorContent(value || '')}
                height="100%"
                preview="edit"
                hideToolbar={false}
                textareaProps={{
                  placeholder: '开始写作...',
                }}
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
          <h3 className="text-zinc-200 font-medium mb-4">
            新建 {createType === 'file' ? '笔记' : '文件夹'}
          </h3>
          <input
            type="text"
            value={createPath}
            onChange={(e) => setCreatePath(e.target.value)}
            placeholder={createType === 'file' ? '笔记名称.md' : '文件夹名称'}
            className="w-full bg-zinc-700/50 border border-zinc-600/50 rounded-lg px-4 py-2 text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-blue-500/50 transition-colors"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setShowCreateModal(false)}
              className="px-4 py-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              className="px-4 py-2 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-all duration-200 cursor-pointer"
            >
              创建
            </button>
          </div>
        </Modal>
      )}

      {/* Rename Modal */}
      {showRenameModal && renameItem && (
        <Modal onClose={() => setShowRenameModal(false)}>
          <h3 className="text-zinc-200 font-medium mb-4">重命名</h3>
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="w-full bg-zinc-700/50 border border-zinc-600/50 rounded-lg px-4 py-2 text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-blue-500/50 transition-colors"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setShowRenameModal(false)}
              className="px-4 py-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer"
            >
              取消
            </button>
            <button
              onClick={handleRename}
              className="px-4 py-2 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-all duration-200 cursor-pointer"
            >
              重命名
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
