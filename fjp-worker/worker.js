/**
 * 小飞机网盘直链解析 - Cloudflare Worker
 * 
 * 部署步骤：
 *   1. CF Dashboard → Workers & Pages → 创建 Worker
 *   2. 粘贴此文件全部代码
 *   3. 设置 → Compatibility flags → 添加 "nodejs_compat"
 *   4. 触发器 → 自定义域 → 添加 fjwp.xiaow.qzz.io
 * 
 * 用法:
 *   https://fjwp.xiaow.qzz.io/?url=https://share.feijipan.com/s/0EdkoxGQ
 *   https://fjwp.xiaow.qzz.io/?url=https://share.feijipan.com/s/0EdkoxGQ&idx=2
 *   https://fjwp.xiaow.qzz.io/?url=https://share.feijipan.com/s/0EdkoxGQ&pwd=提取码
 * 
 * 参数:
 *   url - 小飞机网盘分享链接 (必填)
 *   idx - 文件序号，1=第一个文件 (默认1)
 *   pwd - 提取码 (选填)
 */

const AES_KEY = "dingHao-disk-app";

// 用 Web Crypto API 手动实现 AES-128-ECB
// SubtleCrypto 的 AES-CBC 会自动加 padding。绕过方案：
// 每个 16 字节 block 单独做 AES-CBC(zero IV) → 取前 16 字节 = ECB block
async function aesEncryptHex(plaintext) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const blockSize = 16;

  // PKCS7 padding
  const padLen = blockSize - (data.length % blockSize);
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded.fill(padLen, data.length);

  const keyBytes = encoder.encode(AES_KEY);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']
  );

  const zeroIV = new Uint8Array(blockSize);
  const result = new Uint8Array(padded.length);

  for (let i = 0; i < padded.length; i += blockSize) {
    const block = padded.slice(i, i + blockSize);
    // AES-CBC 自动加 padding 会多出一个 block，只取前 16 字节
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: zeroIV }, cryptoKey, block
    );
    result.set(new Uint8Array(encrypted).slice(0, blockSize), i);
  }

  return Array.from(result)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function fjUuid() {
  const chars = [];
  const bytes = new Uint8Array(21);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 21; i++) {
    const b = bytes[i] & 0x3f;
    if (b < 36) chars.push('0123456789abcdefghijklmnopqrstuvwxyz'[b]);
    else if (b < 62) chars.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ'[b - 36]);
    else if (b > 62) chars.push('-');
    else chars.push('_');
  }
  return chars.join('');
}

