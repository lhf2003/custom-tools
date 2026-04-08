import { useState } from 'react';
import { Camera, Monitor, Square, AppWindow, Copy, Check } from 'lucide-react';
import { useScreenshotStore } from '@/stores/screenshotStore';
import { invoke } from '@tauri-apps/api/core';

export default function ScreenshotModule() {
  const {
    captureFullScreen,
    getCapturableWindows,
    captureWindow,
    currentScreenshot,
    isCapturing,
    performOcr,
    ocrResult,
    isOcrProcessing,
  } = useScreenshotStore();

  const [showWindowList, setShowWindowList] = useState(false);
  const [windows, setWindows] = useState<{ id: number; title: string; appName: string }[]>([]);
  const [copied, setCopied] = useState(false);

  const handleFullScreenCapture = async () => {
    await captureFullScreen();
  };

  const handleWindowCaptureClick = async () => {
    const windowList = await getCapturableWindows();
    setWindows(windowList);
    setShowWindowList(true);
  };

  const handleWindowSelect = async (windowId: number) => {
    await captureWindow(windowId);
    setShowWindowList(false);
  };

  const handleCopyToClipboard = async (filepath: string) => {
    try {
      const base64 = await invoke<string>('screenshot_to_base64', { filepath });
      const response = await fetch(base64);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob,
        }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('复制失败:', error);
    }
  };

  const handleOcr = async (filepath: string) => {
    try {
      await performOcr(filepath);
    } catch (error) {
      console.error('OCR 失败:', error);
    }
  };

  return (
    <div className="p-6 h-full overflow-auto">
      <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <Camera className="w-6 h-6" />
        截图工具
      </h2>

      {/* 截图模式按钮 */}
      {!currentScreenshot ? (
        <div className="grid grid-cols-3 gap-4 mb-8">
          <button
            onClick={handleFullScreenCapture}
            disabled={isCapturing}
            className="flex flex-col items-center justify-center p-6 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-xl transition-colors"
          >
            <Monitor className="w-8 h-8 mb-2" />
            <span>{isCapturing ? '截图中...' : '全屏截图'}</span>
          </button>

          <button
            onClick={handleWindowCaptureClick}
            disabled={isCapturing}
            className="flex flex-col items-center justify-center p-6 bg-green-600 hover:bg-green-700 disabled:bg-green-400 rounded-xl transition-colors"
          >
            <AppWindow className="w-8 h-8 mb-2" />
            <span>窗口截图</span>
          </button>

          <button
            onClick={() => alert('区域截图功能开发中...')}
            disabled={isCapturing}
            className="flex flex-col items-center justify-center p-6 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 rounded-xl transition-colors"
          >
            <Square className="w-8 h-8 mb-2" />
            <span>区域截图</span>
          </button>
        </div>
      ) : (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">截图预览</h3>
            <button
              onClick={() => useScreenshotStore.getState().clearCurrentScreenshot()}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm"
            >
              返回
            </button>
          </div>

          <div className="bg-gray-800 rounded-xl overflow-hidden">
            <img
              src={`file://${currentScreenshot.filepath}`}
              alt="Screenshot"
              className="max-w-full max-h-[50vh] object-contain mx-auto"
            />
          </div>

          <div className="flex gap-3 mt-4">
            <button
              onClick={() => handleCopyToClipboard(currentScreenshot.filepath)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? '已复制' : '复制到剪贴板'}
            </button>

            <button
              onClick={() => handleOcr(currentScreenshot.filepath)}
              disabled={isOcrProcessing}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 rounded-lg"
            >
              {isOcrProcessing ? '识别中...' : 'OCR 文字识别'}
            </button>
          </div>

          {ocrResult && (
            <div className="mt-4 p-4 bg-gray-800 rounded-lg">
              <h4 className="text-sm font-semibold text-gray-400 mb-2">识别结果：</h4>
              <pre className="text-sm whitespace-pre-wrap">{ocrResult}</pre>
              <button
                onClick={() => navigator.clipboard.writeText(ocrResult)}
                className="mt-2 text-xs text-blue-400 hover:text-blue-300"
              >
                复制文字
              </button>
            </div>
          )}

          <div className="mt-4 text-sm text-gray-500">
            已保存到：{currentScreenshot.filepath}
          </div>
        </div>
      )}

      {/* 窗口列表弹窗 */}
      {showWindowList && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 max-w-2xl w-full max-h-[80vh] overflow-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">选择要截图的窗口</h3>
              <button
                onClick={() => setShowWindowList(false)}
                className="text-gray-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="space-y-2">
              {windows.map((w) => (
                <button
                  key={w.id}
                  onClick={() => handleWindowSelect(w.id)}
                  className="w-full text-left p-4 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                >
                  <div className="font-medium">{w.title}</div>
                  <div className="text-sm text-gray-400">{w.appName}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
