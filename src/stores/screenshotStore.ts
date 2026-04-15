import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export type ScreenshotMode = 'full' | 'window' | 'region';

export interface ScreenshotResult {
  filename: string;
  filepath: string;
  mode: ScreenshotMode;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  title: string;
  appName: string;
  thumbnail?: string;
}

interface ScreenshotState {
  // 当前截图
  currentScreenshot: ScreenshotResult | null;
  isCapturing: boolean;
  captureError: string | null;

  // 窗口列表
  windowList: WindowInfo[];
  isLoadingWindows: boolean;

  // OCR 状态
  ocrResult: string;
  isOcrProcessing: boolean;

  // 操作方法
  captureFullScreen: () => Promise<ScreenshotResult | null>;
  getCapturableWindows: () => Promise<WindowInfo[]>;
  captureWindow: (windowId: number) => Promise<ScreenshotResult | null>;
  captureRegion: (x: number, y: number, width: number, height: number) => Promise<ScreenshotResult | null>;
  performOcr: (filepath: string, prompt?: string) => Promise<string>;
  clearCurrentScreenshot: () => void;
}

export const useScreenshotStore = create<ScreenshotState>((set) => ({
  currentScreenshot: null,
  isCapturing: false,
  captureError: null,
  windowList: [],
  isLoadingWindows: false,
  ocrResult: '',
  isOcrProcessing: false,

  // 全屏截图
  captureFullScreen: async () => {
    set({ isCapturing: true, captureError: null });
    try {
      const screenshot = await invoke<ScreenshotResult>('capture_full_screen');
      set({ currentScreenshot: screenshot, isCapturing: false });
      return screenshot;
    } catch (error) {
      set({ captureError: String(error), isCapturing: false });
      return null;
    }
  },

  // 获取可截图窗口列表
  getCapturableWindows: async () => {
    set({ isLoadingWindows: true });
    try {
      const windows = await invoke<WindowInfo[]>('get_capturable_windows');
      set({ windowList: windows, isLoadingWindows: false });
      return windows;
    } catch (error) {
      set({ isLoadingWindows: false });
      return [];
    }
  },

  // 窗口截图
  captureWindow: async (windowId: number) => {
    set({ isCapturing: true, captureError: null });
    try {
      const screenshot = await invoke<ScreenshotResult>('capture_window', { windowId });
      set({ currentScreenshot: screenshot, isCapturing: false });
      return screenshot;
    } catch (error) {
      set({ captureError: String(error), isCapturing: false });
      return null;
    }
  },

  // 区域截图
  captureRegion: async (x: number, y: number, width: number, height: number) => {
    set({ isCapturing: true, captureError: null });
    try {
      const screenshot = await invoke<ScreenshotResult>('capture_region', { x, y, width, height });
      set({ currentScreenshot: screenshot, isCapturing: false });
      return screenshot;
    } catch (error) {
      set({ captureError: String(error), isCapturing: false });
      return null;
    }
  },

  // 执行 OCR
  performOcr: async (filepath: string, prompt?: string) => {
    set({ isOcrProcessing: true, ocrResult: '' });
    try {
      const result = await invoke<string>('ocr_screenshot', {
        filepath,
        prompt: prompt || '请识别图片中的文字内容，只返回文字，不要其他解释',
      });
      set({ ocrResult: result, isOcrProcessing: false });
      return result;
    } catch (error) {
      set({ isOcrProcessing: false });
      throw error;
    }
  },

  // 清除当前截图
  clearCurrentScreenshot: () => {
    set({ currentScreenshot: null, ocrResult: '' });
  },
}));
