import { useState, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  defaultDropAnimationSideEffects,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type DropAnimation,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ChevronRight, ChevronDown, Plus, Edit3, Trash2, Folder, FileText } from 'lucide-react';
import type { NoteItemData } from '../types';

interface TreeItemProps {
  item: NoteItemData;
  selectedId: string | null;
  expandedFolders: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onCreate: (parent: string) => void;
  onRename: (item: NoteItemData) => void;
  onDelete: (item: NoteItemData) => void;
  level: number;
}

function SortableTreeItem({
  item,
  selectedId,
  expandedFolders,
  onSelect,
  onToggle,
  onCreate,
  onRename,
  onDelete,
  level,
}: TreeItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.path,
    data: {
      type: item.is_folder ? 'folder' : 'file',
      item,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isExpanded = expandedFolders.has(item.path);
  const isSelected = selectedId === item.path;

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={`group flex items-center gap-1 py-0.5 rounded text-sm transition-all duration-200 ${
          isSelected
            ? 'bg-zinc-600/50 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-700/30 hover:text-zinc-200'
        }`}
        style={{ paddingLeft: `${level * 12}px` }}
      >
        {/* Drag Handle */}
        <button
          {...attributes}
          {...listeners}
          className="text-zinc-600 cursor-grab active:cursor-grabbing py-0.5 px-0.5 rounded hover:bg-zinc-600/30 inline-flex items-center touch-none"
          title="拖拽移动"
        >
          <GripVertical size={12} />
        </button>

        {/* Content Area */}
        <div
          onClick={() => (item.is_folder ? onToggle(item.path) : onSelect(item.path))}
          className="flex items-center gap-0.5 flex-1 min-w-0 cursor-pointer"
        >
          {item.is_folder ? (
            <span className="text-zinc-500 w-4 shrink-0">
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="truncate">{item.is_folder ? item.name : item.name.replace(/\.md$/, '')}</span>
        </div>

        {/* Actions */}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0 transition-opacity duration-200">
          {item.is_folder && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCreate(item.path);
              }}
              className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-600/50 transition-colors cursor-pointer"
              title="新建笔记"
            >
              <Plus size={12} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRename(item);
            }}
            className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-600/50 transition-colors cursor-pointer"
            title="重命名"
          >
            <Edit3 size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(item);
            }}
            className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-600/50 transition-colors cursor-pointer"
            title="删除"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

    </div>
  );
}

interface FlattenedItem {
  id: string;
  item: NoteItemData;
  level: number;
  parentPath: string;
}

interface SortableNoteTreeProps {
  items: NoteItemData[];
  selectedId: string | null;
  expandedFolders: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onCreate: (parent: string) => void;
  onRename: (item: NoteItemData) => void;
  onDelete: (item: NoteItemData) => void;
  onMove: (sourcePath: string, targetFolder: string) => Promise<void>;
  onReorder: (parentPath: string, itemNames: string[]) => Promise<void>;
}

