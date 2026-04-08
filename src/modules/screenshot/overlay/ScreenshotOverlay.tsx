import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useToastStore } from '@/stores/toastStore';
import {
  Check,
  Copy,
  X,
  Type,
  Square,
  ArrowRight,
  Sparkles,
} from 'lucide-react';

interface WindowBounds {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Selection {
  x: number;
  y: number;
  width: number;
  height: number;
  source: { type: 'window'; windowId: number; title: string } | { type: 'region' };
}

type EditMode = 'none' | 'rect' | 'arrow' | 'text' | 'mosaic';

interface DrawElement {
  id: string;
  type: EditMode;
  x: number;
  y: number;
  width?: number;
  height?: number;
  x2?: number;
  y2?: number;
  text?: string;
}

export default function ScreenshotOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [windows, setWindows] = useState<WindowBounds[]>([]);
  const [hoveredWindow, setHoveredWindow] = useState<WindowBounds | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<Selection | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [scaleFactor, setScaleFactor] = useState(1);

  // 编辑状态
  const [editMode, setEditMode] = useState<EditMode>('none');
  const [drawElements, setDrawElements] = useState<DrawElement[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentElement, setCurrentElement] = useState<DrawElement | null>(null);

  // OCR 状态
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrResult, setOcrResult] = useState<string>('');
  const [showOcrResult, setShowOcrResult] = useState(false);

  const { addToast } = useToastStore();

  // 关闭遮罩窗口
  const closeOverlay = useCallback(async () => {
    console.log('[ScreenshotOverlay] Attempting to close overlay...');
    try {
      const overlayWindow = await WebviewWindow.getByLabel('screenshot-overlay');
      console.log('[ScreenshotOverlay] Got overlay window:', overlayWindow);

      if (overlayWindow) {
        await overlayWindow.close();
        console.log('[ScreenshotOverlay] Overlay closed successfully');
      } else {
        console.error('[ScreenshotOverlay] Overlay window not found by label');
        // 备选方案：通过 invoke 命令关闭
        try {
          await invoke('close_screenshot_overlay');
          console.log('[ScreenshotOverlay] Overlay closed via invoke command');
        } catch (invokeErr) {
          console.error('[ScreenshotOverlay] Invoke close also failed:', invokeErr);
        }
      }
    } catch (err) {
      console.error('[ScreenshotOverlay] Failed to close overlay:', err);
      // 备选方案
      try {
        await invoke('close_screenshot_overlay');
        console.log('[ScreenshotOverlay] Overlay closed via fallback invoke');
      } catch (fallbackErr) {
        console.error('[ScreenshotOverlay] Fallback close also failed:', fallbackErr);
      }
    }
  }, []);

  // 初始化：获取所有窗口和屏幕信息
  useEffect(() => {
    console.log('[ScreenshotOverlay] Initializing overlay...');
    const init = async () => {
      try {
        // 获取 DPI 缩放因子
        const overlayWindow = await WebviewWindow.getByLabel('screenshot-overlay');
        console.log('[ScreenshotOverlay] Got window for scale factor:', overlayWindow);
        if (overlayWindow) {
          const sf = await overlayWindow.scaleFactor();
          setScaleFactor(sf);
          console.log('[ScreenshotOverlay] Scale factor:', sf);
        }

        // 获取所有窗口
        const windowList = await invoke<WindowBounds[]>('get_all_windows');
        console.log('[ScreenshotOverlay] Got windows:', windowList.length);
        setWindows(windowList);
      } catch (err) {
        console.error('[ScreenshotOverlay] Failed to init overlay:', err);
      }
    };

    init();

    // 确保窗口获得焦点 - 增加重试机制
    const focusOverlay = () => {
      console.log('[ScreenshotOverlay] Focusing overlay window...');
      window.focus();
      document.body.focus();
      containerRef.current?.focus();
    };

    // 立即尝试
    focusOverlay();

    // 多次延迟尝试确保获得焦点
    const timeouts = [50, 150, 300].map(delay =>
      setTimeout(focusOverlay, delay)
    );

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, []);

  // ESC 键处理 - 使用 ref 来避免依赖项问题
  const stateRef = useRef({
    isDragging,
    selectedRegion,
    editMode,
    showOcrResult,
    isOcrProcessing,
  });

  // 同步 ref 和 state
  useEffect(() => {
    stateRef.current = { isDragging, selectedRegion, editMode, showOcrResult, isOcrProcessing };
  }, [isDragging, selectedRegion, editMode, showOcrResult, isOcrProcessing]);

  // 键盘事件处理
  useEffect(() => {
    console.log('[ScreenshotOverlay] Setting up keyboard listeners');
    const handleKeyDown = async (e: KeyboardEvent) => {
      const state = stateRef.current;
      console.log('[ScreenshotOverlay] Key pressed:', e.key, 'State:', {
        showOcrResult: state.showOcrResult,
        editMode: state.editMode,
        isDragging: state.isDragging,
        selectedRegion: state.selectedRegion ? 'yes' : 'no',
      });

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        console.log('[ScreenshotOverlay] ESC pressed, handling...');

        if (state.showOcrResult) {
          console.log('[ScreenshotOverlay] Closing OCR result');
          setShowOcrResult(false);
          return;
        }

        if (state.editMode !== 'none') {
          console.log('[ScreenshotOverlay] Exiting edit mode:', state.editMode);
          setEditMode('none');
          return;
        }

        if (state.isDragging) {
          console.log('[ScreenshotOverlay] Canceling drag');
          setIsDragging(false);
          setDragStart(null);
          setDragCurrent(null);
          return;
        }

        if (state.selectedRegion) {
          console.log('[ScreenshotOverlay] Clearing selection');
          setSelectedRegion(null);
          setDrawElements([]);
          return;
        }

        // 没有任何状态时，关闭窗口
        console.log('[ScreenshotOverlay] Closing overlay window');
        await closeOverlay();
        return;
      }

      // Enter 键确认截图
      if (e.key === 'Enter' && state.selectedRegion && !state.isOcrProcessing) {
        e.preventDefault();
        captureSelection();
        return;
      }

      // Ctrl+C 复制
      if (e.key === 'c' && e.ctrlKey && state.selectedRegion) {
        e.preventDefault();
        copyToClipboard();
        return;
      }

      // Ctrl+S 保存
      if (e.key === 's' && e.ctrlKey && state.selectedRegion) {
        e.preventDefault();
        captureSelection();
        return;
      }
    };

    // 同时绑定到 window 和 document，确保事件被捕获
    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    console.log('[ScreenshotOverlay] Keyboard listeners attached');

    return () => {
      console.log('[ScreenshotOverlay] Removing keyboard listeners');
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [closeOverlay]);

  // 绘制遮罩层
  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置 canvas 尺寸为屏幕尺寸
    canvas.width = window.screen.width * scaleFactor;
    canvas.height = window.screen.height * scaleFactor;
    ctx.scale(scaleFactor, scaleFactor);

    // 清空画布
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 如果有选区或拖拽中，绘制遮罩
    const highlightRegion = selectedRegion || (isDragging && dragStart && dragCurrent
      ? {
          x: Math.min(dragStart.x, dragCurrent.x),
          y: Math.min(dragStart.y, dragCurrent.y),
          width: Math.abs(dragCurrent.x - dragStart.x),
          height: Math.abs(dragCurrent.y - dragStart.y),
        }
      : hoveredWindow);

    if (highlightRegion) {
      // 绘制半透明遮罩（全屏）
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, window.screen.width, window.screen.height);

      // 镂空选中区域
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillRect(highlightRegion.x, highlightRegion.y, highlightRegion.width, highlightRegion.height);
      ctx.globalCompositeOperation = 'source-over';

      // 绘制边框
      if (selectedRegion || isDragging) {
        ctx.strokeStyle = '#0099FF'; // 蓝色：已选中
      } else {
        ctx.strokeStyle = '#00D26A'; // 绿色：悬停
      }
      ctx.lineWidth = 2;
      ctx.strokeRect(highlightRegion.x, highlightRegion.y, highlightRegion.width, highlightRegion.height);

      // 绘制尺寸提示
      if (isDragging || selectedRegion) {
        const sizeText = `${Math.round(highlightRegion.width)} x ${Math.round(highlightRegion.height)}`;
        ctx.font = '12px sans-serif';
        const textWidth = ctx.measureText(sizeText).width;

        ctx.fillStyle = '#0099FF';
        ctx.fillRect(
          highlightRegion.x + highlightRegion.width / 2 - textWidth / 2 - 4,
          highlightRegion.y - 24,
          textWidth + 8,
          20
        );

        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          sizeText,
          highlightRegion.x + highlightRegion.width / 2,
          highlightRegion.y - 14
        );
      }

      // 绘制标注元素
      drawElements.forEach((element) => {
        ctx.strokeStyle = '#FF5722';
        ctx.fillStyle = '#FF5722';
        ctx.lineWidth = 2;

        switch (element.type) {
          case 'rect':
            if (element.width && element.height) {
              ctx.strokeRect(element.x, element.y, element.width, element.height);
            }
            break;
          case 'arrow':
            if (element.x2 !== undefined && element.y2 !== undefined) {
              drawArrow(ctx, element.x, element.y, element.x2, element.y2);
            }
            break;
          case 'text':
            if (element.text) {
              ctx.font = '16px sans-serif';
              ctx.fillStyle = '#FFFFFF';
              ctx.strokeStyle = '#000000';
              ctx.lineWidth = 3;
              ctx.strokeText(element.text, element.x, element.y);
              ctx.fillText(element.text, element.x, element.y);
            }
            break;
        }
      });

      // 绘制当前正在绘制的元素
      if (currentElement) {
        ctx.strokeStyle = '#FF5722';
        ctx.fillStyle = '#FF5722';
        ctx.lineWidth = 2;

        switch (currentElement.type) {
          case 'rect':
            if (currentElement.width && currentElement.height) {
              ctx.strokeRect(currentElement.x, currentElement.y, currentElement.width, currentElement.height);
            }
            break;
          case 'arrow':
            if (currentElement.x2 !== undefined && currentElement.y2 !== undefined) {
              drawArrow(ctx, currentElement.x, currentElement.y, currentElement.x2, currentElement.y2);
            }
            break;
        }
      }
    } else {
      // 没有悬停窗口时，全屏半透明遮罩
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, window.screen.width, window.screen.height);
    }
  }, [hoveredWindow, selectedRegion, isDragging, dragStart, dragCurrent, scaleFactor, drawElements, currentElement]);

  // 绘制箭头
  const drawArrow = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) => {
    const headLength = 10;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  };

  // 重绘画布
  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // 鼠标移动：检测窗口或绘制
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (editMode !== 'none' && isDrawing && currentElement) {
      // 编辑模式下绘制
      const newElement = { ...currentElement };
      if (editMode === 'rect') {
        newElement.width = e.clientX - currentElement.x;
        newElement.height = e.clientY - currentElement.y;
      } else if (editMode === 'arrow') {
        newElement.x2 = e.clientX;
        newElement.y2 = e.clientY;
      }
      setCurrentElement(newElement);
      return;
    }

    if (selectedRegion) return; // 已选中则不再检测
    if (isDragging && dragStart) {
      setDragCurrent({ x: e.clientX, y: e.clientY });
      return;
    }

    // 检测鼠标下的窗口
    const pointX = e.clientX;
    const pointY = e.clientY;

    const window = windows.find((w) =>
      pointX >= w.x &&
      pointX < w.x + w.width &&
      pointY >= w.y &&
      pointY < w.y + w.height
    );

    setHoveredWindow(window || null);
  }, [windows, selectedRegion, isDragging, dragStart, editMode, isDrawing, currentElement]);

  // 鼠标按下：开始拖拽或绘制
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    console.log('[ScreenshotOverlay] Mouse down:', { editMode, hasSelectedRegion: !!selectedRegion, hasHoveredWindow: !!hoveredWindow });

    if (editMode !== 'none') {
      // 编辑模式下开始绘制
      setIsDrawing(true);
      setCurrentElement({
        id: Math.random().toString(36).substring(2, 9),
        type: editMode,
        x: e.clientX,
        y: e.clientY,
        width: 0,
        height: 0,
      });
      return;
    }

    if (selectedRegion) {
      // 已选中状态下点击，取消选择
      console.log('[ScreenshotOverlay] Clicked while has selection, clearing');
      setSelectedRegion(null);
      setDrawElements([]);
      return;
    }

    if (hoveredWindow) {
      // 点击窗口：直接选中该窗口
      console.log('[ScreenshotOverlay] Selecting window:', hoveredWindow);
      setSelectedRegion({
        x: hoveredWindow.x,
        y: hoveredWindow.y,
        width: hoveredWindow.width,
        height: hoveredWindow.height,
        source: {
          type: 'window',
          windowId: hoveredWindow.id,
          title: hoveredWindow.title,
        },
      });
    } else {
      // 空白处：开始拖拽选区
      console.log('[ScreenshotOverlay] Starting drag selection at:', e.clientX, e.clientY);
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
      setDragCurrent({ x: e.clientX, y: e.clientY });
    }
  }, [hoveredWindow, selectedRegion, editMode]);

  // 监听 selectedRegion 变化
  useEffect(() => {
    console.log('[ScreenshotOverlay] selectedRegion changed:', selectedRegion);
  }, [selectedRegion]);

  // 鼠标抬起：结束拖拽或绘制
  const handleMouseUp = useCallback(() => {
    if (editMode !== 'none' && isDrawing && currentElement) {
      // 完成绘制元素
      const element = { ...currentElement };
      if (element.type === 'rect' && element.width && element.height) {
        // 确保宽高为正
        if (element.width < 0) {
          element.x += element.width;
          element.width = Math.abs(element.width);
        }
        if (element.height < 0) {
          element.y += element.height;
          element.height = Math.abs(element.height);
        }
      }

      // 过滤掉太小的元素
      if ((element.type === 'rect' && element.width! > 5 && element.height! > 5) ||
          (element.type === 'arrow' && (element.x2 !== element.x || element.y2 !== element.y))) {
        setDrawElements((prev) => [...prev, element]);
      }

      setIsDrawing(false);
      setCurrentElement(null);
      return;
    }

    if (isDragging && dragStart && dragCurrent) {
      const width = Math.abs(dragCurrent.x - dragStart.x);
      const height = Math.abs(dragCurrent.y - dragStart.y);

      console.log('[ScreenshotOverlay] Drag ended, size:', width, 'x', height);

      // 最小选区尺寸过滤
      if (width > 10 && height > 10) {
        const newSelection = {
          x: Math.min(dragStart.x, dragCurrent.x),
          y: Math.min(dragStart.y, dragCurrent.y),
          width,
          height,
          source: { type: 'region' as const },
        };
        console.log('[ScreenshotOverlay] Setting selectedRegion from drag:', newSelection);
        setSelectedRegion(newSelection);
      } else {
        console.log('[ScreenshotOverlay] Selection too small, ignoring');
      }

      setIsDragging(false);
      setDragStart(null);
      setDragCurrent(null);
    }
  }, [isDragging, dragStart, dragCurrent, editMode, isDrawing, currentElement]);

  // 执行截图
  const captureSelection = async () => {
    if (!selectedRegion) return;

    try {
      const result = await invoke<{
        filename: string;
        filepath: string;
        width: number;
        height: number;
      }>('capture_region', {
        x: selectedRegion.x,
        y: selectedRegion.y,
        width: selectedRegion.width,
        height: selectedRegion.height,
      });

      // 复制到剪贴板
      await invoke('copy_file_to_clipboard', { filepath: result.filepath });

      // 显示成功提示
      addToast({
        type: 'success',
        title: '截图已保存',
        message: `${result.filename} (${result.width}x${result.height})`,
        duration: 3000,
      });

      // 关闭遮罩
      await closeOverlay();
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
      addToast({
        type: 'error',
        title: '截图失败',
        message: String(error),
        duration: 5000,
      });
    }
  };

  // 复制到剪贴板
  const copyToClipboard = async () => {
    if (!selectedRegion) return;

    try {
      const result = await invoke<{
        filename: string;
        filepath: string;
        width: number;
        height: number;
      }>('capture_region', {
        x: selectedRegion.x,
        y: selectedRegion.y,
        width: selectedRegion.width,
        height: selectedRegion.height,
      });

      await invoke('copy_file_to_clipboard', { filepath: result.filepath });

      addToast({
        type: 'success',
        title: '已复制到剪贴板',
        duration: 2000,
      });

      await closeOverlay();
    } catch (error) {
      console.error('Failed to copy screenshot:', error);
      addToast({
        type: 'error',
        title: '复制失败',
        message: String(error),
        duration: 5000,
      });
    }
  };

  // OCR 识别
  const performOcr = async () => {
    if (!selectedRegion) return;

    setIsOcrProcessing(true);
    try {
      const result = await invoke<{
        filename: string;
        filepath: string;
      }>('capture_region', {
        x: selectedRegion.x,
        y: selectedRegion.y,
        width: selectedRegion.width,
        height: selectedRegion.height,
      });

      const ocrText = await invoke<string>('ocr_screenshot', {
        filepath: result.filepath,
        prompt: '请识别图片中的文字内容，只返回文字，不要其他解释',
      });

      setOcrResult(ocrText);
      setShowOcrResult(true);

      // 复制 OCR 结果到剪贴板
      await invoke('copy_text_to_clipboard', { text: ocrText });

      addToast({
        type: 'success',
        title: 'OCR 识别完成',
        message: '文字已复制到剪贴板',
        duration: 3000,
      });
    } catch (error) {
      console.error('OCR failed:', error);
      addToast({
        type: 'error',
        title: 'OCR 识别失败',
        message: String(error),
        duration: 5000,
      });
    } finally {
      setIsOcrProcessing(false);
    }
  };

  // 计算工具栏位置
  const getToolbarPosition = () => {
    console.log('[ScreenshotOverlay] Calculating toolbar position, selectedRegion:', selectedRegion);
    if (!selectedRegion) return null;

    const toolbarWidth = 320; // 估算工具栏宽度
    const toolbarHeight = 60; // 估算工具栏高度
    const padding = 16;

    let left = selectedRegion.x + selectedRegion.width / 2;
    let top = selectedRegion.y + selectedRegion.height + padding;

    // 如果工具栏会超出屏幕底部，显示在选区上方
    if (top + toolbarHeight > window.innerHeight) {
      top = selectedRegion.y - toolbarHeight - padding;
    }

    // 确保水平居中不超出屏幕
    const minLeft = toolbarWidth / 2 + padding;
    const maxLeft = window.innerWidth - toolbarWidth / 2 - padding;
    left = Math.max(minLeft, Math.min(left, maxLeft));

    return { left, top };
  };

  const toolbarPos = getToolbarPosition();

  // 工具栏按钮
  const toolbarButtons = [
    { id: 'save', icon: Check, label: '保存', shortcut: 'Enter', onClick: captureSelection, primary: true },
    { id: 'copy', icon: Copy, label: '复制', shortcut: 'Ctrl+C', onClick: copyToClipboard },
    { id: 'rect', icon: Square, label: '矩形', shortcut: '', onClick: () => setEditMode(editMode === 'rect' ? 'none' : 'rect'), active: editMode === 'rect' },
    { id: 'arrow', icon: ArrowRight, label: '箭头', shortcut: '', onClick: () => setEditMode(editMode === 'arrow' ? 'none' : 'arrow'), active: editMode === 'arrow' },
    { id: 'text', icon: Type, label: '文字', shortcut: '', onClick: () => setEditMode(editMode === 'text' ? 'none' : 'text'), active: editMode === 'text' },
    { id: 'ocr', icon: Sparkles, label: 'OCR', shortcut: '', onClick: performOcr, loading: isOcrProcessing },
    { id: 'cancel', icon: X, label: '取消', shortcut: 'ESC', onClick: () => { setSelectedRegion(null); setDrawElements([]); } },
  ];

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 select-none outline-none ${editMode === 'none' ? 'cursor-crosshair' : 'cursor-default'}`}
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      tabIndex={-1}
      onKeyDown={(e) => {
        // 只阻止非 ESC 键的默认行为，避免干扰 ESC 退出功能
        if (e.key !== 'Escape') {
          e.preventDefault();
        }
      }}
    >
      {/* Canvas 遮罩层 */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: '100%', height: '100%' }}
      />

      {/* 悬停窗口提示 */}
      {hoveredWindow && !selectedRegion && !isDragging && editMode === 'none' && (
        <div
          className="absolute px-2 py-1 bg-black/80 text-white text-xs rounded pointer-events-none"
          style={{
            left: hoveredWindow.x + 8,
            top: hoveredWindow.y + 8,
          }}
        >
          <div className="font-medium">{hoveredWindow.title || '无标题'}</div>
          <div className="text-gray-400 text-[10px]">{hoveredWindow.appName}</div>
        </div>
      )}

      {/* 底部工具栏 */}
      {selectedRegion && toolbarPos && (
        <div
          className="fixed flex items-center gap-1 px-2 py-1.5 bg-gray-800/95 backdrop-blur rounded-lg shadow-xl border border-gray-700 z-50"
          style={{
            left: toolbarPos.left,
            top: toolbarPos.top,
            transform: 'translateX(-50%)',
          }}
        >
          {toolbarButtons.map((button) => (
            <button
              key={button.id}
              onClick={(e) => {
                e.stopPropagation();
                button.onClick();
              }}
              disabled={button.loading}
              className={`relative flex flex-col items-center gap-0.5 px-3 py-1.5 rounded transition-all ${
                button.primary
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : button.active
                  ? 'bg-orange-500/30 text-orange-400 border border-orange-500/50'
                  : 'hover:bg-gray-700 text-gray-300'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
              title={`${button.label} ${button.shortcut ? `(${button.shortcut})` : ''}`}
            >
              {button.loading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <button.icon className="w-4 h-4" />
              )}
              <span className="text-[10px]">{button.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* OCR 结果弹窗 */}
      {showOcrResult && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50" onClick={() => setShowOcrResult(false)}>
          <div className="bg-gray-800 rounded-lg shadow-xl border border-gray-700 w-[500px] max-w-[90vw] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <h3 className="text-white font-medium flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-yellow-400" />
                OCR 识别结果
              </h3>
              <button
                onClick={() => setShowOcrResult(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 overflow-auto">
              <textarea
                value={ocrResult}
                onChange={(e) => setOcrResult(e.target.value)}
                className="w-full h-48 bg-gray-900 text-white text-sm p-3 rounded border border-gray-700 focus:border-blue-500 focus:outline-none resize-none"
                placeholder="识别结果..."
              />
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
              <button
                onClick={() => {
                  invoke('copy_text_to_clipboard', { text: ocrResult });
                  addToast({ type: 'success', title: '已复制到剪贴板', duration: 2000 });
                }}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
              >
                <Copy className="w-4 h-4" />
                复制
              </button>
              <button
                onClick={() => setShowOcrResult(false)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑模式提示 */}
      {editMode !== 'none' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-orange-500/90 text-white text-sm rounded-lg shadow-lg z-40">
          {editMode === 'rect' && '矩形标注模式：拖拽绘制矩形'}
          {editMode === 'arrow' && '箭头标注模式：拖拽绘制箭头'}
          {editMode === 'text' && '文字标注模式：点击添加文字'}
          <span className="ml-2 text-white/70">(按 ESC 退出)</span>
        </div>
      )}

      {/* 提示文字 */}
      {!selectedRegion && editMode === 'none' && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/70 text-sm pointer-events-none">
          点击窗口截图，或拖拽选择区域，按 ESC 退出
        </div>
      )}
    </div>
  );
}