// ============ HTML 错误页面 ============

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;color:#333;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:520px;width:100%;padding:32px}
  .card h1{font-size:18px;margin-bottom:8px;color:#e74c3c}
  .card h1.ok{color:#27ae60}
  .card p{color:#666;margin-bottom:16px}
  .card pre{background:#f8f8f8;border-radius:6px;padding:14px 16px;font:13px/1.5 "SF Mono",Monaco,Menlo,monospace;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  .card .list-item{display:flex;align-items:center;padding:6px 0;border-bottom:1px solid #f0f0f0}
  .card .list-item:last-child{border-bottom:none}
  .card .list-item .idx{display:inline-block;width:28px;height:22px;line-height:22px;text-align:center;background:#5046e4;color:#fff;border-radius:4px;font-size:12px;margin-right:10px;flex-shrink:0}
  .card .list-item .name{font-size:14px;color:#333;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .card .footer{margin-top:20px;padding-top:16px;border-top:1px solid #f0f0f0;font-size:13px;color:#999}
  .card .footer a{color:#5046e4;text-decoration:none}
</style>
</head>
<body>
<div class="card">
${body}
<div class="footer">小飞机网盘直链解析 · <a href="https://blog.xiaow.qzz.io">blog.xiaow.qzz.io</a></div>
</div>
</body>
</html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function errorResponse(status, title, detail) {
  const body = `<h1>${escapeHtml(title)}</h1><pre>${escapeHtml(detail)}</pre>`;
  return new Response(htmlPage(title, body), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ============ 请求头 ============

const HEADERS_API = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://share.feijipan.com/',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

const HEADERS_DL = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://www.feijix.com/',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'sec-ch-ua': '"Microsoft Edge";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

// ============ 辅助 ============

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`非JSON响应 (HTTP ${resp.status}): ${text.substring(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ============ 主处理 ============

async function handleRequest(request) {
  const reqUrl = new URL(request.url);
  const shareUrl = reqUrl.searchParams.get('url');

  if (!shareUrl) {
    return errorResponse(400, '缺少 url 参数',
      '用法：?url=https://share.feijipan.com/s/XXX\n可选：&idx=1 &pwd=提取码');
  }

  const match = shareUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (!match) {
    return errorResponse(400, '无效分享链接',
      `无法从链接中提取分享ID\n链接: ${shareUrl}\n期望格式: https://share.feijipan.com/s/XXX`);
  }

  const shareId = match[1];
  const idx = Math.max(0, parseInt(reqUrl.searchParams.get('idx') || '1') - 1);
  const password = reqUrl.searchParams.get('pwd') || null;

  const uuid = fjUuid();
  const tsEncode = await aesEncryptHex(Date.now().toString());

  try {
    // Step 1: VIP预热
    const vipUrl = `https://api.feijipan.com/ws/buy/vip/list?devType=3&devModel=Chrome&uuid=${uuid}&extra=2&timestamp=${tsEncode}`;
    await fetch(vipUrl, { method: 'POST', headers: HEADERS_API }).catch(() => {});

    // Step 2: 获取文件列表
    let recUrl = `https://api.feijipan.com/ws/recommend/list?devType=3&devModel=Chrome&uuid=${uuid}&extra=2&timestamp=${tsEncode}&shareId=${shareId}&type=0&offset=1&limit=110`;
    if (password) recUrl += `&code=${encodeURIComponent(password)}`;

    const recData = await fetchJSON(recUrl, { method: 'POST', headers: HEADERS_API });

    if (recData.code !== 200) {
      return errorResponse(502, `小飞机API错误: ${recData.msg}`,
        `API 返回 code=${recData.code}，msg="${recData.msg}"\n${recData.msg === '参数有误' ? '提取码可能不正确，请检查。' : '分享链接可能已过期或被删除。'}`);
    }

    const fileList = recData.list || [];
    if (fileList.length === 0) {
      if (!password) {
        return errorResponse(404, '文件列表为空 — 可能需要提取码',
          '未获取到任何文件。\n如果此分享需要提取码，请在 URL 后加上 &pwd=提取码');
      }
      return errorResponse(404, '提取码可能不正确',
        `已使用提取码 "${password}"，但未获取到文件。\n请检查提取码是否正确。`);
    }

    // 收集文件
    const allFiles = [];
    let hasFolder = false;
    for (const item of fileList) {
      for (const f of (item.fileList || [])) {
        if (f.fileType === 2) { hasFolder = true; continue; }
        allFiles.push(f);
      }
    }

    if (allFiles.length === 0) {
      if (hasFolder) {
        return errorResponse(400, '暂不支持文件夹',
          '此分享是一个文件夹，当前版本暂不支持文件夹解析。\n请期待后续更新。');
      }
      return errorResponse(404, '无可下载文件', '分享中没有找到可下载的文件。');
    }

    // idx 超出范围 → 列出所有文件
    if (idx >= allFiles.length) {
      const fileListHtml = allFiles.map((f, i) =>
        `<div class="list-item"><span class="idx">${i + 1}</span><span class="name">${escapeHtml(f.fileName)}</span></div>`
      ).join('');

      const body = `<h1>序号 ${idx + 1} 超出范围</h1>
<p>此分享共有 <strong>${allFiles.length}</strong> 个文件，请选择：</p>
<div class="list-items">${fileListHtml}</div>
<pre>共 ${allFiles.length} 个文件，你请求的是第 ${idx + 1} 个（超出范围）
请在 url 后加 &amp;idx=N 指定序号

${allFiles.map((f, i) => `  [${i + 1}] ${f.fileName}`).join('\n')}</pre>`;

      return new Response(htmlPage('序号超出范围', body), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    const fileId = allFiles[idx].fileId;
    const userId = fileList[0].userId || '';

    // Step 3: 构建下载 redirect URL
    const nowTs2 = Date.now();
    const tsEncode2 = await aesEncryptHex(nowTs2.toString());
    const fidEncode = await aesEncryptHex(`${fileId}|${userId}`);
    const auth = await aesEncryptHex(`${fileId}|${nowTs2}`);

    const redirectUrl = `https://api.feijipan.com/ws/file/redirect?downloadId=${fidEncode}&enable=1&devType=3&uuid=${uuid}&timestamp=${tsEncode2}&auth=${auth}&shareId=${shareId}`;

    // Step 4: 获取 302 直链
    const dlResp = await fetch(redirectUrl, {
      method: 'GET',
      headers: HEADERS_DL,
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });

    if (dlResp.status >= 300 && dlResp.status < 400) {
      const location = dlResp.headers.get('Location');
      if (location) {
        return Response.redirect(location, 302);
      }
    }

    const respBody = await dlResp.text();
    return errorResponse(502, '获取下载链接失败',
      `小飞机服务器返回了非预期的响应 (${dlResp.status})\n${respBody}\n\n调试信息:\nfileIds=${fileIds}\nuserId="${userId}"\nredirectUrl=${redirectUrl}`);

  } catch (err) {
    return errorResponse(500, 'Worker 内部错误', err.message);
  }
}

export default { fetch: handleRequest };
