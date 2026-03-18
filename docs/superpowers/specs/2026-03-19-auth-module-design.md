# Auth 模块设计：ED25519 设备密钥身份

## 概述

ReMi 的 Auth 模块基于 ED25519 密钥对实现设备绑定身份。无登录、无注册、无密码。私钥即身份，签名即授权。

MVP 阶段使用自管密钥方案，正式上线前迁移到 WebAuthn/Passkeys。

## 核心原则

- **公钥即人即 Soul**：一个公钥对应一个人，对应一个 Soul。不存在独立的 user ID 或 soul ID。
- **零摩擦**：新设备自动生成密钥，用户无感。
- **无状态验证**：每次 API 请求独立签名验证，服务端不维护 session。
- **编码统一 base58**：公钥、私钥、签名全部使用 base58 编码，与区块链技术标准一致。

## 密钥生命周期

### 生成

新设备首次访问 PWA 时，客户端用 Web Crypto API 生成 ED25519 密钥对。私钥以 base58 字符串形式存入 IndexedDB。公钥从私钥推导，不单独存储。

```
IndexedDB: remi-keystore / keys
key: "privateKey"
value: "<base58 encoded private key>"
```

### 导出

设置页面提供"导出密钥"功能。展示私钥和公钥的 base58 字符串，用户自行复制保存。需明确提示：私钥等于身份，泄露即丢失控制权。

### 导入

设置页面提供"导入密钥"功能。用户粘贴私钥 base58 字符串，客户端从私钥推导公钥验证有效性后存入 IndexedDB。导入会覆盖当前密钥（已有密钥时先提示确认）。

### 首次访问流程

```
打开 PWA
  → 检查 IndexedDB 中是否有私钥
    → 有 → 加载私钥，推导公钥，正常使用
    → 无 → 自动生成 ED25519 密钥对 → 存入私钥 → 正常使用
```

## 请求签名协议

### 签名构造（客户端）

每次 HTTP 请求，客户端构造待签名字符串：

```
StringToSign = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + BODY_HASH
```

- **METHOD**：HTTP 方法大写（GET、POST 等）
- **PATH**：请求路径含 query string（如 `/souls/abc/anchors?page=1`）
- **TIMESTAMP**：Unix 毫秒时间戳字符串
- **BODY_HASH**：请求体的 SHA-256 哈希 base58 编码；无 body 时用空字符串的 SHA-256

用私钥对 StringToSign 做 ED25519 签名。

### HTTP Headers

```
X-Public-Key: <公钥 base58>
X-Timestamp: <unix 毫秒时间戳>
X-Signature: <签名 base58>
```

### 服务端验证流程

1. 提取三个 Header
2. 检查 X-Timestamp 与服务器时间差 <= 30 秒（防重放）
3. 用相同规则重建 StringToSign
4. 用 X-Public-Key 验证 X-Signature
5. 验证通过 → 继续处理；失败 → 401

不引入 nonce。MVP 阶段 30 秒时间窗口足够防重放。

## 权限模型

### 公钥即 Soul

不需要 souls 表。Soul 随第一次请求隐式创建——服务端发现公钥未见过时，自动初始化一个空的 per-user SQLite 数据库文件。

### 角色判定

服务端收到请求后，根据签名公钥与目标 Soul（URL 中的公钥）的关系判定角色：

| 关系 | 角色 | 可执行操作 |
|------|------|-----------|
| 签名公钥 == URL 中的公钥 | **本体** | 访谈、管理锚点、查看所有数据、生成二维码 |
| 签名公钥 != URL 中的公钥 | **第三方** | 仅向分身提问 |

判定逻辑是一次字符串等值比较。无 ACL 列表，无中间角色。

## 二维码与第三方接入

### 本体生成二维码

本体在 PWA 中点击"分享分身"，生成二维码，内容为 URL：

```
https://{host}/s/{ownerPublicKeyBase58}
```

`/s/` 是分身对话页面的短路径。

### 第三方扫码流程

```
扫码打开 URL
  → PWA 加载
  → 检查本地是否有密钥（无则自动生成）
  → 从 URL 中提取本体公钥
  → 进入对话页面，向本体的分身提问
  → 每次请求用自己的私钥签名
```

第三方的公钥不需要提前注册。服务端收到请求时，签名验证通过即可，公钥不等于 owner 就按第三方处理。

## 客户端 KeyStore 模块

密钥管理逻辑集中在一个 KeyStore 模块中，暴露统一接口：

- `getPublicKey(): string` — 返回公钥 base58
- `sign(data: Uint8Array): string` — 签名并返回 base58
- `exportPrivateKey(): string` — 返回私钥 base58
- `importPrivateKey(key: string): void` — 导入私钥 base58

迁移到 WebAuthn 时替换 KeyStore 内部实现，上层签名协议不变。

## 整体流程总结

```
本体：生成密钥 → 访谈填充锚点 → 分享二维码
第三方：扫码 → 自动生成密钥 → 向分身提问
```

全程零注册、零登录、零授权。

## 未来演进：WebAuthn/Passkeys

正式上线前需迁移到 WebAuthn/Passkeys：

- 跨设备同步（iCloud Keychain / Google Password Manager）
- 生物识别确认（指纹/面容）
- 平台级安全保障

迁移路径：替换 KeyStore 模块内部实现，签名协议和权限模型不变。需要评估 WebAuthn 是否支持对任意数据签名（assertion 的 challenge 字段可用于此目的）。
