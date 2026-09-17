# 04 · 数据模型勘察：42 张表与 ERD/MCD/MLD

> 勘察对象：`origin/old/main` 分支（VRCX(MIT) fork 链上的前身工程）。
> 产出性质：**只读经验勘察**，供 schema v1（数据引擎）设计参照。产出位于 `.temp/legacy-recon/`，不入库、不落 docs。
> 读取方式：全部证据来自 `git show origin/old/main:<路径>`；源文件副本存于 `.temp/legacy-recon/_raw/`（gitignore，可随时删除）。

## 0. 模型目录全貌（docs/architecture/models/）

| 文件 | 大小 | 性质 |
|---|---|---|
| `vrcx_sr_ddl.sql` | 10,501 B（git 实际；任务表中 368 行不符） | **SR（逻辑模型）DDL，42 张表**，Mocodo 4.3.3 生成，单行 |
| `vrcx_sr.mcd` | 4,657 B | SR 的 **MCD（概念模型）源**，Mocodo 输入格式 |
| `vrcx_sr_mld.md` | 4,124 B | SR 的 **MLD（逻辑模型）文档**，42 张表 |
| `vrcx_sr_erd_crow.gv` / `.svg` | 32.5 KB / 179 KB | Mocodo 生成的 **crow's foot ERD**（Graphviz） |
| `vrcx_sr_geo.json` | 3,256 B | Mocodo **布局坐标数据**（42 表的 cx/cy） |
| `vrcx_sr.svg` | 65.8 KB | Mocodo 全景图 |
| `vrcx_mcd_ddl.sql` | 15,462 B | **MCD 物化 DDL：41 实体 + 13 关联表 = 54 张表，41 条 FK** |
| `vrcx_mcd.mcd` | 4,812 B | MCD 源（含 12 个关联实体建模） |
| `vrcx_mcd_mld.md` | 4,691 B | MCD 的 MLD 文档 |
| `vrcx_mcd_erd_crow.gv` / `.svg` | 32.6 KB / 194.6 KB | MCD 的 crow's foot ERD |
| `vrcx_mcd_geo.json` | 7,068 B | MCD 布局坐标（含关联表） |
| `vrcx_erd.dbml` | 14,580 B | **手写 dbdiagram.io 格式 ERD（40 张表 / 23 条 Ref），带字段级语义注释** |
| `vrcx_erd.mmd` | 8,554 B | **Mermaid erDiagram 版（39 张表 / 24 条关系，生成自 dbml）** |
| `vrcx_erd.svg` | 758 KB | Mermaid 渲染图 |

git 历史：整个目录只出现在一次提交 `d10b0cc0 refactor: 仓库转移收尾 — VRCX-K 品牌、服务指向、文档体系、依赖安全（一次性巨大提交）`——即 old/main 根提交，无法从 git 时间线分辨各模型文件的先后次序；「V2/OLD 演进痕迹」只能从文件内容与实现代码反推（见 §6）。

**血统事实**：`_pri_`/`_pub_` 的后缀约定在 dbml 头部注释自述：「(pri) = User-specific table → actual name: {userPrefix}_xxx；(pub) = Global shared table → actual name: xxx」，并注明「Generated from src/services/database/index.js」。该文件在 old/main 上存在且是数据库层入口（`src/services/database/index.js`），后缀约定来自**多账号隔离方案**（详见 docs/architecture/MULTI_ACCOUNT_V4_DETAIL_DESIGN.md）。

## 1. 42 张表清单与领域分层（SR = 逻辑模型视角）

> 表名用手写规范大小写（DB 实际表名全小写下划线，前缀见 §2）。`(pri)` = 每账号一份；`(pub)` = 全局共享。

### A. 账户 / 凭证
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `USER_pri_` | 用户 | 好友用户主实体（user_id、display_name、trust_level、friend_number），**所有 pri 社交表的关联枢纽** |
| `COOKIES_pub_` | 凭证 | key-value 认证 Cookie 存储，**全局共享**（跨账号？见 §7） |
| `CONFIGS_pub_` | 配置 | key-value 运行时配置（全局） |
| `MODERATION_pri_` | 账户 | 当前登录号的 Block/Mute 名单（updated_at、block、mute） |

