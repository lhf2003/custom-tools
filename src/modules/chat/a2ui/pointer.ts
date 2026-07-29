// JSON Pointer（RFC 6901）解析与不可变写入。
// A2UI 扩展：不以 / 开头的路径为相对路径，由 joinPath 按模板作用域拼接成绝对路径。

/** 相对路径拼到作用域上；绝对路径（/ 开头）原样返回 */
export function joinPath(scopePath: string, path: string): string {
  if (path.startsWith('/')) return path;
  return scopePath ? `${scopePath}/${path}` : `/${path}`;
}

function segments(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer
    .replace(/^\//, '')
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** 按指针读值；路径不存在返回 undefined（渐进渲染期属正常，渲染层自行兜底） */
export function resolvePointer(model: unknown, pointer: string): unknown {
  let cur = model;
  for (const seg of segments(pointer)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 不可变写入：返回新数据模型。value === undefined 表示删除该键（数组置空位保长度） */
export function setPointerImmutable(model: unknown, pointer: string, value: unknown): unknown {
  const segs = segments(pointer);
  if (segs.length === 0) return value;

  const setAt = (node: unknown, depth: number): unknown => {
    const seg = segs[depth];
    const isLast = depth === segs.length - 1;
    const isArray = Array.isArray(node) || (node === undefined || node === null)
      ? /^\d+$/.test(seg)
      : Array.isArray(node);

    if (isArray) {
      const idx = Number(seg);
      const arr = Array.isArray(node) ? [...node] : [];
      if (isLast) {
        if (value === undefined) arr[idx] = undefined;
        else arr[idx] = value;
      } else {
        arr[idx] = setAt(arr[idx], depth + 1);
      }
      return arr;
    }

    const obj: Record<string, unknown> =
      node !== null && typeof node === 'object' && !Array.isArray(node)
        ? { ...(node as Record<string, unknown>) }
        : {};
    if (isLast) {
      if (value === undefined) delete obj[seg];
      else obj[seg] = value;
    } else {
      obj[seg] = setAt(obj[seg], depth + 1);
    }
    return obj;
  };

  return setAt(model, 0);
}
