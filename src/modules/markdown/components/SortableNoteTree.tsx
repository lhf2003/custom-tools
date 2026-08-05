import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
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
import { GripVertical, ChevronRight, ChevronDown, Folder, FileText } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import type { NoteItemData } from '../types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { MenuIcons } from './menuIcons';

interface TreeItemProps {
  item: NoteItemData;
  selectedId: string | null;
  expandedFolders: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  level: number;
  tabIndex: number;
  registerRef: (path: string, el: HTMLButtonElement | null) => void;
  onFocusItem: (path: string) => void;
}

function SortableTreeItem({
  item,
  selectedId,
  expandedFolders,
  onSelect,
  onToggle,
  level,
  tabIndex,
  registerRef,
  onFocusItem,
  onContextMenu,
}: TreeItemProps & { onContextMenu: (e: React.MouseEvent, item: NoteItemData) => void }) {
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
    <div
      ref={setNodeRef}
      style={style}
      role="treeitem"
      aria-level={level + 1}
      aria-selected={isSelected}
      {...(item.is_folder ? { 'aria-expanded': isExpanded } : {})}
    >
      <div
        className="group flex items-center gap-1 py-0.5 rounded text-sm transition-all duration-200"
        style={{
          paddingLeft: `${level * 12}px`,
          backgroundColor: isSelected ? 'rgba(82, 82, 91, 0.5)' : 'transparent',
          color: isSelected ? '#f4f4f5' : '#a1a1aa',
        }}
        onContextMenu={(e) => onContextMenu(e, item)}
        onMouseEnter={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.3)';
            e.currentTarget.style.color = '#e4e4e7';
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = '#a1a1aa';
          }
        }}
      >
        {/* Drag Handle */}
        <Tooltip content="拖拽移动" placement="right">
          <button
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing py-0.5 px-0.5 rounded inline-flex items-center touch-none"
            style={{ color: '#45454c' }}
            aria-label={`拖拽移动 ${item.name.replace(/\.md$/, '')}`}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(82, 82, 91, 0.3)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <GripVertical size={14} />
          </button>
        </Tooltip>

        {/* Content Area */}
        <button
          type="button"
          ref={(el) => registerRef(item.path, el)}
          data-tree-path={item.path}
          tabIndex={tabIndex}
          onFocus={() => onFocusItem(item.path)}
          onClick={() => (item.is_folder ? onToggle(item.path) : onSelect(item.path))}
          className="flex items-center gap-0.5 flex-1 min-w-0 cursor-pointer rounded text-left focus-visible:bg-white/5"
        >
          {item.is_folder ? (
            <span className="w-4 shrink-0" style={{ color: '#71717a' }}>
              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="truncate">{item.is_folder ? item.name : item.name.replace(/\.md$/, '')}</span>
        </button>
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
  onRevealInExplorer?: (item: NoteItemData) => void;
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
  onRevealInExplorer,
}: SortableNoteTreeProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  // Roving tabindex keyboard navigation state
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  const registerRef = useCallback((path: string, el: HTMLButtonElement | null) => {
    if (el) {
      itemRefs.current.set(path, el);
    } else {
      itemRefs.current.delete(path);
    }
  }, []);
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    position: { x: number; y: number };
    targetItem: NoteItemData | null;
  }>({
    visible: false,
    position: { x: 0, y: 0 },
    targetItem: null,
  });

  // Handle item right-click
  const handleItemContextMenu = useCallback(
    (e: React.MouseEvent, item: NoteItemData) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        visible: true,
        position: { x: e.clientX, y: e.clientY },
        targetItem: item,
      });
    },
    []
  );

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // Build context menu items for a tree item
  const getItemContextMenuItems = useCallback(
    (item: NoteItemData): MenuItem[] => {
      const items: MenuItem[] = [];

      // Add "New Note" for folders
      if (item.is_folder) {
        items.push({
          id: 'new-note',
          label: '新建笔记',
          icon: MenuIcons.newNote,
          onClick: () => onCreate(item.path),
        });
        items.push({
          id: 'new-folder',
          label: '新建文件夹',
          icon: MenuIcons.newFolder,
          onClick: () => onCreate(item.path),
        });
        items.push({
          id: 'separator-1',
          label: '',
          separator: true,
          onClick: () => {},
        });
      }

      items.push({
        id: 'rename',
        label: '重命名',
        icon: MenuIcons.rename,
        onClick: () => onRename(item),
      });

      items.push({
        id: 'delete',
        label: '删除',
        icon: MenuIcons.delete,
        danger: true,
        onClick: () => onDelete(item),
      });

      if (onRevealInExplorer) {
        items.push({
          id: 'reveal',
          label: '打开文件所在位置',
          icon: MenuIcons.openLocation,
          onClick: () => onRevealInExplorer(item),
        });
      }

      return items;
    },
    [onCreate, onRename, onDelete, onRevealInExplorer]
  );

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

  // Keep the roving focus target valid as the visible list changes
  useEffect(() => {
    if (flattenedItems.length === 0) {
      setFocusPath(null);
      return;
    }
    if (!focusPath || !flattenedItems.some((f) => f.id === focusPath)) {
      const preferred =
        selectedId && flattenedItems.some((f) => f.id === selectedId)
          ? selectedId
          : flattenedItems[0].id;
      setFocusPath(preferred);
    }
  }, [flattenedItems, focusPath, selectedId]);

  // WAI-ARIA treeview keyboard navigation
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tree-path]');
      if (!target) return;
      const path = target.dataset.treePath;
      if (!path) return;
      const index = flattenedItems.findIndex((f) => f.id === path);
      if (index === -1) return;
      const current = flattenedItems[index];

      const moveFocus = (nextIndex: number) => {
        const next = flattenedItems[nextIndex];
        if (!next) return;
        setFocusPath(next.id);
        itemRefs.current.get(next.id)?.focus();
      };

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(index + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(index - 1);
          break;
        case 'Home':
          e.preventDefault();
          moveFocus(0);
          break;
        case 'End':
          e.preventDefault();
          moveFocus(flattenedItems.length - 1);
          break;
        case 'ArrowRight':
          if (current.item.is_folder) {
            e.preventDefault();
            if (!expandedFolders.has(current.id)) {
              onToggle(current.id);
            } else {
              moveFocus(index + 1);
            }
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (current.item.is_folder && expandedFolders.has(current.id)) {
            onToggle(current.id);
          } else if (current.parentPath) {
            setFocusPath(current.parentPath);
            itemRefs.current.get(current.parentPath)?.focus();
          }
          break;
      }
    },
    [flattenedItems, expandedFolders, onToggle]
  );

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
        <div className="space-y-0.5" role="tree" aria-label="笔记列表" onKeyDown={handleTreeKeyDown}>
          {flattenedItems.map(({ item, level }) => (
            <SortableTreeItem
              key={item.path}
              item={item}
              selectedId={selectedId}
              expandedFolders={expandedFolders}
              onSelect={onSelect}
              onToggle={onToggle}
              level={level}
              tabIndex={focusPath === item.path ? 0 : -1}
              registerRef={registerRef}
              onFocusItem={setFocusPath}
              onContextMenu={handleItemContextMenu}
            />
          ))}
        </div>
      </SortableContext>

      <DragOverlay dropAnimation={dropAnimation}>
        {activeItem ? (
          <div
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm shadow-lg"
            style={{ backgroundColor: 'rgba(82, 82, 91, 0.8)', color: '#f4f4f5' }}
          >
            <span style={{ color: '#a1a1aa' }}>
              <GripVertical size={14} />
            </span>
            <span style={{ color: '#a1a1aa' }}>
              {activeItem.is_folder ? <Folder size={16} /> : <FileText size={16} />}
            </span>
            <span>{activeItem.name}</span>
          </div>
        ) : null}
      </DragOverlay>

      {/* Item Context Menu */}
      {contextMenu.visible && contextMenu.targetItem && (
        <ContextMenu
          items={getItemContextMenuItems(contextMenu.targetItem)}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}
    </DndContext>
  );
}
