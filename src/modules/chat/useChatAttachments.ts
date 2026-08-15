import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLlmProviderStore } from '@/stores/llmProviderStore';
import {
  classifyFileName,
  compressImage,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  readTextFile,
  type PendingAttachment,
} from './attachments';
import type { VisionCandidate } from './RichMessageView';

/**
 * 待发附件管线：文件选择/粘贴 → 视觉门槛拦截 → 图片压缩落盘 / 文本读内容 → 入列。
 * 数量上限用「已入列 ref 镜像 + 处理中计数」在落盘前锁定——commitAttachments
 * 在处理器内同步维护 ref（useEffect 同步滞后于渲染，异步循环里会读到旧值），
 * 并发入口（粘贴+粘贴/选择器）不会出现「落盘成功但入列被截断」的孤儿文件。
 */
export function useChatAttachments(args: {
  sessionIdRef: React.MutableRefObject<number | null>;
  onError: (msg: string) => void;
}) {
  const { sessionIdRef, onError } = args;

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // 视觉门槛对话框：非空 = 待处理文件被拦截（含图片但当前模型未标视觉）
  const [visionGateFiles, setVisionGateFiles] = useState<File[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 系统文件选择器进行中标记：选择器打开会夺走主窗口焦点，
  // 期间必须用 set_blur_hold 顶住 hide-on-blur，否则窗口在选择中途消失
  const pickingFileRef = useRef(false);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  // 处理中的附件计数：图片压缩/落盘在 await 中尚未入列，预检查必须把
  // 「已入列 + 处理中」合成计算
  const inflightAttachmentsRef = useRef(0);

  /** 附件列表唯一提交入口：同步更新 ref 镜像（同步段原子），
   *  使 addOneFile 的预检查对并发入口永远准确 */
  const commitAttachments = useCallback((next: PendingAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  /** 追加待发附件（上限由 addOneFile 预检查的「已入列+处理中」计数保证） */
  const pushAttachment = useCallback(
    (item: PendingAttachment) => {
      commitAttachments([...attachmentsRef.current, item]);
    },
    [commitAttachments],
  );

  const addOneFile = async (file: File) => {
    if (
      attachmentsRef.current.length + inflightAttachmentsRef.current >=
      MAX_ATTACHMENTS
    ) {
      onError(`一次最多带 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    const cls = classifyFileName(file.name);
    if (cls === 'unsupported') {
      onError(`不支持的文件类型：${file.name}`);
      return;
    }
    const sid = sessionIdRef.current;
    if (sid === null) {
      onError('会话未就绪，请稍候再试');
      return;
    }
    if (cls === 'image') {
      if (file.size > MAX_IMAGE_BYTES) {
        onError(`图片过大（上限 10MB）：${file.name}`);
        return;
      }
    } else if (file.size > MAX_TEXT_BYTES) {
      onError(`文件过大（上限 64KB）：${file.name}`);
      return;
    }
    // 同步占计数（JS 单线程同步段原子）：await 期间并发入口的预检查立刻看到，
    // 容量在落盘前即被锁定，不会出现「落盘成功但入列被截断」的孤儿文件
    inflightAttachmentsRef.current += 1;
    try {
      if (cls === 'image') {
        const compressed = await compressImage(file);
        const relPath = await invoke<string>('save_chat_image', {
          sessionId: sid,
          bytes: compressed.bytes,
          ext: compressed.ext,
        });
        commitAttachments([
          ...attachmentsRef.current,
          { kind: 'image', relPath, dataUrl: compressed.dataUrl },
        ]);
        return;
      }
      const content = await readTextFile(file);
      pushAttachment({ kind: 'file', name: file.name, content });
    } catch (e) {
      onError(
        typeof e === 'string'
          ? e
          : cls === 'image'
            ? '图片处理失败'
            : `读取文件失败：${file.name}`,
      );
    } finally {
      inflightAttachmentsRef.current -= 1;
    }
  };

  /** 打开文件选择器：先挂失焦挂起（选择器会抢焦点触发 hide-on-blur），
   *  选择器关闭（选中/取消）后焦点回主窗口，focus 监听里统一释放 */
  const openFilePicker = async () => {
    pickingFileRef.current = true;
    await invoke('set_blur_hold', { hold: true }).catch(() => {});
    // 兜底：极端情况 focus 事件丢失时，hide-on-blur 不应被永久挂起
    setTimeout(() => {
      if (pickingFileRef.current) {
        pickingFileRef.current = false;
        invoke('set_blur_hold', { hold: false }).catch(() => {});
      }
    }, 5 * 60 * 1000);
    fileInputRef.current?.click();
  };

  // 焦点回主窗口 = 选择器已关闭：释放失焦挂起（选中与取消都会走到）
  useEffect(() => {
    const onFocus = () => {
      if (!pickingFileRef.current) return;
      pickingFileRef.current = false;
      invoke('set_blur_hold', { hold: false }).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // 视觉门槛：附件含图片时要求当前 chat 场景模型已标 supports_vision，
  // 未标立即拦截（附件不进待发区），弹窗给「一键切换 / 去设置标记」两条路。
  // 文本文件无此门槛（读内容拼进消息，任何模型都能看）。
  const currentVisionState = (): { ok: boolean; modelName: string | null } => {
    const { sceneConfigs, models } = useLlmProviderStore.getState();
    const cfg = sceneConfigs.chat;
    if (!cfg) return { ok: false, modelName: null };
    const m = (models[cfg.provider_id] ?? []).find((x) => x.model_id === cfg.model_id);
    return { ok: m?.supports_vision === true, modelName: m?.name ?? cfg.model_id };
  };

  const collectVisionCandidates = (): VisionCandidate[] => {
    const { providers, models } = useLlmProviderStore.getState();
    return providers
      .filter((p) => p.is_active)
      .flatMap((p) =>
        (models[p.id] ?? [])
          .filter((m) => m.is_active && m.supports_vision)
          .map((m) => ({
            providerId: p.id,
            modelId: m.model_id,
            name: m.name,
            providerLabel: p.label,
          })),
      );
  };

  /** 文件选择/粘贴统一入口：含图片先过视觉门槛，被拦的文件存进对话框待切换后续传 */
  const addFiles = async (files: File[]) => {
    const hasImage = files.some((f) => classifyFileName(f.name) === 'image');
    if (hasImage) {
      // 视觉判定依赖 store 数据：窗口刚开就点发送文件时 chat 场景配置/模型
      // 列表可能尚未懒加载完，先确保加载再判，否则把视觉模型误判成不支持
      const store = useLlmProviderStore.getState();
      if (!store.sceneConfigs.chat) {
        await store.loadSceneConfigs().catch(() => {});
      }
      const cfg = useLlmProviderStore.getState().sceneConfigs.chat;
      if (cfg && !useLlmProviderStore.getState().models[cfg.provider_id]) {
        await useLlmProviderStore.getState().loadModels(cfg.provider_id).catch(() => {});
      }
      if (!currentVisionState().ok) {
        setVisionGateFiles(files);
        return;
      }
    }
    for (const file of files) {
      await addOneFile(file);
    }
  };

  const handleVisionSwitch = async (c: VisionCandidate) => {
    const store = useLlmProviderStore.getState();
    const cfg = store.sceneConfigs.chat;
    await store.setSceneModel(
      'chat',
      c.providerId,
      c.modelId,
      cfg?.thinking_mode ?? false,
      cfg?.reasoning_effort ?? 'medium',
    );
    const pending = visionGateFiles ?? [];
    setVisionGateFiles(null);
    await addFiles(pending);
  };

  const removeAttachment = useCallback(
    (i: number) => commitAttachments(attachmentsRef.current.filter((_, j) => j !== i)),
    [commitAttachments],
  );
  const clearAttachments = useCallback(() => commitAttachments([]), [commitAttachments]);
  const dismissVisionGate = useCallback(() => setVisionGateFiles(null), []);

  return {
    attachments,
    fileInputRef,
    visionGateFiles,
    dismissVisionGate,
    addFiles,
    openFilePicker,
    removeAttachment,
    clearAttachments,
    currentVisionState,
    collectVisionCandidates,
    handleVisionSwitch,
  };
}
