// ============================================================
// 用户配置 —— 请把本文件改成你自己的店铺信息后再使用。
// 本文件为「公开示例」，不含任何真实账号 / 店铺数据。
//
// 更安全的做法：账号密码用环境变量传入（不要硬编码明文）
//   export DOUYIN_EMAIL="你的抖店登录邮箱"
//   export DOUYIN_PASSWORD="你的抖店登录密码"
// ============================================================

// 同一抖店账号下管理的多店铺。每个品牌需配置：
//   fullName : 后台「切换数据视角」弹窗中显示的店铺全名（自动化据此点击切换）
//   keywords : 交易明细「商品构成」sheet 商品名里能标识本品牌的特征词
//              （用于内容级品牌校验，防止多店铺数据串味错标）
export const BRAND_CONFIG = {
  '品牌A': {
    fullName: '品牌A官方旗舰店',
    keywords: ['品牌A'],
  },
  '品牌B': {
    fullName: '品牌B官方旗舰店',
    keywords: ['品牌B'],
  },
  // 按需增删品牌，例如：
  // '品牌C': { fullName: '品牌C专营店', keywords: ['品牌C', 'C家'] },
};

// 默认下载的品牌顺序（也可用 --brands 参数 / BRANDS 环境变量覆盖）
export const DEFAULT_BRANDS = ['品牌A', '品牌B'];

// 抖店登录账号（建议用环境变量传入，不要硬编码明文）
export const ACCOUNT = {
  email: process.env.DOUYIN_EMAIL || '<你的抖店登录邮箱>',
  password: process.env.DOUYIN_PASSWORD || '<你的抖店登录密码>',
};

// 由 BRAND_CONFIG 派生（无需手动改）
export const BRAND_FULL_NAMES = Object.fromEntries(
  Object.entries(BRAND_CONFIG).map(([k, v]) => [k, v.fullName])
);
export const BRAND_KEYWORDS = Object.fromEntries(
  Object.entries(BRAND_CONFIG).map(([k, v]) => [k, v.keywords])
);