export function SortableNoteTree({
  items,
  selectedId,
  expandedFolders,
  onSelect,
  onToggle,
  onCreate,
  onRename,
  onDelete,
  onMove,
  onReorder,
}: SortableNoteTreeProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  // Flatten tree for sortable context
  const flattenTree = useCallback((
    treeItems: NoteItemData[],
    level = 0,
    parentPath = ''
  ): FlattenedItem[] => {
    const result: FlattenedItem[] = [];

    for (const item of treeItems) {
      result.push({
        id: item.path,
        item,
        level,
        parentPath,
      });

      // Only include children if folder is expanded
      if (item.is_folder && expandedFolders.has(item.path) && item.children) {
        result.push(...flattenTree(item.children, level + 1, item.path));
      }
    }

    return result;
  }, [expandedFolders]);

  const flattenedItems = useMemo(() => flattenTree(items), [flattenTree, items]);
  const itemIds = useMemo(() => flattenedItems.map((i) => i.id), [flattenedItems]);

  // Build parent map for quick lookup
  const parentMap = useMemo(() => {
    const map = new Map<string, string>();

    function buildMap(treeItems: NoteItemData[], parentPath = '') {
      for (const item of treeItems) {
        map.set(item.path, parentPath);
        if (item.children) {
          buildMap(item.children, item.path);
        }
      }
    }

    buildMap(items);
    return map;
  }, [items]);

  // Find item by path
  const findItem = useCallback((path: string, treeItems: NoteItemData[]): NoteItemData | null => {
    for (const item of treeItems) {
      if (item.path === path) return item;
      if (item.children) {
        const found = findItem(path, item.children);
        if (found) return found;
      }
    }
    return null;
  }, []);

  // Get siblings at the same level
  const getSiblings = useCallback((path: string): NoteItemData[] => {
    const parentPath = parentMap.get(path) || '';

    if (!parentPath) {
      return items;
    }

    const parent = findItem(parentPath, items);
    return parent?.children || [];
  }, [items, parentMap, findItem]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) return;

    // Check if dragging over a folder
    const overItem = findItem(overId, items);
    if (overItem?.is_folder && !expandedFolders.has(overId)) {
      // Auto-expand folder after delay
      setTimeout(() => {
        onToggle(overId);
      }, 500);
    }
  }, [items, findItem, expandedFolders, onToggle]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;

    setActiveId(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) return;

    const activeItem = findItem(activeId, items);
    const overItem = findItem(overId, items);

    if (!activeItem || !overItem) return;

    const activeParent = parentMap.get(activeId) || '';
    const overParent = parentMap.get(overId) || '';

    // Case 1: Dropping on a folder - move into that folder
    if (overItem.is_folder) {
      // Don't allow dropping a folder into itself or its descendants
      if (overId.startsWith(activeId)) return;

      try {
        await onMove(activeId, overId);
        // Auto-expand the target folder
        if (!expandedFolders.has(overId)) {
          onToggle(overId);
        }
      } catch (err) {
        console.error('Failed to move item:', err);
      }
      return;
    }

    // Case 2: Reordering within the same parent
    if (activeParent === overParent) {
      const siblings = getSiblings(activeId);
      const oldIndex = siblings.findIndex((i) => i.path === activeId);
      const newIndex = siblings.findIndex((i) => i.path === overId);

      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(siblings, oldIndex, newIndex);
        try {
          await onReorder(activeParent, newOrder.map((i) => i.name));
        } catch (err) {
          console.error('Failed to reorder:', err);
        }
      }
    } else {
      // Case 3: Moving to a different parent (drop on file, move to that file's parent)
      try {
        await onMove(activeId, overParent);
      } catch (err) {
        console.error('Failed to move item:', err);
      }
    }
  }, [items, findItem, parentMap, getSiblings, expandedFolders, onMove, onReorder, onToggle]);

  const dropAnimation: DropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: '0.5',
        },
      },
    }),
  };

  const activeItem = activeId ? findItem(activeId, items) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-0.5">
          {flattenedItems.map(({ item, level }) => (
            <SortableTreeItem
              key={item.path}
              item={item}
              selectedId={selectedId}
              expandedFolders={expandedFolders}
              onSelect={onSelect}
              onToggle={onToggle}
              onCreate={onCreate}
              onRename={onRename}
              onDelete={onDelete}
              level={level}
            />
          ))}
        </div>
      </SortableContext>

      <DragOverlay dropAnimation={dropAnimation}>
        {activeItem ? (
          <div className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm bg-zinc-600/80 text-zinc-100 shadow-lg">
            <span className="text-zinc-400">
              <GripVertical size={12} />
            </span>
            <span className="text-zinc-400">
              {activeItem.is_folder ? <Folder size={14} /> : <FileText size={14} />}
            </span>
            <span>{activeItem.name}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
