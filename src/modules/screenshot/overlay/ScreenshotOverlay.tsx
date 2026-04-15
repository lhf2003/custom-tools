import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useToastStore } from '@/stores/toastStore';
import { Tooltip } from '@/components/Tooltip';
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
  const [monitorOffset, setMonitorOffset] = useState({ x: 0, y: 0 });
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null);
  const backgroundPathRef = useRef('');

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
    setEditMode('none');
    setDrawElements([]);
    setIsDrawing(false);
    setCurrentElement(null);
    setIsOcrProcessing(false);
    setOcrResult('');
    setShowOcrResult(false);
  }, []);

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
  }, [hideOverlay]);

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
        e.stopPropagation();
        console.log('[ScreenshotOverlay] Enter pressed, calling captureSelection');
        // 使用 setTimeout 避免在事件处理中直接调用异步函数可能的问题
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

    // 全屏半透明遮罩
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
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

      // 绘制边框
      if (selectedRegion || isDragging) {
        ctx.strokeStyle = '#0099FF'; // 蓝色：已选中
      } else {
        ctx.strokeStyle = '#00D26A'; // 绿色：悬停
      }
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

  // 重绘画布
  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // 鼠标移动：检测窗口或绘制
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
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

    if (selectedRegion) return; // 已选中则不再检测
    if (isDragging && dragStart) {
      setDragCurrent({ x: absX, y: absY });
      return;
    }

    // 检测鼠标下的窗口（使用绝对坐标，物理像素）
    const window = windows.find((w) => {
      return absX >= w.x && absX < w.x + w.width && absY >= w.y && absY < w.y + w.height;
    });

    if (window !== hoveredWindow) {
      setHoveredWindow(window || null);
    }
  }, [windows, selectedRegion, isDragging, dragStart, editMode, isDrawing, currentElement, monitorOffset, scaleFactor]);

  // 鼠标按下：开始拖拽或绘制
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只处理左键点击
    if (e.button !== 0) return;

    // 使用物理像素坐标
    const absX = Math.round(e.clientX * scaleFactor) + monitorOffset.x;
    const absY = Math.round(e.clientY * scaleFactor) + monitorOffset.y;

    if (editMode !== 'none') {
      // 编辑模式下开始绘制（记录绝对坐标）
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

    if (selectedRegion) {
      // 已选中状态下点击，取消选择
      setSelectedRegion(null);
      setDrawElements([]);
      return;
    }

    if (hoveredWindow) {
      // 点击窗口：直接选中该窗口
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
      setIsDragging(true);
      setDragStart({ x: absX, y: absY });
      setDragCurrent({ x: absX, y: absY });
    }
  }, [hoveredWindow, selectedRegion, editMode, monitorOffset, scaleFactor]);

  // 监听 selectedRegion 变化
  useEffect(() => {
    console.log('[ScreenshotOverlay] selectedRegion changed:', selectedRegion);
  }, [selectedRegion]);

  // 鼠标抬起：结束拖拽或绘制
  const handleMouseUp = useCallback(() => {
    console.log('[ScreenshotOverlay] Mouse up:', { isDragging, hasDragStart: !!dragStart, hasDragCurrent: !!dragCurrent, editMode, isDrawing });

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
        setSelectedRegion(newSelection);
      }

      setIsDragging(false);
      setDragStart(null);
      setDragCurrent(null);

      // 选区完成后恢复焦点，确保键盘事件正常响应
      document.documentElement.focus();
      document.body.focus();
      containerRef.current?.focus();
      setTimeout(() => {
        document.documentElement.focus();
        document.body.focus();
        containerRef.current?.focus();
      }, 50);
    }
  }, [isDragging, dragStart, dragCurrent, editMode, isDrawing, currentElement]);

  // 执行截图并复制到剪贴板（使用合并命令，减少 IPC 往返）
  const captureSelection = useCallback(async () => {
    const region = stateRef.current.selectedRegion;
    if (!region) return;

    const bgPath = backgroundPathRef.current;
    const offset = monitorOffset;

    // 立即隐藏遮罩并显示成功提示，提升感知性能
    hideOverlay();
    addToast({
      type: 'success',
      title: '截图已保存',
      duration: 3000,
    });

    try {
      await invoke<{
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
      });
    } catch (error) {
      console.error('[ScreenshotOverlay] Failed to save screenshot:', error);
      addToast({
        type: 'error',
        title: '截图保存失败',
        message: String(error),
        duration: 5000,
      });
    }
  }, [addToast, hideOverlay, monitorOffset]);

  // 复制到剪贴板（使用合并命令，减少 IPC 往返）
  const copyToClipboard = useCallback(async () => {
    const region = stateRef.current.selectedRegion;
    if (!region) return;

    const bgPath = backgroundPathRef.current;
    const offset = monitorOffset;

    hideOverlay();
    addToast({
      type: 'success',
      title: '已复制到剪贴板',
      duration: 2000,
    });

    try {
      await invoke<{
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
      });
    } catch (error) {
      console.error('Failed to copy screenshot:', error);
      addToast({
        type: 'error',
        title: '复制失败',
        message: String(error),
        duration: 5000,
      });
    }
  }, [addToast, hideOverlay, monitorOffset]);

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

  // 工具栏按钮
  const toolbarButtons = [
    {
      id: 'save',
      icon: Check,
      label: '保存',
      shortcut: 'Enter',
      onClick: () => {
        console.log('[ScreenshotOverlay] Save button clicked, selectedRegion:', selectedRegion);
        captureSelection();
      },
      primary: true
    },
    {
      id: 'copy',
      icon: Copy,
      label: '复制',
      shortcut: 'Ctrl+C',
      onClick: () => {
        console.log('[ScreenshotOverlay] Copy button clicked');
        copyToClipboard();
      }
    },
    { id: 'rect', icon: Square, label: '矩形', shortcut: '', onClick: () => setEditMode(editMode === 'rect' ? 'none' : 'rect'), active: editMode === 'rect' },
    { id: 'arrow', icon: ArrowRight, label: '箭头', shortcut: '', onClick: () => setEditMode(editMode === 'arrow' ? 'none' : 'arrow'), active: editMode === 'arrow' },
    { id: 'text', icon: Type, label: '文字', shortcut: '', onClick: () => setEditMode(editMode === 'text' ? 'none' : 'text'), active: editMode === 'text' },
    {
      id: 'ocr',
      icon: Sparkles,
      label: 'OCR',
      shortcut: '',
      onClick: () => {
        console.log('[ScreenshotOverlay] OCR button clicked');
        performOcr();
      },
      loading: isOcrProcessing
    },
    {
      id: 'cancel',
      icon: X,
      label: '取消',
      shortcut: 'ESC',
      onClick: () => {
        console.log('[ScreenshotOverlay] Cancel button clicked');
        setSelectedRegion(null);
        setDrawElements([]);
      }
    },
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
        <div
          className="fixed flex items-center gap-1 px-2 py-1.5 bg-gray-800/95 backdrop-blur rounded-lg shadow-xl border border-gray-700 z-50"
          style={{
            left: toolbarPos.left,
            top: toolbarPos.top,
            transform: 'translateX(-50%)',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {toolbarButtons.map((button) => {
            const btnContent = (
              <button
                onClick={(e) => {
                  console.log('[ScreenshotOverlay] Button onClick triggered:', button.id);
                  e.stopPropagation();
                  e.preventDefault();
                  button.onClick();
                }}
                onMouseDown={(e) => {
                  // 阻止鼠标按下事件冒泡，避免触发画布的鼠标事件
                  e.stopPropagation();
                }}
                disabled={button.loading}
                className={`relative flex flex-col items-center gap-0.5 px-3 py-1.5 rounded transition-all ${
                  button.primary
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : button.active
                    ? 'bg-orange-500/30 text-orange-400 border border-orange-500/50'
                    : 'hover:bg-gray-700 text-gray-300'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {button.loading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <button.icon className="w-4 h-4" />
                )}
                <span className="text-[10px]">{button.label}</span>
              </button>
            );
            return (
              <Tooltip key={button.id} content={`${button.label} ${button.shortcut ? `(${button.shortcut})` : ''}`} placement="top">
                {btnContent}
              </Tooltip>
            );
          })}
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
