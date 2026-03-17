import { GripVertical, ChevronRight, ChevronDown, Plus, Edit3, Trash2 } from 'lucide-react';
import type { NoteItemData, DragItem } from '../types';

interface NoteTreeProps {
  items: NoteItemData[];
  selectedId: string | null;
  expandedFolders: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onCreate: (parent: string) => void;
  onRename: (item: NoteItemData) => void;
  onDelete: (item: NoteItemData) => void;
  dragItem: DragItem | null;
  dragOverItem: string | null;
  dragOverFolder: string | null;
  onDragStart: (e: React.DragEvent, item: NoteItemData, parentPath: string) => void;
  onDragEnd: () => void;
  onDragEnter: (e: React.DragEvent, itemPath: string, isFolder: boolean) => void;
  onDragOver: (e: React.DragEvent, _itemPath: string, _isFolder: boolean) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, item: NoteItemData, parentPath: string) => void;
  parentPath: string;
  level?: number;
}

export function NoteTree({
  items,
  selectedId,
  expandedFolders,
  onSelect,
  onToggle,
  onCreate,
  onRename,
  onDelete,
  dragItem,
  dragOverItem,
  dragOverFolder,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  parentPath,
  level = 0,
}: NoteTreeProps) {
  return (
    <div className="space-y-0.5" role="tree">
      {items.map((item) => {
        const isExpanded = expandedFolders.has(item.path);
        const isDragOver = dragOverItem === item.path;
        const isDragOverFolder = dragOverFolder === item.path;
        const isDragging = dragItem?.item.path === item.path;
        const isSelected = selectedId === item.path;

        return (
          <div key={item.path} role="treeitem" aria-expanded={item.is_folder ? isExpanded : undefined}>
            <div
              onDragEnter={(e) => onDragEnter(e, item.path, item.is_folder)}
              onDragOver={(e) => onDragOver(e, item.path, item.is_folder)}
              onDragLeave={onDragLeave}
              onDrop={(e) => onDrop(e, item, parentPath)}
              className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm transition-all duration-200 ${
                isSelected
                  ? 'bg-zinc-600/50 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-700/30 hover:text-zinc-200'
              } ${isDragOver ? 'border-t-2 border-blue-500' : ''} ${
                isDragOverFolder ? 'bg-blue-500/20 border border-blue-500/50' : ''
              } ${isDragging ? 'opacity-50' : ''}`}
              style={{ paddingLeft: `${8 + level * 16}px` }}
              role="presentation"
            >
              {/* Drag Handle - Only the grip is draggable */}
              <div
                draggable
                onDragStart={(e) => onDragStart(e, item, parentPath)}
                onDragEnd={onDragEnd}
                className="text-zinc-600 cursor-grab active:cursor-grabbing p-1 -ml-1 rounded hover:bg-zinc-600/30 inline-flex items-center"
                title="拖拽移动"
                aria-label={`拖拽 ${item.name}`}
              >
                <GripVertical size={12} />
              </div>

              <div
                onClick={() => (item.is_folder ? onToggle(item.path) : onSelect(item.path))}
                className="flex items-center gap-1 flex-1 min-w-0 cursor-pointer"
                role={item.is_folder ? 'button' : undefined}
                aria-label={item.is_folder ? `${isExpanded ? '折叠' : '展开'}文件夹 ${item.name}` : `打开笔记 ${item.name}`}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    item.is_folder ? onToggle(item.path) : onSelect(item.path);
                  }
                }}
              >
                {item.is_folder && (
                  <span
                    className="text-zinc-500 w-4 shrink-0"
                    aria-hidden="true"
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                )}
                <span className="truncate">{item.name}</span>
              </div>

              {/* Actions */}
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity duration-200">
                {item.is_folder && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreate(item.path);
                    }}
                    className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-600/50 transition-colors cursor-pointer"
                    title="新建笔记"
                    aria-label={`在 ${item.name} 中新建笔记`}
                  >
                    <Plus size={12} />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename(item);
                  }}
                  className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-600/50 transition-colors cursor-pointer"
                  title="重命名"
                  aria-label={`重命名 ${item.name}`}
                >
                  <Edit3 size={12} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(item);
                  }}
                  className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-600/50 transition-colors cursor-pointer"
                  title="删除"
                  aria-label={`删除 ${item.name}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            {item.is_folder && isExpanded && item.children && (
              <NoteTree
                items={item.children}
                selectedId={selectedId}
                expandedFolders={expandedFolders}
                onSelect={onSelect}
                onToggle={onToggle}
                onCreate={onCreate}
                onRename={onRename}
                onDelete={onDelete}
                dragItem={dragItem}
                dragOverItem={dragOverItem}
                dragOverFolder={dragOverFolder}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                parentPath={item.path}
                level={level + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
