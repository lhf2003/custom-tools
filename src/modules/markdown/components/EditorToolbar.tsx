import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import { redo, undo } from '@codemirror/commands';
import {
  Bold,
  Code,
  FileCode,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { ActionMenu } from '@/components/ActionMenu';
import type { MenuItem } from '@/types';
import {
  insertCodeBlock,
  insertLink,
  insertTable,
  setHeading,
  toggleBlockquote,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleTaskList,
} from '../editor/commands';

interface EditorToolbarProps {
  view: EditorView | null;
}

interface ToolButtonProps {
  view: EditorView | null;
  icon: React.ElementType;
  label: string;
  command: StateCommand;
}

function ToolButton({ view, icon: Icon, label, command }: ToolButtonProps) {
  return (
    <Tooltip content={label} placement="bottom">
      <button
        type="button"
        className="cm-toolbar-btn"
        aria-label={label}
        onMouseDown={(e) => {
          // mousedown 拦截默认行为：执行命令时编辑器不丢焦点
          e.preventDefault();
          if (view) {
            command(view);
            view.focus();
          }
        }}
      >
        <Icon size={16} />
      </button>
    </Tooltip>
  );
}

function Divider() {
  return <span className="cm-toolbar-divider" />;
}

export function EditorToolbar({ view }: EditorToolbarProps) {
  const runCommand = (command: StateCommand) => () => {
    if (view) {
      command(view);
      view.focus();
    }
  };

  const headingItems: MenuItem[] = [
    { id: 'h1', label: '标题 1', icon: Heading1, onClick: runCommand(setHeading(1)) },
    { id: 'h2', label: '标题 2', icon: Heading2, onClick: runCommand(setHeading(2)) },
    { id: 'h3', label: '标题 3', icon: Heading3, onClick: runCommand(setHeading(3)) },
  ];

  return (
    <div className="cm-toolbar">
      <ActionMenu items={headingItems} label="标题" />
      <Divider />
      <ToolButton view={view} icon={Bold} label="粗体 (Ctrl+B)" command={toggleBold} />
      <ToolButton view={view} icon={Italic} label="斜体 (Ctrl+I)" command={toggleItalic} />
      <ToolButton
        view={view}
        icon={Strikethrough}
        label="删除线 (Ctrl+Shift+X)"
        command={toggleStrikethrough}
      />
      <Divider />
      <ToolButton view={view} icon={List} label="无序列表" command={toggleBulletList} />
      <ToolButton view={view} icon={ListOrdered} label="有序列表" command={toggleOrderedList} />
      <ToolButton view={view} icon={ListTodo} label="任务列表" command={toggleTaskList} />
      <Divider />
      <ToolButton view={view} icon={FileCode} label="代码块" command={insertCodeBlock} />
      <ToolButton view={view} icon={Code} label="行内代码 (Ctrl+E)" command={toggleInlineCode} />
      <Divider />
      <ToolButton view={view} icon={Link} label="链接 (Ctrl+K)" command={insertLink} />
      <ToolButton view={view} icon={Table} label="表格" command={insertTable} />
      <ToolButton view={view} icon={Quote} label="引用" command={toggleBlockquote} />
      <Divider />
      <ToolButton view={view} icon={Undo2} label="撤销 (Ctrl+Z)" command={undo} />
      <ToolButton view={view} icon={Redo2} label="重做 (Ctrl+Y)" command={redo} />
    </div>
  );
}