### B. 好友与社交
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `FRIEND_LOG_CURRENT_pri_` | 好友 | 当前好友列表快照（user_id、display_name、trust_level、friend_number） |
| `FRIEND_LOG_HISTORY_pri_` | 好友 | 好友关系变更历史（type: Friend/UnFriend/DisplayName/TrustLevel + previous_* 字段） |
| `TRACKED_NONFRIENDS_pri_` | 追踪 | 本地手动追踪的非好友 watch list（user_id、display_name、added_at） |
| `MANUAL_RELATIONS_MANUEL_pri_` | 关系图 | 用户间手工指定的关系（user_id_a、user_id_b、relation_type，**表名拼写 MANUEL 为真实痕迹**） |
| `MUTUAL_GRAPH_FRIENDS_pri_` | 互斥图 | 互斥好友图节点（friend_id） |
| `MUTUAL_GRAPH_LINKS_pri_` | 互斥图 | 互斥图边（friend_id ↔ mutual_id），**当前无日期** |
| `MUTUAL_GRAPH_META_pri_` | 互斥图 | per-friend 拉取状态（last_fetched_at、opted_out） |
| `MUTUAL_GRAPH_FRIENDS_OLD_pri_` | 互斥图 | **PR#21 新增**：per-friend 最后 API 拉取时间（last_updated），stale 徽标依据 |
| `MUTUAL_GRAPH_LINKS_OLD_pri_` | 互斥图 | **PR#21 新增**：带日期戳的互斥边历史（date = 边最后确认日） |

### C. Feed（好友动态流）
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `FEED_AVATAR_pri_` | Feed | 好友换头像事件（avatar_name、current/previous 头像 URL） |
| `FEED_BIO_pri_` | Feed | 好友改简介事件（bio、previous_bio） |
| `FEED_GPS_pri_` | Feed | 好友位置/世界变化事件（location、world_name、previous_location、time=停留毫秒） |
| `FEED_ONLINE_OFFLINE_pri_` | Feed | 好友上下线事件（type: Online/Offline、time=在线时长 ms） |
| `FEED_STATUS_pri_` | Feed | 好友状态变更事件（status/status_description + previous_*） |

### D. 游戏日志（GAMELOG，记录自己实例内的经历）
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `GAMELOG_LOCATION_pub_` | 游戏日志 | 进入过的实例（location、world_id、time=停留时长、group_name），**pub 却含 world FK** |
| `GAMELOG_JOIN_LEAVE_pub_` | 游戏日志 | 实例内 OnPlayerJoined/OnPlayerLeft 事件（type、user_id、time=玩家在场时长 ms） |
| `GAMELOG_PORTAL_SPAWN_pub_` | 游戏日志 | 观察到的传送门生成（user_id、instance_id、world_name） |
| `GAMELOG_VIDEO_PLAY_pub_` | 游戏日志 | 实例内播放的视频（video_url、video_name、video_id、user_id） |
| `GAMELOG_RESOURCE_LOAD_pub_` | 游戏日志 | 外部 URL/图片资源加载（**防火墙追踪**：resource_url、resource_type） |
| `GAMELOG_EVENT_pub_` | 游戏日志 | 自定义 Udon 事件（纯 data 字段） |
| `GAMELOG_EXTERNAL_pub_` | 游戏日志 | 外部聊天/SDK 消息（message、display_name、user_id、location） |

### E. 通知
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `NOTIFICATION_pri_` | 通知 | 旧版 VRChat 通知（invite/request/response 消息体、expired、sender/receiver_user_id） |
| `NOTIFICATIONS_V2_pri_` | 通知 | **新版通知**（id 为 VRChat 通知 ID；link/link_text/title/seen/data/responses/details 等 V2 字段） |

### F. 收藏
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `FAVORITE_WORLD_pub_` | 收藏 | VRC 服务器同步的收藏世界（group_name） |
| `FAVORITE_AVATAR_pub_` | 收藏 | 收藏头像（group_name） |
| `FAVORITE_FRIEND_pub_` | 收藏 | 收藏好友（user_id_ref）。**注意：pub 全局表却引用 pri 的 USER** |

### G. 备注 / 标签（memo/tag）
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `MEMO_pub_` | 备注 | 对其他用户的留言（user_id_ref2 → USER）。**pub 表引用 pri USER** |
| `NOTES_pri_` | 备注 | per-friend 私人笔记（user_id、display_name、note、created_at）。与 MEMO 并存 |
| `WORLD_MEMO_pub_` | 备注 | 世界留言（world_id） |
| `AVATAR_MEMO_pub_` | 备注 | 头像留言（avatar_id） |
| `AVATAR_TAG_pub_` | 标签 | 头像自定义彩色标签（avatar_id、tag、color） |

### H. 缓存
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `CACHE_AVATAR_pub_` | 缓存 | VRChat 头像元数据缓存（id 即头像 ID；version、release_status 等） |
| `CACHE_WORLD_pub_` | 缓存 | VRChat 世界元数据缓存 |
| `AVATAR_HISTORY_pri_` | 缓存/历史 | 头像穿戴历史（avatar_id、time=累计穿戴毫秒） |

### I. 活动/在线时长统计（重点，见 §5）
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `ACTIVITY_SYNC_STATE_V2_pri_` | 活动 | 活动追踪的每好友增量同步状态（游标） |
| `ACTIVITY_SESSION_V2_pri_` | 活动 | 计算出的在线会话窗口（heatmap 源） |
| `ACTIVITY_BUCKET_CACHE_V2_pri_` | 活动 | 图表预计算 bucket 缓存（按 view/range/exclude 组合） |

