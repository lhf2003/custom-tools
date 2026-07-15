import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useToastStore } from '@/stores/toastStore';
import { Toolbar } from './Toolbar';
import {
  Check,
  Copy,
  X,
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
  const [monitorOffset, setMonitorOffset] = useState({ x: 0, y: 0 });
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null);
  const backgroundPathRef = useRef('');
  const dragStartHoveredWindowRef = useRef<WindowBounds | null>(null);

  // 延迟操作 timeout 引用
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseUpTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimeout = useCallback(() => {
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
  }, []);

  const clearMouseUpTimeout = useCallback(() => {
    if (mouseUpTimeoutRef.current) {
      clearTimeout(mouseUpTimeoutRef.current);
      mouseUpTimeoutRef.current = null;
    }
  }, []);

  // 编辑状态
  const [editMode, setEditMode] = useState<EditMode>('none');
  const [drawElements, setDrawElements] = useState<DrawElement[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentElement, setCurrentElement] = useState<DrawElement | null>(null);

  // OCR 状态
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrResult, setOcrResult] = useState<string>('');
  const [showOcrResult, setShowOcrResult] = useState(false);

  // 文字输入状态
  const [textInput, setTextInput] = useState<{ id?: string; x: number; y: number; text: string } | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const placingTextRef = useRef(false);
  const isDraggingTextInputRef = useRef(false);
  const textDragStartRef = useRef({ mx: 0, my: 0, x: 0, y: 0 });

  // 选区移动/调整大小交互状态
  type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
  type InteractionMode = 'none' | 'moving' | 'resizing';
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('none');
  const [activeHandle, setActiveHandle] = useState<Handle | null>(null);
  const interactionStartRef = useRef<{
    startX: number;
    startY: number;
    originalRegion: Selection;
  } | null>(null);
  const [hoverTarget, setHoverTarget] = useState<Handle | 'body' | null>(null);

  useEffect(() => {
    if (textInput) {
      textInputRef.current?.focus();
    }
  }, [textInput]);

  // 正中央提示（截图成功/复制成功）
  const [centerTip, setCenterTip] = useState<{ text: string; icon: 'success' | 'copy' } | null>(null);

  const { addToast } = useToastStore();

  // centerTip 自动消失
  useEffect(() => {
    if (!centerTip) return;
    const id = setTimeout(() => setCenterTip(null), 1500);
    return () => clearTimeout(id);
  }, [centerTip]);

  // 重置状态（窗口复用时调用）
  const resetState = useCallback(() => {
    setWindows([]);
    setHoveredWindow(null);
    setSelectedRegion(null);
    setIsDragging(false);
    setDragStart(null);
    setDragCurrent(null);
    setScaleFactor(1);
    setMonitorOffset({ x: 0, y: 0 });
    setBackgroundImage(null);
    backgroundPathRef.current = '';
    dragStartHoveredWindowRef.current = null;
    setEditMode('none');
    setDrawElements([]);
    setIsDrawing(false);
    setCurrentElement(null);
    setIsOcrProcessing(false);
    setOcrResult('');
    setShowOcrResult(false);
    setCenterTip(null);
    setTextInput(null);
    setInteractionMode('none');
    setActiveHandle(null);
    setHoverTarget(null);
    interactionStartRef.current = null;
    clearPendingTimeout();
    clearMouseUpTimeout();
  }, [clearPendingTimeout, clearMouseUpTimeout]);

  // 仅隐藏遮罩窗口（不清理背景图，供保存后复用窗口使用）
  const hideOverlay = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().hide();
    } catch (err) {
      console.error('[ScreenshotOverlay] Failed to hide overlay:', err);
      await invoke('close_screenshot_overlay').catch(() => {});
    }
  }, []);

  // 关闭遮罩窗口（复用窗口：hide 而非 close，并清理背景图）
  const closeOverlay = useCallback(async () => {
    clearPendingTimeout();
    clearMouseUpTimeout();

    const path = backgroundPathRef.current;
    try {
      if (path) {
        await invoke('cleanup_overlay_background', { filepath: path });
        backgroundPathRef.current = '';
      }
    } catch (cleanupErr) {
      console.warn('[ScreenshotOverlay] Failed to cleanup background:', cleanupErr);
    }

    await hideOverlay();
  }, [hideOverlay, clearPendingTimeout, clearMouseUpTimeout]);

  // 初始化：监听显示器信息和背景图事件，窗口复用时自动重置状态
  useEffect(() => {
    // 确保窗口获得焦点
    const focusOverlay = () => {
      document.documentElement.focus();
      document.body.focus();
      containerRef.current?.focus();
    };

    // 监听显示器信息事件（窗口首次显示和复用时都会触发）
    const unlistenMonitor = listen<{
      x: number;
      y: number;
      width: number;
      height: number;
      scaleFactor: number;
      backgroundImagePath: string;
    }>('screenshot-overlay-monitor', (event) => {
      resetState();
      focusOverlay();
      const info = event.payload;
      setMonitorOffset({ x: info.x, y: info.y });
      setScaleFactor(info.scaleFactor);
      // 背景图通过 screenshot-overlay-background 事件异步下发

      // 并行获取窗口列表
      invoke<WindowBounds[]>('get_all_windows')
        .then(setWindows)
        .catch((err) => console.error('[ScreenshotOverlay] Failed to get windows:', err));
    });

    // 监听背景图捕获完成事件
    const unlistenBackground = listen<string>('screenshot-overlay-background', (event) => {
      const path = event.payload;
      if (path) {
        backgroundPathRef.current = path;
        const img = new Image();
        img.onload = () => setBackgroundImage(img);
        img.src = `file://${path.replace(/\\/g, '/')}`;
      }
    });

    focusOverlay();
    const timeouts = [50, 100, 200, 400].map((delay) => setTimeout(focusOverlay, delay));

    return () => {
      timeouts.forEach(clearTimeout);
      unlistenMonitor.then((f) => f()).catch(() => {});
      unlistenBackground.then((f) => f()).catch(() => {});
    };
  }, [resetState]);

  // ESC 键处理 - 使用 ref 来避免依赖项问题
  const stateRef = useRef({
    isDragging,
    selectedRegion,
    editMode,
    showOcrResult,
    isOcrProcessing,
    textInput,
  });

  // 同步 ref 和 state
  useEffect(() => {
    stateRef.current = { isDragging, selectedRegion, editMode, showOcrResult, isOcrProcessing, textInput };
  }, [isDragging, selectedRegion, editMode, showOcrResult, isOcrProcessing, textInput]);

  // 键盘事件处理
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const state = stateRef.current;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();

        if (state.showOcrResult) {
          setShowOcrResult(false);
          return;
        }

        if (state.textInput) {
          setTextInput(null);
          setEditMode('none');
          return;
        }

        if (state.editMode !== 'none') {
          setEditMode('none');
          return;
        }

        if (interactionMode !== 'none') {
          if (interactionStartRef.current) {
            setSelectedRegion(interactionStartRef.current.originalRegion);
          }
          setInteractionMode('none');
          setActiveHandle(null);
          interactionStartRef.current = null;
          return;
        }

        if (state.isDragging) {
          setIsDragging(false);
          setDragStart(null);
          setDragCurrent(null);
          return;
        }

        if (state.selectedRegion) {
          if (state.selectedRegion.source.type === 'region') {
            await closeOverlay();
          } else {
            setSelectedRegion(null);
            setDrawElements([]);
          }
          return;
        }

        await closeOverlay();
        return;
      }

      // Enter 键确认截图
      if (e.key === 'Enter' && state.selectedRegion && !state.isOcrProcessing) {
        e.preventDefault();
        e.stopPropagation();
        setTimeout(() => captureSelection(), 0);
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

    return () => {
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

    // 设置 canvas 尺寸为当前窗口尺寸（即单个显示器尺寸）
    canvas.width = window.innerWidth * scaleFactor;
    canvas.height = window.innerHeight * scaleFactor;
    ctx.scale(scaleFactor, scaleFactor);

    // 清空画布（使用逻辑坐标）
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    const offsetX = monitorOffset.x;
    const offsetY = monitorOffset.y;

    // 如果有选区或拖拽中，绘制遮罩
    const highlightRegion = selectedRegion || (isDragging && dragStart && dragCurrent
      ? {
          x: Math.min(dragStart.x, dragCurrent.x),
          y: Math.min(dragStart.y, dragCurrent.y),
          width: Math.abs(dragCurrent.x - dragStart.x),
          height: Math.abs(dragCurrent.y - dragStart.y),
        }
      : hoveredWindow);

    // 绘制屏幕底图（冻结画面）
    if (backgroundImage) {
      ctx.drawImage(backgroundImage, 0, 0, window.innerWidth, window.innerHeight);
    }

    // 全屏遮罩（透明，不再暗化未选中区域）
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    if (highlightRegion) {
      // Canvas 使用逻辑坐标，将物理坐标转换为逻辑坐标
      const drawX = (highlightRegion.x - offsetX) / scaleFactor;
      const drawY = (highlightRegion.y - offsetY) / scaleFactor;
      const drawW = highlightRegion.width / scaleFactor;
      const drawH = highlightRegion.height / scaleFactor;

      // 在选区位置重新绘制清晰的背景图（覆盖遮罩层，实现高亮效果）
      if (backgroundImage) {
        ctx.drawImage(
          backgroundImage,
          highlightRegion.x - offsetX, // 物理源 x
          highlightRegion.y - offsetY, // 物理源 y
          highlightRegion.width,       // 物理源宽
          highlightRegion.height,      // 物理源高
          drawX,                       // 逻辑目标 x
          drawY,                       // 逻辑目标 y
          drawW,                       // 逻辑目标宽
          drawH                        // 逻辑目标高
        );
      }

      // 绘制边框（统一颜色）
      ctx.strokeStyle = '#0099FF';
      ctx.lineWidth = 2;
      ctx.strokeRect(drawX, drawY, drawW, drawH);

      // 绘制尺寸提示
      if (isDragging || selectedRegion) {
        const sizeText = `${Math.round(highlightRegion.width)} x ${Math.round(highlightRegion.height)}`;
        ctx.font = '12px sans-serif';
        const textWidth = ctx.measureText(sizeText).width;

        ctx.fillStyle = '#0099FF';
        ctx.fillRect(
          drawX + drawW / 2 - textWidth / 2 - 4,
          drawY - 24,
          textWidth + 8,
          20
        );

        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          sizeText,
          drawX + drawW / 2,
          drawY - 14
        );
      }

      // 绘制调整大小手柄
      if (selectedRegion) {
        const handleSize = 4; // 逻辑像素（半边长），实际显示 8x8
        const handlePositions = [
          { x: drawX, y: drawY },
          { x: drawX + drawW / 2, y: drawY },
          { x: drawX + drawW, y: drawY },
          { x: drawX + drawW, y: drawY + drawH / 2 },
          { x: drawX + drawW, y: drawY + drawH },
          { x: drawX + drawW / 2, y: drawY + drawH },
          { x: drawX, y: drawY + drawH },
          { x: drawX, y: drawY + drawH / 2 },
        ];
        handlePositions.forEach((pos) => {
          ctx.fillStyle = '#0099FF';
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 1;
          ctx.fillRect(pos.x - handleSize, pos.y - handleSize, handleSize * 2, handleSize * 2);
          ctx.strokeRect(pos.x - handleSize, pos.y - handleSize, handleSize * 2, handleSize * 2);
        });
      }

      // 绘制标注元素（坐标转为相对窗口的逻辑坐标）
      drawElements.forEach((element) => {
        ctx.strokeStyle = '#FF5722';
        ctx.fillStyle = '#FF5722';
        ctx.lineWidth = 2;

        const ex = (element.x - offsetX) / scaleFactor;
        const ey = (element.y - offsetY) / scaleFactor;

        switch (element.type) {
          case 'rect':
            if (element.width && element.height) {
              ctx.strokeRect(ex, ey, element.width / scaleFactor, element.height / scaleFactor);
            }
            break;
          case 'arrow':
            if (element.x2 !== undefined && element.y2 !== undefined) {
              drawArrow(ctx, ex, ey, (element.x2 - offsetX) / scaleFactor, (element.y2 - offsetY) / scaleFactor);
            }
            break;
          case 'text':
            if (element.text) {
              ctx.font = '16px sans-serif';
              ctx.fillStyle = '#FFFFFF';
              ctx.strokeStyle = '#000000';
              ctx.lineWidth = 3;
              ctx.textBaseline = 'top';
              ctx.strokeText(element.text, ex, ey);
              ctx.fillText(element.text, ex, ey);
            }
            break;
        }
      });

      // 绘制当前正在绘制的元素
      if (currentElement) {
        ctx.strokeStyle = '#FF5722';
        ctx.fillStyle = '#FF5722';
        ctx.lineWidth = 2;

        const cex = (currentElement.x - offsetX) / scaleFactor;
        const cey = (currentElement.y - offsetY) / scaleFactor;

        switch (currentElement.type) {
          case 'rect':
            if (currentElement.width && currentElement.height) {
              ctx.strokeRect(cex, cey, currentElement.width / scaleFactor, currentElement.height / scaleFactor);
            }
            break;
          case 'arrow':
            if (currentElement.x2 !== undefined && currentElement.y2 !== undefined) {
              drawArrow(ctx, cex, cey, (currentElement.x2 - offsetX) / scaleFactor, (currentElement.y2 - offsetY) / scaleFactor);
            }
            break;
        }
      }
    }
  }, [hoveredWindow, selectedRegion, isDragging, dragStart, dragCurrent, scaleFactor, drawElements, currentElement, monitorOffset, backgroundImage]);

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

  // 命中检测：手柄和选区主体
  const getHoverTarget = useCallback((absX: number, absY: number, region: Selection | null): Handle | 'body' | null => {
    if (!region) return null;
    const hitPadding = Math.round(10 * scaleFactor); // 物理像素热区
    const handleSize = Math.round(6 * scaleFactor);  // 手柄半宽（物理像素）

    const handles: { key: Handle; x: number; y: number }[] = [
      { key: 'nw', x: region.x, y: region.y },
      { key: 'n', x: region.x + region.width / 2, y: region.y },
      { key: 'ne', x: region.x + region.width, y: region.y },
      { key: 'e', x: region.x + region.width, y: region.y + region.height / 2 },
      { key: 'se', x: region.x + region.width, y: region.y + region.height },
      { key: 's', x: region.x + region.width / 2, y: region.y + region.height },
      { key: 'sw', x: region.x, y: region.y + region.height },
      { key: 'w', x: region.x, y: region.y + region.height / 2 },
    ];

    for (const h of handles) {
      if (Math.abs(absX - h.x) <= handleSize + hitPadding && Math.abs(absY - h.y) <= handleSize + hitPadding) {
        return h.key;
      }
    }

    if (absX >= region.x && absX <= region.x + region.width && absY >= region.y && absY <= region.y + region.height) {
      return 'body';
    }

    return null;
  }, [scaleFactor]);

  // 重绘画布
  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // 鼠标移动：检测窗口或绘制
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // 优先处理文字输入框拖拽
    if (isDraggingTextInputRef.current && textInput) {
      if (e.buttons !== 1) {
        isDraggingTextInputRef.current = false;
        return;
      }
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      const dx = Math.round((e.clientX - textDragStartRef.current.mx) * scaleFactor);
      const dy = Math.round((e.clientY - textDragStartRef.current.my) * scaleFactor);
      setTextInput({ ...textInput, x: textDragStartRef.current.x + dx, y: textDragStartRef.current.y + dy });
      return;
    }

    // 使用物理像素坐标，确保高 DPI 下截图精准
    const absX = Math.round(e.clientX * scaleFactor) + monitorOffset.x;
    const absY = Math.round(e.clientY * scaleFactor) + monitorOffset.y;

    if (editMode !== 'none' && isDrawing && currentElement) {
      // 编辑模式下绘制（使用绝对坐标）
      const newElement = { ...currentElement };
      if (editMode === 'rect') {
        newElement.width = absX - currentElement.x;
        newElement.height = absY - currentElement.y;
      } else if (editMode === 'arrow') {
        newElement.x2 = absX;
        newElement.y2 = absY;
      }
      setCurrentElement(newElement);
      return;
    }

    // 处理选区移动和缩放
    if (interactionMode !== 'none' && interactionStartRef.current && selectedRegion) {
      if (e.buttons !== 1) {
        setInteractionMode('none');
        setActiveHandle(null);
        interactionStartRef.current = null;
        return;
      }
      e.preventDefault();
      window.getSelection()?.removeAllRanges();

      const { startX, startY, originalRegion } = interactionStartRef.current;
      const dx = absX - startX;
      const dy = absY - startY;

      if (interactionMode === 'moving') {
        const newRegion = {
          ...originalRegion,
          x: originalRegion.x + dx,
          y: originalRegion.y + dy,
        };
        setSelectedRegion(newRegion);
        // 同步移动标注元素
        setDrawElements((prev) =>
          prev.map((el) => {
            if (el.type === 'arrow') {
              return { ...el, x: el.x + dx, y: el.y + dy, x2: (el.x2 ?? el.x) + dx, y2: (el.y2 ?? el.y) + dy };
            }
            return { ...el, x: el.x + dx, y: el.y + dy };
          })
        );
        // 同步移动正在输入的文字框
        if (textInput) {
          setTextInput({ ...textInput, x: textInput.x + dx, y: textInput.y + dy });
        }
      } else if (interactionMode === 'resizing' && activeHandle) {
        const minSize = Math.round(20 * scaleFactor);
        let newX = originalRegion.x;
        let newY = originalRegion.y;
        let newW = originalRegion.width;
        let newH = originalRegion.height;

        switch (activeHandle) {
          case 'e':
            newW = Math.max(minSize, originalRegion.width + dx);
            break;
          case 'w':
            newW = Math.max(minSize, originalRegion.width - dx);
            newX = originalRegion.x + (originalRegion.width - newW);
            break;
          case 's':
            newH = Math.max(minSize, originalRegion.height + dy);
            break;
          case 'n':
            newH = Math.max(minSize, originalRegion.height - dy);
            newY = originalRegion.y + (originalRegion.height - newH);
            break;
          case 'se':
            newW = Math.max(minSize, originalRegion.width + dx);
            newH = Math.max(minSize, originalRegion.height + dy);
            break;
          case 'sw':
            newW = Math.max(minSize, originalRegion.width - dx);
            newX = originalRegion.x + (originalRegion.width - newW);
            newH = Math.max(minSize, originalRegion.height + dy);
            break;
          case 'ne':
            newW = Math.max(minSize, originalRegion.width + dx);
            newH = Math.max(minSize, originalRegion.height - dy);
            newY = originalRegion.y + (originalRegion.height - newH);
            break;
          case 'nw':
            newW = Math.max(minSize, originalRegion.width - dx);
            newX = originalRegion.x + (originalRegion.width - newW);
            newH = Math.max(minSize, originalRegion.height - dy);
            newY = originalRegion.y + (originalRegion.height - newH);
            break;
        }

        const oldRegion = selectedRegion;
        const newRegion = { ...originalRegion, x: newX, y: newY, width: newW, height: newH };
        setSelectedRegion(newRegion);

        // 同步缩放标注元素
        if (oldRegion.width > 0 && oldRegion.height > 0) {
          const scaleX = newW / oldRegion.width;
          const scaleY = newH / oldRegion.height;
          setDrawElements((prev) =>
            prev.map((el) => {
              const relX = el.x - oldRegion.x;
              const relY = el.y - oldRegion.y;
              const updated: DrawElement = {
                ...el,
                x: newRegion.x + relX * scaleX,
                y: newRegion.y + relY * scaleY,
              };
              if (el.type === 'rect' && el.width && el.height) {
                updated.width = el.width * scaleX;
                updated.height = el.height * scaleY;
              }
              if (el.type === 'arrow' && el.x2 !== undefined && el.y2 !== undefined) {
                const relX2 = el.x2 - oldRegion.x;
                const relY2 = el.y2 - oldRegion.y;
                updated.x2 = newRegion.x + relX2 * scaleX;
                updated.y2 = newRegion.y + relY2 * scaleY;
              }
              return updated;
            })
          );
        }
      }
      return;
    }

    if (selectedRegion && editMode === 'none') {
      const target = getHoverTarget(absX, absY, selectedRegion);
      if (target !== hoverTarget) {
        setHoverTarget(target);
      }
      return;
    }

    if (selectedRegion) return; // 已选中则不再检测
    if (isDragging && dragStart) {
      setDragCurrent({ x: absX, y: absY });
      return;
    }

    // 检测鼠标下的窗口（使用绝对坐标，物理像素）
    const hitWindow = windows.find((w) => {
      return absX >= w.x && absX < w.x + w.width && absY >= w.y && absY < w.y + w.height;
    });

    if (hitWindow !== hoveredWindow) {
      setHoveredWindow(hitWindow || null);
    }
  }, [windows, selectedRegion, isDragging, dragStart, editMode, isDrawing, currentElement, monitorOffset, scaleFactor, textInput, interactionMode, activeHandle, hoverTarget, getHoverTarget]);

  // 鼠标按下：开始拖拽或绘制
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只处理左键点击
    if (e.button !== 0) return;

    // 使用物理像素坐标
    const absX = Math.round(e.clientX * scaleFactor) + monitorOffset.x;
    const absY = Math.round(e.clientY * scaleFactor) + monitorOffset.y;

    if (editMode !== 'none') {
      if (editMode === 'text') {
        // 文字模式：在点击位置显示输入框
        e.preventDefault();
        placingTextRef.current = true;

        // 检查是否点击了已有的文字元素（16px 字体估算每字符 9px 宽，高度 20px）
        const clickedText = drawElements.find((el) => {
          if (el.type !== 'text' || !el.text) return false;
          const textWidth = el.text.length * 9;
          const textHeight = 20;
          return absX >= el.x && absX <= el.x + textWidth && absY >= el.y && absY <= el.y + textHeight;
        });

        if (clickedText) {
          // 移除该元素并进入编辑
          setDrawElements((prev) => prev.filter((el) => el.id !== clickedText.id));
          setEditMode('text');
          setTextInput({ id: clickedText.id, x: clickedText.x, y: clickedText.y, text: clickedText.text || '' });
          setTimeout(() => {
            placingTextRef.current = false;
          }, 0);
          return;
        }

        // 先保存当前正在输入的文字，防止旧输入框因未触发 blur 而丢失
        if (textInput?.text.trim()) {
          setDrawElements((prev) => [
            ...prev,
            {
              id: textInput.id || Math.random().toString(36).substring(2, 9),
              type: 'text',
              x: textInput.x,
              y: textInput.y,
              text: textInput.text.trim(),
            },
          ]);
        }
        setEditMode('text');
        setTextInput({ x: absX, y: absY, text: '' });
        setTimeout(() => {
          placingTextRef.current = false;
        }, 0);
        return;
      }
      // 其他编辑模式下开始绘制（记录绝对坐标）
      setIsDrawing(true);
      setCurrentElement({
        id: Math.random().toString(36).substring(2, 9),
        type: editMode,
        x: absX,
        y: absY,
        width: 0,
        height: 0,
      });
      return;
    }

    if (selectedRegion && editMode === 'none') {
      const target = getHoverTarget(absX, absY, selectedRegion);
      if (target) {
        interactionStartRef.current = {
          startX: absX,
          startY: absY,
          originalRegion: { ...selectedRegion },
        };
        if (target === 'body') {
          setInteractionMode('moving');
        } else {
          setInteractionMode('resizing');
          setActiveHandle(target);
        }
        return;
      }
      // 点击选区外部，取消选择
      setSelectedRegion(null);
      setDrawElements([]);
      setHoverTarget(null);
      return;
    }

    // 统一进入拖拽状态，鼠标抬起时根据移动距离判断是单击选窗口还是拖拽选区
    setIsDragging(true);
    setDragStart({ x: absX, y: absY });
    setDragCurrent({ x: absX, y: absY });
    dragStartHoveredWindowRef.current = hoveredWindow;
  }, [hoveredWindow, selectedRegion, editMode, monitorOffset, scaleFactor, textInput, drawElements]);

  // 鼠标抬起：结束拖拽或绘制
  const handleMouseUp = useCallback(() => {
    if (isDraggingTextInputRef.current) {
      isDraggingTextInputRef.current = false;
      return;
    }

    if (interactionMode !== 'none') {
      setInteractionMode('none');
      setActiveHandle(null);
      interactionStartRef.current = null;
      return;
    }

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

      if (width < 5 && height < 5 && dragStartHoveredWindowRef.current) {
        // 移动距离很小，视为单击选中窗口
        const hw = dragStartHoveredWindowRef.current;
        setSelectedRegion({
          x: hw.x,
          y: hw.y,
          width: hw.width,
          height: hw.height,
          source: {
            type: 'window',
            windowId: hw.id,
            title: hw.title,
          },
        });
      } else if (width > 10 && height > 10) {
        // 视为拖拽自定义区域
        const newSelection = {
          x: Math.min(dragStart.x, dragCurrent.x),
          y: Math.min(dragStart.y, dragCurrent.y),
          width,
          height,
          source: { type: 'region' as const },
        };
        setSelectedRegion(newSelection);
      }

      setIsDragging(false);
      setDragStart(null);
      setDragCurrent(null);
      dragStartHoveredWindowRef.current = null;

      // 选区完成后恢复焦点，确保键盘事件正常响应
      document.documentElement.focus();
      document.body.focus();
      containerRef.current?.focus();
      clearMouseUpTimeout();
      mouseUpTimeoutRef.current = setTimeout(() => {
        mouseUpTimeoutRef.current = null;
        document.documentElement.focus();
        document.body.focus();
        containerRef.current?.focus();
      }, 50);
    }
  }, [isDragging, dragStart, dragCurrent, editMode, isDrawing, currentElement, clearMouseUpTimeout]);

  // 执行保存或复制截图的公共逻辑
  const saveOrCopyScreenshot = useCallback(async (tipText: string, tipIcon: 'success' | 'copy') => {
    const region = stateRef.current.selectedRegion;
    if (!region) return;

    const bgPath = backgroundPathRef.current;
    const offset = monitorOffset;

    setCenterTip({ text: tipText, icon: tipIcon });
    clearPendingTimeout();
    pendingTimeoutRef.current = setTimeout(() => {
      pendingTimeoutRef.current = null;
      hideOverlay();

      invoke<{
        filename: string;
        filepath: string;
        width: number;
        height: number;
      }>('save_and_copy_screenshot', {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        backgroundImagePath: bgPath || undefined,
        monitorX: offset.x,
        monitorY: offset.y,
        cleanupBackground: !!bgPath,
      }).catch((error) => {
        console.error('[ScreenshotOverlay] Failed to save/copy screenshot:', error);
        addToast({
          type: 'error',
          title: tipIcon === 'success' ? '截图保存失败' : '复制失败',
          message: String(error),
          duration: 5000,
        });
      });
    }, 500);
  }, [addToast, hideOverlay, monitorOffset, clearPendingTimeout]);

  // 执行截图并复制到剪贴板（使用合并命令，减少 IPC 往返）
  const captureSelection = useCallback(async () => {
    await saveOrCopyScreenshot('截图已保存', 'success');
  }, [saveOrCopyScreenshot]);

  // 复制到剪贴板（使用合并命令，减少 IPC 往返）
  const copyToClipboard = useCallback(async () => {
    await saveOrCopyScreenshot('已复制到剪贴板', 'copy');
  }, [saveOrCopyScreenshot]);

  // OCR 识别（使用 stateRef 避免 stale closure）
  const performOcr = useCallback(async () => {
    const region = stateRef.current.selectedRegion;
    if (!region) return;

    setIsOcrProcessing(true);
    try {
      const result = await invoke<{
        filename: string;
        filepath: string;
      }>('capture_region', {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        backgroundImagePath: backgroundPathRef.current || undefined,
        monitorX: monitorOffset.x,
        monitorY: monitorOffset.y,
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
  }, [addToast]);

  // 计算工具栏位置（窗口相对坐标）
  const getToolbarPosition = () => {
    if (!selectedRegion) return null;

    // 转换为窗口内相对坐标（逻辑像素）
    const viewportX = (selectedRegion.x - monitorOffset.x) / scaleFactor;
    const viewportY = (selectedRegion.y - monitorOffset.y) / scaleFactor;
    const regionWidth = selectedRegion.width / scaleFactor;
    const regionHeight = selectedRegion.height / scaleFactor;

    const toolbarWidth = 320;
    const toolbarHeight = 60;
    const padding = 16;

    let left = viewportX + regionWidth / 2;
    let top = viewportY + regionHeight + padding;

    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;

    if (top + toolbarHeight > screenHeight) {
      top = viewportY - toolbarHeight - padding;
    }

    const minLeft = toolbarWidth / 2 + padding;
    const maxLeft = screenWidth - toolbarWidth / 2 - padding;
    left = Math.max(minLeft, Math.min(left, maxLeft));
    top = Math.max(padding, Math.min(top, screenHeight - toolbarHeight - padding));

    return { left, top };
  };

  const toolbarPos = getToolbarPosition();

  const getCursorClass = () => {
    if (editMode !== 'none') return 'cursor-default';
    if (interactionMode === 'moving') return 'cursor-move';
    if (interactionMode === 'resizing' && activeHandle) {
      const map: Record<Handle, string> = {
        n: 'cursor-ns-resize',
        s: 'cursor-ns-resize',
        e: 'cursor-ew-resize',
        w: 'cursor-ew-resize',
        ne: 'cursor-nesw-resize',
        sw: 'cursor-nesw-resize',
        nw: 'cursor-nwse-resize',
        se: 'cursor-nwse-resize',
      };
      return map[activeHandle];
    }
    if (hoverTarget === 'body') return 'cursor-move';
    if (hoverTarget) {
      const map: Record<Handle, string> = {
        n: 'cursor-ns-resize',
        s: 'cursor-ns-resize',
        e: 'cursor-ew-resize',
        w: 'cursor-ew-resize',
        ne: 'cursor-nesw-resize',
        sw: 'cursor-nesw-resize',
        nw: 'cursor-nwse-resize',
        se: 'cursor-nwse-resize',
      };
      return map[hoverTarget];
    }
    return 'cursor-crosshair';
  };

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 select-none outline-none ${getCursorClass()}`}
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
            left: (hoveredWindow.x - monitorOffset.x) / scaleFactor + 8,
            top: (hoveredWindow.y - monitorOffset.y) / scaleFactor + 8,
          }}
        >
          <div className="font-medium">{hoveredWindow.title || '无标题'}</div>
          <div className="text-gray-400 text-[10px]">{hoveredWindow.appName}</div>
        </div>
      )}

      {/* 底部工具栏 */}
      {selectedRegion && toolbarPos && (
        <Toolbar
          position={toolbarPos}
          editMode={editMode}
          isOcrProcessing={isOcrProcessing}
          onSave={captureSelection}
          onCopy={copyToClipboard}
          onSetEditMode={setEditMode}
          onOcr={performOcr}
          onCancel={() => {
            setSelectedRegion(null);
            setDrawElements([]);
          }}
        />
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

      {/* 文字输入框 */}
      {textInput && (
        <div
          className="absolute z-50 flex flex-col items-center group"
          style={{
            left: (textInput.x - monitorOffset.x) / scaleFactor,
            top: (textInput.y - monitorOffset.y) / scaleFactor,
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            isDraggingTextInputRef.current = true;
            textDragStartRef.current = {
              mx: e.clientX,
              my: e.clientY,
              x: textInput.x,
              y: textInput.y,
            };
          }}
        >
          {/* 顶部拖拽手柄 */}
          <div className="w-8 h-1.5 rounded-full bg-gray-400/80 mb-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-move" />
          <input
            ref={textInputRef}
            className="bg-gray-800/90 text-white text-base px-0 py-0 rounded border border-gray-500 outline-none focus:border-blue-500 min-w-[80px] shadow-lg"
            value={textInput.text}
            onChange={(e) => setTextInput({ ...textInput, text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                if (textInput.text.trim()) {
                  setDrawElements((prev) => [
                    ...prev,
                    {
                      id: textInput.id || Math.random().toString(36).substring(2, 9),
                      type: 'text',
                      x: textInput.x,
                      y: textInput.y,
                      text: textInput.text.trim(),
                    },
                  ]);
                }
                setTextInput(null);
                setEditMode('none');
              } else if (e.key === 'Escape') {
                setTextInput(null);
                setEditMode('none');
              }
            }}
            onBlur={() => {
              if (textInput.text.trim()) {
                setDrawElements((prev) => [
                  ...prev,
                  {
                    id: textInput.id || Math.random().toString(36).substring(2, 9),
                    type: 'text',
                    x: textInput.x,
                    y: textInput.y,
                    text: textInput.text.trim(),
                  },
                ]);
              }
              if (!placingTextRef.current) {
                setTextInput(null);
                setEditMode('none');
              }
            }}
          />
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

      {/* 正中央成功提示（微信风格） */}
      {centerTip && (
        <div role="status" aria-live="polite" className="fixed inset-0 flex items-center justify-center pointer-events-none z-50">
          <div className="flex flex-col items-center gap-2 px-10 py-6 bg-[#2b2b2b]/95 rounded-2xl animate-in zoom-in fade-in duration-200">
            {centerTip.icon === 'success' ? (
              <Check strokeWidth={1.5} className="w-12 h-12 text-white/90" />
            ) : (
              <Copy strokeWidth={1.5} className="w-12 h-12 text-white/90" />
            )}
            <span className="text-white/90 text-base font-normal tracking-wide">{centerTip.text}</span>
          </div>
        </div>
      )}
    </div>
  );
}
