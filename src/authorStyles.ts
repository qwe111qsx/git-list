import * as vscode from "vscode";

/** globalState 键；值为对象便于后续扩展（如自定义图标等）。 */
export const AUTHOR_STYLES_STATE_KEY = "gitList.authorStyles";

export interface AuthorStyleRecord {
  color: string;
}

export interface AuthorStylesFile {
  authors: Record<string, AuthorStyleRecord>;
}

/** 清除本地保存的作者配色（下次加载提交时会按当前算法重新分配）。 */
export async function clearAuthorStylesStore(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(AUTHOR_STYLES_STATE_KEY, undefined);
}

function readAuthorStylesFile(context: vscode.ExtensionContext): AuthorStylesFile {
  const raw = context.globalState.get<unknown>(AUTHOR_STYLES_STATE_KEY);
  if (raw && typeof raw === "object" && raw !== null && "authors" in raw) {
    const authors = (raw as AuthorStylesFile).authors;
    if (authors && typeof authors === "object" && !Array.isArray(authors)) {
      return { authors: { ...authors } };
    }
  }
  return { authors: {} };
}

function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

function hslToHex(h: number, s: number, l: number): string {
  let hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(100, s)) / 100;
  const ll = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;

  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh < 60) {
    rp = c;
    gp = x;
  } else if (hh < 120) {
    rp = x;
    gp = c;
  } else if (hh < 180) {
    gp = c;
    bp = x;
  } else if (hh < 240) {
    gp = x;
    bp = c;
  } else if (hh < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }

  const r = Math.round((rp + m) * 255);
  const g = Math.round((gp + m) * 255);
  const b = Math.round((bp + m) * 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function normalizeHex(color: string): string | undefined {
  const s = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) {
    return s;
  }
  return undefined;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const n = normalizeHex(hex);
  if (!n) {
    return undefined;
  }
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

/** RGB 欧氏距离；低于阈值视为过近，新作者会旋转色相避开。 */
function rgbDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function isTooCloseToAny(candidate: string, existingHexes: string[]): boolean {
  const c = hexToRgb(candidate);
  if (!c) {
    return true;
  }
  const threshold = 52;
  for (const ex of existingHexes) {
    const e = hexToRgb(ex);
    if (e && rgbDistance(c, e) < threshold) {
      return true;
    }
  }
  return false;
}

/** 由哈希展开色相，并在与已占用颜色过近时步进色相，尽量拉开差异。 */
function pickDistinctColorForNewAuthor(key: string, existingHexes: string[]): string {
  const h1 = hash32(key);
  const h2 = hash32(`${key}|gitListAuthor`);
  let hue = (h1 * 137.508) % 360;
  const sat = 56 + (h2 % 20);
  const light = 42 + ((h2 >>> 9) % 16);

  for (let k = 0; k < 48; k++) {
    const hex = hslToHex(hue + k * 47.5, sat, light);
    if (!isTooCloseToAny(hex, existingHexes)) {
      return hex;
    }
  }
  return hslToHex(hue, sat, light);
}

/** 作者唯一键：优先邮箱，否则规范化后的显示名。 */
export function authorStyleKey(authorEmail: string, authorName: string): string {
  const e = authorEmail.trim().toLowerCase();
  if (e.length > 0) {
    return e;
  }
  return `name:${authorName.trim().toLowerCase()}`;
}

/** Codicon `account` 轮廓（16×16），填充色来自本地持久化的作者配色。 */
function accountIconDataUri(hex: string): vscode.Uri {
  const fill = normalizeHex(hex) ?? "#339af0";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
<path fill="${fill}" fill-rule="evenodd" clip-rule="evenodd" d="M8 8a3 3 0 100-6 3 3 0 000 6zm2.5 1H11a3 3 0 013 3v1H0v-1a3 3 0 013-3h8.5z"/>
</svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

export function getAuthorAccountIconUri(
  context: vscode.ExtensionContext,
  authorEmail: string,
  authorName: string
): vscode.Uri {
  const key = authorStyleKey(authorEmail, authorName);
  const file = readAuthorStylesFile(context);
  let color = normalizeHex(file.authors[key]?.color ?? "");
  if (!color) {
    const taken = Object.values(file.authors)
      .map((r) => r.color)
      .filter((c) => normalizeHex(c));
    color = pickDistinctColorForNewAuthor(key, taken);
    file.authors[key] = { color };
    void context.globalState.update(AUTHOR_STYLES_STATE_KEY, file);
  }
  return accountIconDataUri(color);
}