### J. VRC 对象实体
| 表名 (SR) | 领域 | 一句话用途 |
|---|---|---|
| `AVATAR_pub_` | 实体 | VRC 头像对象（avatar_id、name、author_id/name、image_url、release_status、version）——SR 逻辑模型里与 CACHE_AVATAR 并存 |
| `WORLD_pub_` | 实体 | VRC 世界对象（world_id、name、description、author、image_url、release_status、version）——MCD 中 GAMELOG_LOCATION / FAVORITE_WORLD / WORLD_MEMO 的关联目标 |

**计数核对（SR DDL 42 张）**：A 账户/凭证 4 + B 好友与社交 8 + C Feed 5 + D 游戏日志 7 + E 通知 2 + F 收藏 3 + G 备注/标签 5 + H 缓存 3 + I 活动 3 + J 对象实体 2 = **42 张 ✓**（对照 `vrcx_sr_ddl.sql` 逐一核对无遗漏无重复）。

## 2. 命名约定：`_pri_` / `_pub_` / `_V2_` / `_OLD_`

### 2.1 `_pri_` vs `_pub_`（私有/公开数据的真实含义 = 多账号隔离）
- **规则**：`_pri_` 表 = **User-specific（每登录账号一份）**，实际表名 = `{userPrefix}_表名`；`_pub_` 表 = **Global shared（全实例一份）**，实际表名 = `表名`。
- **由来**（dbml 头部注释 + 实现代码双证）：
  - dbml 第 5 行：`// (pri) = User-specific table → actual name: {userPrefix}_xxx // (pub) = Global shared table → actual name: xxx`
  - SQLiteAdapter.js `userTable(prefix, name)`：`return \`${p}_${name}\`;`——运行时把物理表名拼上前缀。
  - prefix 由 `computeUserPrefix(userId)` 生成（src/services/accountSession.js:561）：`userId` 去掉 `-`/`_`，若以数字开头则前置 `_`（如 `usr_xxxxxxxx` → `usrxxxxxxxx`）。因此同一数据库文件里每个账号一组 `usrXXX_*` 表。
- **语义**：`_pub_` 是「所有账号共享的只读参照数据」（VRC 对象缓存、收藏、全局配置、Cookie 池、游戏日志、memo）；`_pri_` 是「follow 当前登录号身份的个性化/私有数据」（好友、feed、笔记、通知、互斥图、活动统计、block 名单）。

### 2.2 `_V2_` = 结构升级版（新版本并存旧表，非迁移重建）
- `NOTIFICATIONS_V2_pri_` 与 `NOTIFICATION_pri_` **同时存在**：V2 为 VRChat 通知 API 的新格式（id=通知 ID、title/link/details/responses/seen），旧表保留旧格式（invite_message/request_message/response_message 手工消息字段）。两表并存、分别写入，而非 ALTER 迁移。
- `ACTIVITY_*_V2`：活动统计三表整体带 `V2`（相对于更早的在线统计表，见 §6.1）。

