// 展示组件：Text / Image / Icon / Video / AudioPlayer

import {
  Star, Heart, Check, X, Info, AlertTriangle, AlertCircle, Calendar, Clock,
  User, Users, Home, Search, Settings, Folder, File, Download, Upload,
  Pencil, Trash2, Plus, ArrowRight, BarChart3, List, Mail, Phone, Lock,
  Unlock, Eye, Globe, MapPin, RefreshCw, Send, Copy, HelpCircle,
  type LucideIcon,
} from 'lucide-react';
import { toDisplayString } from '../functions';
import { useA2ui } from '../render';
import type { A2uiComponentDef } from '../types';

export const DISPLAY_TYPES = new Set(['Text', 'Image', 'Icon', 'Video', 'AudioPlayer']);

const TEXT_VARIANTS: Record<string, string> = {
  h1: 'text-xl font-semibold text-zinc-100',
  h2: 'text-lg font-semibold text-zinc-100',
  h3: 'text-base font-semibold text-zinc-200',
  h4: 'text-sm font-semibold text-zinc-200',
  h5: 'text-sm font-medium text-zinc-300',
  body: 'text-sm text-zinc-300',
  caption: 'text-xs text-zinc-500',
};

const ICONS: Record<string, LucideIcon> = {
  star: Star, heart: Heart, check: Check, x: X, close: X, info: Info,
  warning: AlertTriangle, error: AlertCircle, calendar: Calendar, clock: Clock,
  user: User, users: Users, home: Home, search: Search, settings: Settings,
  folder: Folder, file: File, download: Download, upload: Upload, edit: Pencil,
  delete: Trash2, trash: Trash2, add: Plus, plus: Plus, arrowRight: ArrowRight,
  chart: BarChart3, list: List, mail: Mail, phone: Phone, lock: Lock,
  unlock: Unlock, eye: Eye, globe: Globe, mapPin: MapPin, refresh: RefreshCw,
  send: Send, copy: Copy,
};

function Text({ def }: { def: A2uiComponentDef }) {
  const { resolve } = useA2ui();
  const text = toDisplayString(resolve(def.text));
  const variant = typeof def.variant === 'string' ? def.variant : 'body';
  return (
    <div className={TEXT_VARIANTS[variant] ?? TEXT_VARIANTS.body}>{text}</div>
  );
}

function Image({ def }: { def: A2uiComponentDef }) {
  const { resolve } = useA2ui();
  const url = toDisplayString(resolve(def.url));
  if (!url) return null;
  const fit = typeof def.fit === 'string' ? def.fit : 'cover';
  return (
    <img
      src={url}
      alt={toDisplayString(resolve(def.description))}
      className="rounded-lg max-w-full max-h-48"
      style={{ objectFit: fit as React.CSSProperties['objectFit'] }}
    />
  );
}

function Icon({ def }: { def: A2uiComponentDef }) {
  const name = typeof def.name === 'string' ? def.name : '';
  const IconCmp = ICONS[name] ?? HelpCircle;
  return <IconCmp className="w-4 h-4 text-zinc-400 shrink-0" />;
}

function Video({ def }: { def: A2uiComponentDef }) {
  const { resolve } = useA2ui();
  const url = toDisplayString(resolve(def.url));
  if (!url) return null;
  return <video src={url} controls className="w-full rounded-lg max-h-56" />;
}

function AudioPlayer({ def }: { def: A2uiComponentDef }) {
  const { resolve } = useA2ui();
  const url = toDisplayString(resolve(def.url));
  if (!url) return null;
  return <audio src={url} controls className="w-full h-8" />;
}

export function DisplayComponent({ def }: { def: A2uiComponentDef }) {
  switch (def.component) {
    case 'Text':
      return <Text def={def} />;
    case 'Image':
      return <Image def={def} />;
    case 'Icon':
      return <Icon def={def} />;
    case 'Video':
      return <Video def={def} />;
    case 'AudioPlayer':
      return <AudioPlayer def={def} />;
    default:
      return null;
  }
}
