// GitLab API 客户端：PAT 认证 + vault 只读 + Commits 回写
export interface GitLabConfig { host: string; token: string; projectId: string }

export function loadConfig(): GitLabConfig | null {
  try {
    const raw = localStorage.getItem('pr-web:gitlab');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export function saveConfig(c: GitLabConfig): void {
  localStorage.setItem('pr-web:gitlab', JSON.stringify(c));
}

function api(c: GitLabConfig, path: string, init?: RequestInit): Promise<any> {
  const url = `https://${c.host}/api/v4${path}`;
  return fetch(url, {
    ...init,
    headers: { 'PRIVATE-TOKEN': c.token, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  }).then(async r => {
    if (r.status === 401) throw new Error('PAT 无效或已过期');
    if (r.status === 403) throw new Error('无权限（需要 read_api/reporter 角色）');
    if (r.status === 404) throw new Error('项目或文件不存在');
    if (!r.ok) throw new Error(`GitLab ${r.status}`);
    return r.json();
  });
}

// PAT 校验 + 项目校验（Task 24）
export async function verifyConfig(c: GitLabConfig): Promise<{ userName: string; projectName: string }> {
  const user = await api(c, '/user');
  const proj = await api(c, `/projects/${encodeURIComponent(c.projectId)}`);
  return { userName: user.username, projectName: proj.path_with_namespace };
}

// tree API：列出 papers/ 下的目录（Task 25）
export async function listPaperDirs(c: GitLabConfig): Promise<string[]> {
  const tree = await api(c, `/projects/${encodeURIComponent(c.projectId)}/repository/tree?path=papers&per_page=100&page=1`);
  // 翻页（>100 篇）
  let page = 2;
  let more: any[] = [];
  do {
    more = await api(c, `/projects/${encodeURIComponent(c.projectId)}/repository/tree?path=papers&per_page=100&page=${page}`);
    tree.push(...more);
    page += 1;
  } while (more.length === 100);
  return tree.filter((e: any) => e.type === 'tree').map((e: any) => e.name);
}

const fileCache = new Map<string, string>();
export function clearCache(): void { fileCache.clear(); }

export async function fetchRaw(c: GitLabConfig, filePath: string): Promise<string> {
  const key = filePath;
  const hit = fileCache.get(key);
  if (hit !== undefined) return hit;
  const blobs = await api(c, `/projects/${encodeURIComponent(c.projectId)}/repository/files/${encodeURIComponent(filePath)}/raw?ref=main`);
  const text = typeof blobs === 'string' ? blobs : JSON.stringify(blobs);
  fileCache.set(key, text);
  return text;
}

// Commits API 回写（Task 27）：action update 单文件
export async function commitFile(c: GitLabConfig, filePath: string, content: string, message: string): Promise<void> {
  clearCache(); // 失效缓存
  await api(c, `/projects/${encodeURIComponent(c.projectId)}/repository/commits`, {
    method: 'POST',
    body: JSON.stringify({
      branch: 'main',
      commit_message: message,
      actions: [{ action: 'update', file_path: filePath, content }],
    }),
  });
}

export function rawPdfUrl(c: GitLabConfig, filePath: string): string {
  return `https://${c.host}/api/v4/projects/${encodeURIComponent(c.projectId)}/repository/files/${encodeURIComponent(filePath)}/raw?ref=main&private_token=${encodeURIComponent(c.token)}`;
}