### 2.3 `_OLD_` = 带日期的新增补充表（不是废弃表！）
- `MUTUAL_GRAPH_LINKS_OLD_pri_` / `MUTUAL_GRAPH_FRIENDS_OLD_pri_` 的 dbml 注释直接标「**NEW (PR #21)**: Dated edge history - when the mutual link was last confirmed」与「Per-friend last sync timestamp for stale badge detection」。
- 即「OLD」修饰的是**边历史**（带 date 列），是互斥图功能的一次**功能演进而非结构替换**：`_OLD` 系列与当前 `mutual_graph_links`（无日期）并存，前者负责「互斥关系何时最后确认」的时间维度。
- 实现证据：mutualGraph.js 中 `_OLD` 表同时被 get/merge/update/bulk 使用，pullEngine/pushEngine 也同步复制（本地 ↔ 远端同步用）。

## 3. ERD 文件的规模与可用性

### 3.1 vrcx_erd.dbml（主 ERD，可直接导入建模工具）
- **40 张表**（22 `pri_` + 18 `pub_`）、**23 条 Ref 关系**。
- dbml 是 **dbdiagram.io 原声格式**：可直接粘贴导入 dbdiagram.io / dbdocs，或经工具转成 DDL；带字段级注释（如 `time integer [note: "Duration in ms spent at previous location"]`），语义完整。**这是三份模型里信息量最大、最适合作为我们参照起点的一份。**
- dbml 缺 3 张 SR 表：`USER_pri_`、`AVATAR_pub_`、`WORLD_pub_`（数据由 CACHE_* 承载，故未单列；mmd 版也未列 USER/WORLD/AVATAR 实体，但补了 `pri_mutual_graph_friends`）。差异点本身就是信息：**实体表（USER/AVATAR/WORLD）在公司文档里被「缓存表」部分吸收**。

### 3.2 vrcx_erd.mmd（Mermaid 版，39 张表 / 24 条关系）
- 由 dbml 生成（同为一行注释头风格），39 张表（无 `USER`/`AVATAR`/`WORLD` 实体、无 `pri_manual_relations_MANUEL`）、24 条 `||--o{` 关系（其中 notification 的 sender/receiver 两条画成同向，属生成瑕疵）。
- **可直接粘贴进支持 mermaid 的编辑器/文档**（GitHub markdown、Typora 等）。

### 3.3 Mocodo 产线（SR/MCD）
- `vrcx_sr.mcd` + `vrcx_sr_geo.json` + `vrcx_sr_erd_crow.gv/.svg` + `vrcx_sr_ddl.sql` + `vrcx_sr_mld.md` 是 **Mocodo 4.3.3 一条产线**（.mcd 是绘图+DDL+MLD 的单一源，geo.json 存布局）。
- 重要提醒：**Mocodo 生成的 DDL 不能用**——表名带 `_pri_`/`_pub_` 后缀（`CREATE TABLE ACTIVITY_SESSION_V2_pri_`），列类型全是占位 `VARCHAR(42)`（Mocodo 对无类型信息 MCD 的默认宽度）；物理 DDL 的真源是三个 Adapter（SQLite/MySQL/PgSQL）里的 `initUserSchema` SQL 字符串。**关系也不在物理库强制**（见 §4）。

## 4. 跨表关系（主要关联）

### 4.1 dbml 记录的 23 条 Ref（逻辑关联）
**好友中心**（`pri_friend_log_current.user_id` 作枢纽，10 条）：
```
pri_friend_log_current.user_id < pri_friend_log_history.user_id
                              < pri_feed_gps.user_id
                              < pri_feed_status.user_id
                              < pri_feed_bio.user_id
                              < pri_feed_avatar.user_id
                              < pri_feed_online_offline.user_id
                              < pri_moderation.user_id
                              < pri_notes.user_id
                              < pri_activity_sync_state_v2.user_id
                              < pri_activity_sessions_v2.user_id
pri_friend_log_current.user_id < pri_notifications.sender_user_id
                              < pri_notifications.receiver_user_id
```
**互相好友图**（4 条）：
```
pri_mutual_graph_friends.friend_id < pri_mutual_graph_links.friend_id
pri_mutual_graph_friends.friend_id < pri_mutual_graph_links.mutual_id
pri_mutual_graph_friends_old.friend_id < pri_mutual_graph_links_old.friend_id
pri_mutual_graph_friends_old.friend_id < pri_mutual_graph_links_old.mutual_id
```
**游戏日志**（1 条）：`pub_gamelog_location.location < pub_gamelog_join_leave.location`（**按实例 location 字符串关联，非 ID**）。
**缓存→收藏/备注/日志（5 条）**：
```
pub_cache_world.id < pub_favorite_world.world_id
pub_cache_world.id < pub_world_memos.world_id
pub_cache_world.id < pub_gamelog_location.world_id   ← 注释: loose reference, no FK enforcement in SQLite
pub_cache_avatar.id < pub_favorite_avatar.avatar_id
pub_cache_avatar.id < pub_avatar_memos.avatar_id
pub_cache_avatar.id < pub_avatar_tags.avatar_id
```

### 4.2 MCD（概念模型）里的多对多关联（设计意图层）
MCD DDL 把「一个事件由哪个用户产生」建模成独立关联表，**物理上等于把 user 外键从事件表拆出来**：
- `HAS_AVATAR/HAS_BIO/HAS_STATUS/IS_ONLINE/POSTED/LOGGED/JOIN_BY`（各 (user_id, event_id)，把 FEED_*/FRIEND_LOG_HISTORY/GAMELOG_JOIN_LEAVE 挂到 USER）
- `RELATED`（user_id_1, user_id_2, relation_type → MANUAL_RELATION 的多对多）
- `TRACKED_BY`（USER ↔ TRACKED_NONFRIEND 多对多）
- `TAGGED`（AVATAR ↔ AVATAR_TAG）、`BUCKET_FOR`（USER ↔ ACTIVITY_BUCKET_CACHE）
- `FAV_FRIEND_OF`（USER ↔ FAVORITE_FRIEND）、`NOTIF_V2_FOR`（USER ↔ NOTIFICATIONS_V2）
- SR（逻辑模型）把这些关联**折叠回事件表内嵌 user_id 外键列**——两个抽象层级并存，SR 更接近实际物理表。

### 4.3 物理层事实
- **SQLite 物理库不强制 FK**（dbml 第 44 行显式注释）；MySQL/PgSQL Adapter 的建表 SQL 同样以「列 + 索引」为主，**关系是查询时按列名约定关联**。所有跨表关联都以 VRChat 用户 ID 字符串（`user_id`）或 location 字符串为纽带，不是自增整数外键。
- GAMELOG_* 多数不挂 USER（只有 JOIN_LEAVE/VIDEO_PLAY/EXTERNAL/PORTAL_SPAWN 带 user_id，且是「出现在我实例中的他人」），体现日志表相对独立。

## 5. 活动/在线时长模型详解（ACTIVITY_*_V2）

**整体意图**：把「好友在线/离线」与「自己在实例」两类原始事件，增量聚合成「在线会话窗口」，再按图表视角预计算 bucket，避免每次打开热力图都全表扫描。三表分工：

### 5.1 `ACTIVITY_SYNC_STATE_V2_pri_`（增量同步游标，每好友一行）
| 字段 | 语义（SR 列） | dbml/实现确认 |
|---|---|---|
| `user_id` | PK，被追踪好友（或自己） | — |
| `updated_at` | 本行最后同步时间 | — |
| `is_self` | **1 = 该行追踪当前登录号自己**（活动来源不同：自己用 gamelog_location，好友用 feed_online_offline） | activityV2.js `getActivitySourceSliceV2` 按 isSelf 分叉 |
| `source_last_created_at` | **增量游标**：源事件最后一次的 created_at（增量拉取「只取 created_at > 游标」） | `getActivitySourceAfterV2(afterCreatedAt)` |
| `pending_session_start_at` | **未闭合会话的开始时间戳**（用户在线但尚未出现 Offline 事件时暂存） | upsert 直接透传 |
| `cached_range_days` | 已缓存的活动天数范围（决定重算窗口） | — |

### 5.2 `ACTIVITY_SESSION_V2_pri_`（会话窗口，heatmap 源）
| 字段 | 语义 |
|---|---|
| `session_id` | 自增 PK |
| `user_id` | 归属用户 |
| `start_at` / `end_at` | **Unix 时间戳（毫秒）**（dbml note: "Unix timestamp ms"） |
| `is_open_tail` | **1 = 会话仍在进行**（尚未看到结束事件） |
| `source_revision` | 源数据版本标记（重算/增量追加时区分代际，避免混入过期会话） |

写入策略（activityV2.js）：
- `replaceActivitySessionsV2(userId, sessions)`：**整表重建**（事务内 delete + insert 分块 250/批）。
- `appendActivitySessionsV2({replaceFromStartAt})`：**增量追加**；带 `replaceFromStartAt` 时先删 `start_at >= 该值` 的旧会话再插入——用于**重算局部区间**。
- 查询按 `user_id + start_at` 排序（有 `_user_start_idx`/`_user_end_idx` 索引）。

### 5.3 `ACTIVITY_BUCKET_CACHE_V2_pri_`（图表预计算缓存）
复合主键 = **(user_id, target_user_id, range_days, view_kind, exclude_key)**——
| 字段 | 语义 |
|---|---|
| `user_id` | 缓存归属（当前登录号） |
| `target_user_id` | 图表主体（被查看的好友；空 = 自己） |
| `range_days` | 时间范围（如 30/90 天） |
| `view_kind` | 视图种类（activity / overlap——activityV2.js 常量） |
| `exclude_key` | 排除条件键（如同一好友的过滤参数） |
| `bucket_version` | 缓存格式版本（**默认 1**，格式升级时失效全部旧缓存） |
| `raw_buckets_json` | 原始 bucket JSON（默认 `[]`） |
| `normalized_buckets_json` | 归一化后 bucket JSON（默认 `[]`） |
| `built_from_cursor` | 构建时所用游标（可与 sync_state 对账） |
| `summary_json` | 汇总 JSON（默认 `{}`） |
| `built_at` | 构建时间 |

**要点**：
1. 缓存键把「视图参数」显式编码进主键 → **换参数即换缓存行**，无需过期表清理；但组合键膨胀（同好友 × 多范围 × 多视图 × 多排除键 = 多行）。
2. `bucket_version` 是**结构性失效开关**：改了聚合算法只 bump 版本号，读取端按版本判断缓存是否仍可用。
3. 数据流：`feed_online_offline`（好友）或 `gamelog_location`（自己）原始事件 → 增量拉取（游标）→ 拼合会话窗口（含 open tail）→ 写 sessions → 按视图聚合 → 写 bucket cache → 图表直接读 cache。

## 6. 迁移与版本痕迹（`_V2_`、`_OLD_`）

### 6.1 由表名可推断的演进层次
1. **NOTIFICATION → NOTIFICATIONS_V2**：同域两代结构并存（旧字段手工消息体 vs 新字段 link/title/details/responses），**升级方式是新增表、旧表保留**（不是 ALTER）。
2. **ACTIVITY_* → ACTIVITY_*_V2**：早期在线统计（可能只有 feed_online_offline 聚合）演进为「sync_state + sessions + bucket_cache」三件套；三表名字统一带 V2，说明 **V2 是一次成套重构**。
3. **MUTUAL_GRAPH_* → MUTUAL_GRAPH_*_OLD**：不是替换而是**补充时间维度**（见 2.3）。OLD 表带 `date`/`last_updated`，当前 `mutual_graph_links` 无日期——新需求（stale 检测、边时间线）用「加新表」解决，避免 ALTER 现有表。
4. **MUTUAL_GRAPH_FRIENDS（无后缀）在 dbml 是实体、在 SR DDL 缺失**：mmd 版有 `pri_mutual_graph_friends`，35 行 `MUTUAL_GRAPH_FRIENDS_OLD` 说明节点表确实存在；SR DDL 漏掉它（`MUTUAL_GRAPH_LINKS` 直接悬空引用），是**文档与实现不同步**的实例（物理 SQLiteAdapter 建表里有 `mutual_graph_friends`）。

### 6.2 为什么保留 `MUTUAL_GRAPH_LINKS_OLD_pri_`（不在迁移时删）
- 功能需要：它承载「该互斥关系**上次确认的日期**」，是 UI 上 stale/新鲜度徽标的唯一依据（`friends_old.last_updated` + `links_old.date`）。
- 迁移成本考虑：把 date 塞进现有 `mutual_graph_links`（加列）要改主键/写路径/远端同步格式；新增表 + push/pull 复制反而低风险（pullEngine.js:99-100 / pushEngine.js:107-108 都把两个 OLD 表列入同步清单）。
- **经验**：这个项目对「结构演进」的默认反应是**新表并存**，而非收缩式迁移；`_OLD_`/`_V2_` 后缀是这种「加法演进」策略的命名档案。

## 7. 经验点汇总（供 schema v1 参照）

### 经验点 1：多账号隔离不靠「数据库实例」，靠「表名前缀」
- **解决什么问题**：一个 SQLite 文件支持多账号登录、并各自拥有独立的好友/笔记/feed/互斥图数据。
- **方案**：`userTable(prefix, name) = ${prefix}_${name}`；prefix 由 userId 去分隔符计算（数字开头加 `_`）；`initUserSchema(prefix)` 按前缀批量建表；切换账号热替换 `dbVars.userPrefix`（MULTI_ACCOUNT_V4 设计）。
- **代价 / 陷阱**：SQL 全部要动态拼表名（注入面变大）；跨账号聚合查询要 UNION 多套前缀表或有独立的「聚合查询构建器」（buildAggregatedFeedQuery(userPrefixes…)）；`dbVars.userPrefix` 是全局可变状态，次号操作必须自持 prefix 传入，否则写错库（设计文档明确警示）。
- **证据**：vrcx_erd.dbml:5；SQLiteAdapter.js `userTable()`；accountSession.js:561 `computeUserPrefix`；MULTI_ACCOUNT_V4_DETAIL_DESIGN.md:291-313
- **与我们的差异**：我们是每机单数据引擎（bun:sqlite），无多账号共享文件诉求，但「用户 ID 的派生键 + 动态表名」仍是可参考的隔离形态。

### 经验点 2：实体层三层建模（MCD 概念 / SR 逻辑 / DDL 物理）各自独立演进
- **解决什么问题**：同一套产品模型需要给不同受众（设计讨论、实现、图）可用文档。
- **方案**：Mocodo 单源（.mcd → DDL+MLD+ERD）+ 手写 dbml + mermaid 衍生物；SR（逻辑）把 MCD 的关联实体折叠成内嵌外键列。
- **代价 / 陷阱**：文档与实现脱节极快——SR DDL 漏 `mutual_graph_friends`、dbml 缺 3 张实体表、Mocodo DDL 类型全是 VARCHAR(42) 占位、mmd 关系还有错向；**没有任何一份是「从代码生成的权威」**，须以 Adapter 里 `initUserSchema` 的 SQL 为准。
- **证据**：vrcx_sr_ddl.sql:1（Mocodo 4.3.3 单行头）；vrcx_mcd_ddl.sql 253-293（41 条 FK）；实测 dbml=40 表/23 Ref、mmd=39 表/24 rel
- **与我们的差异**：我们若要模型文档，建议以「建表代码 + 手写 ERD 对账脚本」方式保持单一事实源，避免复制三份后漂移。

### 经验点 3：关系不靠外键约束，靠「列名约定 + 字符串 ID」软关联
- **解决什么问题**：SQLite 物理库零 FK 强制，跨表查询直接拼 SQL。
- **方案**：所有实体以 VRChat 用户/世界/头像 ID 字符串为 PK；关联 = 列名约定（`user_id`/`world_id`/`avatar_id`）；部分关联按 location 字符串（gamelog_join_leave.location = gamelog_location.location）。
- **代价 / 陷阱**：脏数据/孤儿行无数据库层拦截；**没有 FK 意味着删除用户不会级联**，只能靠应用层清理；定位字符串关联脆弱（实例 location 格式变更即断链）。
- **证据**：vrcx_erd.dbml:44（"loose reference, no FK enforcement in SQLite"）；dbml Ref 全量 23 条
- **与我们的差异**：我们若用 bun:sqlite 同样面临 FK 取舍；可考虑开启 SQLite PRAGMA foreign_keys 并设计显式索引，但这会是主动选择而不是继承了。

### 经验点 4：「加法演进」替代破坏性迁移 —— `_V2_`/`_OLD_` 命名即版本档案
- **解决什么问题**：通知格式升级、活动统计重构、互斥图加时间维度，都不打断存量用户数据。
- **方案**：新表 + 版本后缀并存；client 按需读新旧两表；push/pull 同步把新旧表并列进同步清单。
- **代价 / 陷阱**：表数量持续膨胀（42 张里有 5 张是版本并存）；新旧表同步维护两份写路径；不做数据搬迁则旧表永远留存。
- **证据**：NOTIFICATION vs NOTIFICATIONS_V2（vrcx_sr_ddl.sql 211、194）；ACTIVITY_*_V2 三表；MUTUAL_GRAPH_*_OLD（dbml:20-21 注释 "NEW (PR #21)"）
- **与我们的差异**：我们 schema v1 尚无存量包袱；但「schema_version 元数据 + 兼容列演进 vs 新表并存」的权衡值得预设策略，尤其插件生态出现后。

### 经验点 5：统计类「会话窗口 + 预计算 bucket + 增量游标」三件套
- **解决什么问题**：热力图/时长统计要在大时间跨度上反复读原生事件表，扫描太贵。
- **方案**：① sync_state 记增量游标（source_last_created_at + pending_session_start_at）只拉新增；② sessions 表把原始事件拼成闭合同口（start/end/is_open_tail + source_revision 防代际污染），支持整表重建或按点追加；③ bucket_cache 按 (user,target,range,view,exclude) 复合键预计算，bucket_version 做结构失效。
- **代价 / 陷阱**：复合缓存键行数膨胀；游标与缓存对账需要 `built_from_cursor`；open tail 处理（未闭合会话）容易算错；重建/追加两套事务路径的并发边界要小心。
- **证据**：vrcx_sr_ddl.sql:1-19；activityV2.js（getActivitySourceAfterV2 / replaceActivitySessionsV2 / appendActivitySessionsV2 / upsertActivityBucketCacheV2 全文）
- **与我们的差异**：我们的数据引擎若做时长统计，这套「原始事件 → 会话 → 预聚合缓存」的分层与游标设计可直接借鉴，聚合层我们可用 SQL 视图/物化替代 JSON bucket。

### 经验点 6：Feed 事件表统一「previous_* 冗余字段」模式
- **解决什么问题**：展示「谁把 X 改成了 Y」要拿到变更前后两值，且 feed 行不可变（历史流）。
- **方案**：每张 FEED_* 表都存快照对：`status/previous_status`、`bio/previous_bio`、`location/previous_location`、`display_name/previous_display_name`；新增 `time` 字段记「上一状态的持续毫秒」（如 FEED_GPS.time = 在 previous_location 停留时长）。
- **代价 / 陷阱**：冗余存储；同一事件的多字段变化需拆多条或容忍只记一对；previous_* 的更新时机要精确（先读后写）。
- **证据**：vrcx_erd.dbml:4-7（feed 四表字段注释）；FRIEND_LOG_HISTORY（dbml:3）
- **与我们的差异**：事件溯源式设计（我们倾向）里 previous_* 由「上一条事件」推导而非冗余存储，但前者查询廉价、后者存储廉价，可权衡。

### 经验点 7：缓存表 = 实体表（以 `id` 直接作对象 ID，VRC 数据不回源也能展示）
- **解决什么问题**：VRCAPI 返回的世界/头像对象要能离线/快速展示。
- **方案**：`CACHE_WORLD`/`CACHE_AVATAR` 直接以 VRC ID 作 PK，存 author/name/图片/release_status/version；收藏、memo、tag 都引用 cache 的 id。
- **代价 / 陷阱**：缓存与真实对象可能过期（updated_at 有但无 TTL 策略）；author_id 不含 relation 到 USER（作者不是好友就不在 USER 表）——实体关系网是断裂的。
- **证据**：vrcx_erd.dbml:33-34（cache 两表）；dbml Ref 5 条（cache → favorite/memo/tag/gamelog）
- **与我们的差异**：我们的 schema v1 用独立实体 + 引用关系时，要决定「VRC 对象是否单实体表复用」而非复制两份（cache + entity），后者正是前人的扩展点。

### 经验点 8：pub 表与 pri 表可互相引用 —— 分级不是硬壳
- **解决什么问题**：收藏好友（pub 共享）必须引用每账号的好友实体（pri）。
- **方案**：跨分级引用用列名约定即可（`FAVORITE_FRIEND.user_id_ref → USER`、`MEMO.user_id_ref2 → USER`、`GAMELOG_LOCATION.world_id → WORLD` 但 GAMELOG 是 pub）。
- **代价 / 陷阱**：层级语义不清（为什么 gamelog 是 pub 而 feed 是 pri？`_pub_` 的 gamelog_location 挂 `world_id` 却可以没有 WORLD 行）；pub/pri 命名容易让人误以为是「隐私级别」，实际是「账号隔离级别」。
- **证据**：vrcx_sr.mcd:29（FAVORITE_FRIEND #user_id_ref > USER）；vrcx_sr.mcd:31（MEMO #user_id_ref2 > USER）；vrcx_erd.dbml:37
- **与我们的差异**：我们设计时应对「隔离维度」（account/global）与「隐私维度」分开命名，避免一次命名承担两个语义。

### 经验点 9：模型文档的「手工 + 生成」混合链，及其实测漂移
- **解决什么问题**：给设计评审与实现同时交付图、文档、DDL。
- **方案**：Mocodo 4.3.3 出 MCD/SR 全链；dbml 手工维护最富语义；mermaid/svg 从 dbml 派生。
- **代价 / 陷阱**：实测三份对不上：SR=42 表、dbml=40 表（缺 USER/AVATAR/WORLD 实体）、mmd=39 表（再缺 MANUAL_RELATIONS_MANUEL）、MCD=54（多 13 个关联表）；mmd 通知关系画错向；Mocodo DDL 类型全 VARCHAR(42)。**结论：此类产物不能当 schema 权威，只能当「实体清单 + 关系意图」参考。**
- **证据**：§0 表 + 本节实测计数（正则统计 + 通读）
- **与我们的差异**：我们的模型文档应以可执行 schema 为源（如单文件 schema.ts + 生成 ERD），辅以对账测试。

## 8. 血统事实台账要点（承接其它队友）

- old/main 根提交 = VRCX 官方（MIT）fork 链；models 目录与 src/services/database/* 在同一提交 `d10b0cc0` 落地，无法细分先后。
- 表结构出自 `src/services/database/index.js` / `adapter/{SQLite,MySQL,PgSQL}Adapter.js` 的 `initUserSchema`；`docs/architecture/models/` 是对它的**逆向描述**，非权威源。
- 物理库默认 SQLite 单文件；MySQL/PgSQL 是可切换后端（多 Adapter 架构，含 bulk/事务/同步清单差异）。
- 活动统计（ACTIVITY_*_V2）、互斥图（PR#21 OLD 表）、通知（NOTIFICATION 两代）是**本 fork 在 VRCX 官方基础上自己长出来的功能层**——标注 `NEW (PR #21)` 注释是 fork 内 PR 痕迹，可作为「哪些表是官方原版、哪些是本工程新增」的推断线索（官方 VRCX 表通常无 PR 编号注释）。

## 无法确定的事项

1. **428/40/39 的表数差异**的精确归因：dbml 为何省略 USER/AVATAR/WORLD 实体（是「缓存吸收实体」的刻意设计还是遗漏）——无代码注释说明。
2. **GAMELOG_LOCATION 为何是 pub**：它是供全局共享（多账号看同一实例日志）还是残留命名，代码无直接注释；MULTI_ACCOUNT 设计文档未展开。
3. **COOKIES_pub_ 的共享语义**：多账号的 Cookie 是否真的同表共存（pub），还是历史遗留；未在数据库代码中确认写入路径。
4. **activity V1 的具体形态**：`ACTIVITY_*_V2` 相对 V1 改了什么，old/main 上未见 V1 表（可能从未落地或已删除）。
5. **MANUAL_RELATIONS_MANUEL 的 MANUEL 拼写**：可能是笔误或别称（法语 manuel=manual）——无文档说明。
6. **工作表（Table 级默认值/约束）**：Mocodo SR DDL 无任何默认值/索引/CHECK（VARCHAR(42) 占位）；真实约束只存在于三个 Adapter 的 SQL（如 NOT NULL DEFAULT、索引），未逐一比对差异。
7. **`vrcx_erd.dbml` 与 `vrcx_erd.svg` 是否真由同源生成**：svg 758 KB 为 mermaid 渲染，但 dbml 与 mmd 存在表数差，二者生成链路未在仓库记录。
