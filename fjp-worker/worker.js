/**
 * 小飞机网盘直链解析 - Cloudflare Worker
 * 需要 nodejs_compat 兼容标志
 * 
 * 用法:
 *   https://fjwp.xiaow.qzz.io/?url=https://share.feijipan.com/s/0EdkoxGQ&idx=1
 *   https://fjwp.xiaow.qzz.io/?url=https://share.feijipan.com/s/0EdkoxGQ&pwd=提取码
 * 
 * 参数:
 *   url  - 小飞机网盘分享链接 (必填)
 *   idx  - 文件序号，1=第一个文件 (默认1)
 *   pwd  - 提取码 (选填)
 */

import { createCipheriv } from 'node:crypto';

const AES_KEY = "dingHao-disk-app";

function aesEncryptHex(plaintext) {
  const key = new TextEncoder().encode(AES_KEY);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return encrypted.toString('hex').toUpperCase();
}

// UUID生成：21字符随机字符串（小飞机专用格式）
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

const HEADERS_VIP = {
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

const HEADERS_REDIRECT = {
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

async function handleRequest(request) {
  const url = new URL(request.url);
  const shareUrl = url.searchParams.get('url');

  if (!shareUrl) {
    return new Response('缺少 url 参数\n用法: ?url=https://share.feijipan.com/s/XXX&idx=1&pwd=提取码', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  // 解析分享链接中的 shareId
  const match = shareUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (!match) {
    return new Response('无效分享链接，格式: https://share.feijipan.com/s/XXX', { status: 400 });
  }
  const shareId = match[1];

  // 文件索引（1-based → 0-based）
  const idx = Math.max(0, parseInt(url.searchParams.get('idx') || '1') - 1);
  const password = url.searchParams.get('pwd') || null;

  const uuid = fjUuid();
  const tsEncode = aesEncryptHex(Date.now().toString());

  try {
    // Step 1: VIP预热（可忽略结果）
    const vipUrl = `https://api.feijipan.com/ws/buy/vip/list?devType=3&devModel=Chrome&uuid=${uuid}&extra=2&timestamp=${tsEncode}`;
    await fetch(vipUrl, { method: 'POST', headers: HEADERS_VIP }).catch(() => {});

    // Step 2: 获取文件列表
    let recUrl = `https://api.feijipan.com/ws/recommend/list?devType=3&devModel=Chrome&uuid=${uuid}&extra=2&timestamp=${tsEncode}&shareId=${shareId}&type=0&offset=1&limit=60`;
    if (password) recUrl += `&code=${encodeURIComponent(password)}`;

    const recResp = await fetch(recUrl, { method: 'POST', headers: HEADERS_VIP });
    const recData = await recResp.json();

    if (recData.code !== 200) {
      return new Response(`小飞机API错误: ${recData.msg} (code=${recData.code})`, { status: 502 });
    }

    const fileList = recData.list || [];
    if (fileList.length === 0) {
      return new Response('文件列表为空，链接可能已过期或IP被限制', { status: 404 });
    }

    // 收集所有非文件夹文件
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
        return new Response('此分享是文件夹，暂不支持。请期待后续版本。', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return new Response('分享中没有可下载的文件', { status: 404 });
    }

    if (idx >= allFiles.length) {
      return new Response(
        `文件序号 ${idx + 1} 超出范围，共 ${allFiles.length} 个文件。\n` +
        allFiles.map((f, i) => `  [${i + 1}] ${f.fileName}`).join('\n'),
        { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    const fileIds = fileList[0].fileIds;
    const userId = fileList[0].userId || '';

    // Step 3: 构建 redirect URL
    const nowTs2 = Date.now();
    const tsEncode2 = aesEncryptHex(nowTs2.toString());
    const fidEncode = aesEncryptHex(`${fileIds}|${userId}`);
    const auth = aesEncryptHex(`${fileIds}|${nowTs2}`);

    const redirectUrl = `https://api.feijipan.com/ws/file/redirect?downloadId=${fidEncode}&enable=1&devType=3&uuid=${uuid}&timestamp=${tsEncode2}&auth=${auth}&shareId=${shareId}`;

    // Step 4: 跟随 redirect 拿到直链
    const dlResp = await fetch(redirectUrl, {
      method: 'GET',
      headers: HEADERS_REDIRECT,
      redirect: 'manual',
    });

    if (dlResp.status >= 300 && dlResp.status < 400) {
      const location = dlResp.headers.get('Location');
      if (location) {
        return Response.redirect(location, 302);
      }
    }

    const body = await dlResp.text();
    return new Response(`下载链接获取失败: ${body.substring(0, 300)}`, { status: 502 });

  } catch (err) {
    return new Response(`Worker 内部错误: ${err.message}`, { status: 500 });
  }
}

export default { fetch: handleRequest };
