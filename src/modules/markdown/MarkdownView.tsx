import { useState, useEffect } from 'react';
import { FileText, Plus, Folder, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import MDEditor from '@uiw/react-md-editor';
import type { NoteItemData, NoteContentData, CreateNoteRequest, DragItem } from './types';
import { MARKDOWN_WINDOW_HEIGHT } from './constants';
import { useNotes } from './hooks/useNotes';
import { Modal, EmptyState, NoteTree, ErrorBoundary } from './components';

export function MarkdownView() {
  // Listen for menu actions from navigation bar
  useEffect(() => {
    const handleNewNote = () => openCreateModal('file');
    const handleNewFolder = () => openCreateModal('folder');

    window.addEventListener('markdown:new-note', handleNewNote);
    window.addEventListener('markdown:new-folder', handleNewFolder);

    return () => {
      window.removeEventListener('markdown:new-note', handleNewNote);
      window.removeEventListener('markdown:new-folder', handleNewFolder);
    };
  }, []);

  // Resize window when view mounts, restore on unmount
  useEffect(() => {
    let originalHeight: number | null = null;

    const resizeWindow = async () => {
      try {
        originalHeight = 400; // Default launcher height
        await invoke('resize_window', { height: MARKDOWN_WINDOW_HEIGHT });
      } catch (err) {
        console.error('Failed to resize window:', err);
      }
    };
    resizeWindow();

    return () => {
      if (originalHeight) {
        invoke('resize_window', { height: originalHeight }).catch((err) => {
          console.error('Failed to restore window height:', err);
        });
      }
    };
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
    getItemsAtPath,
  } = useNotes();

  // Drag and drop state
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dragOverItem, setDragOverItem] = useState<string | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

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
        setSelectedNote(fullPath);
      }
    } catch (err) {
      console.error('Failed to create:', err);
      setError(err instanceof Error ? err.message : '创建失败');
    }
  };

  const handleRename = async () => {
    if (!renameItem || !renameValue.trim()) return;

    try {
      const newPath = await invoke<string>('rename_note', {
        request: { old_path: renameItem.path, new_name: renameValue },
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

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, item: NoteItemData, parentPath: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify({ path: item.path, parentPath }));
    setDragItem({ item, parentPath });
  };

  const handleDragEnd = () => {
    setDragItem(null);
    setDragOverItem(null);
    setDragOverFolder(null);
  };

  const handleDragEnter = (e: React.DragEvent, itemPath: string, isFolder: boolean) => {
    e.preventDefault();
    if (dragItem?.item.path === itemPath) return;

    if (isFolder) {
      setDragOverFolder(itemPath);
      setDragOverItem(null);
    } else {
      setDragOverItem(itemPath);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDragLeave = () => {
    setDragOverItem(null);
    setDragOverFolder(null);
  };

  const handleDrop = async (e: React.DragEvent, targetItem: NoteItemData, parentPath: string) => {
    e.preventDefault();
    e.stopPropagation();

    const dragData = e.dataTransfer.getData('application/json');
    if (!dragData) return;

    const { path: sourcePath, parentPath: sourceParent } = JSON.parse(dragData);
    const draggedItem = dragItem || { item: { path: sourcePath, name: '', is_folder: false } as NoteItemData, parentPath: sourceParent };

    if (sourcePath === targetItem.path) {
      setDragOverItem(null);
      setDragOverFolder(null);
      return;
    }

    try {
      if (targetItem.is_folder) {
        await invoke('move_note', {
          request: {
            source_path: sourcePath,
            target_folder: targetItem.path,
          },
        });
        setExpandedFolders((prev) => new Set(prev).add(targetItem.path));
      } else {
        await reorderItems(draggedItem, targetItem, parentPath);
      }
      loadNoteTree();
    } catch (err) {
      console.error('Failed to move/reorder:', err);
      setError(err instanceof Error ? err.message : '移动失败');
    }

    setDragItem(null);
    setDragOverItem(null);
    setDragOverFolder(null);
  };

  const handleDropToRoot = async (e: React.DragEvent) => {
    e.preventDefault();

    const dragData = e.dataTransfer.getData('application/json');
    if (!dragData) return;

    const { path: sourcePath, parentPath: sourceParent } = JSON.parse(dragData);

    if (sourceParent === '') {
      setDragOverFolder(null);
      return;
    }

    try {
      await invoke('move_note', {
        request: {
          source_path: sourcePath,
          target_folder: '',
        },
      });
      loadNoteTree();
    } catch (err) {
      console.error('Failed to move to root:', err);
      setError(err instanceof Error ? err.message : '移动到根目录失败');
    }

    setDragItem(null);
    setDragOverFolder(null);
  };

  const reorderItems = async (dragItem: DragItem, targetItem: NoteItemData, parentPath: string) => {
    const parentItems = getItemsAtPath(parentPath);

    const dragIndex = parentItems.findIndex((i) => i.path === dragItem.item.path);
    const targetIndex = parentItems.findIndex((i) => i.path === targetItem.path);

    if (dragIndex === -1 || targetIndex === -1) return;

    const newOrder = [...parentItems];
    const [removed] = newOrder.splice(dragIndex, 1);
    newOrder.splice(targetIndex, 0, removed);

    await invoke('reorder_notes', {
      request: {
        parent_path: parentPath,
        item_names: newOrder.map((i) => i.name),
      },
    });
  };

  const openCreateModal = (type: 'file' | 'folder', parent: string = '') => {
    setCreateType(type);
    setCreateParent(parent);
    setCreatePath('');
    setShowCreateModal(true);
  };

  const openRenameModal = (item: NoteItemData) => {
    setRenameItem(item);
    setRenameValue(item.name);
    setShowRenameModal(true);
  };

  return (
    <div className="w-full h-full flex" style={{ backgroundColor: '#333333' }}>
      {/* File Tree Sidebar */}
      <aside className="w-48 border-r border-zinc-600/30 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-600/30">
          <h3 className="text-zinc-400 text-sm font-medium">笔记</h3>
          <div className="flex gap-1">
            <button
              onClick={() => openCreateModal('file')}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer"
              title="新建笔记"
            >
              <Plus size={16} />
            </button>
            <button
              onClick={() => openCreateModal('folder')}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer"
              title="新建文件夹"
            >
              <Folder size={16} />
            </button>
          </div>
        </div>

        <div
          className="flex-1 overflow-y-auto p-2"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragItem && dragItem.parentPath !== '') {
              setDragOverFolder('root');
            }
          }}
          onDragLeave={() => setDragOverFolder(null)}
          onDrop={handleDropToRoot}
        >
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
              <NoteTree
                items={notes}
                selectedId={selectedNote}
                expandedFolders={expandedFolders}
                onSelect={setSelectedNote}
                onToggle={toggleFolder}
                onCreate={(parent) => openCreateModal('file', parent)}
                onRename={openRenameModal}
                onDelete={handleDelete}
                dragItem={dragItem}
                dragOverItem={dragOverItem}
                dragOverFolder={dragOverFolder}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                parentPath=""
              />
            </ErrorBoundary>
          )}
          {dragOverFolder === 'root' && (
            <div className="mt-2 p-2 bg-blue-500/20 border border-blue-500/50 rounded-lg text-center text-blue-400 text-xs">
              释放以移动到根目录
            </div>
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
                value={noteContent.name}
                readOnly
                className="bg-transparent text-lg font-semibold text-zinc-200 outline-none flex-1"
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
