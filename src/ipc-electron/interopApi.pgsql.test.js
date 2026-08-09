import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import {
    loadBridge,
    buildPgConnectionString
} from '../services/database/adapter/__tests__/bridgeLoader.js';

/**
 * InteropApi 数组 marshal 修复(src-electron/InteropApi.js)的回归测试。
 *
 * 背景(生产链路):
 * - 渲染进程 PgSQLAdapter 把位置参数数组交给 PostgreSQL.ExecuteJsonOnConnection,
 *   经 src/ipc-electron/interopApi.js Proxy → preload callDotNetMethod → IPC →
 *   main.js ipcMain.handle('callDotNetMethod') → interopApi.callMethod(...) →
 *   node-api-dotnet 把 JS 数组 marshal 到 C# object? 参数时元素变 null,
 *   Npgsql 报 "bind message supplies 0 parameters"(Linux 生产缺口;
 *   Windows CefSharp 绑定层把 JS 数组序列化为 List<object>,无此问题)
 * - 修复:callMethod 对 JS 数组参数包装为 System.Collections.ArrayList
 *   (非泛型 IList),与 CefSharp 绑定层产出同款,NormalizeArgs 的 IList 分支
 *   (commit 9669198b)原样消费,零改 C#
 *
 * 结构:
 * - Tier 1 离线单测(无条件):fake dotnet 注入 toArrayList,纯 JS 断言,
 *   默认 npm test 常跑。InteropApi.js 顶层 require('node-api-dotnet/net9.0')
 *   仅为原生 addon 装载(不触发 dotnet.load()),无需 .NET 运行时/桥 DLL
 * - Tier 2 桥集成(PG_TEST_HOST 门控):复用 bridgeLoader.loadBridge()
 *   (幂等单例,加载 build/Electron/ 下 VRCX-K.dll / VRCX-Electron.dll),
 *   new InteropApi() 走真实 C# 桥验证参数绑定。注意:loadBridge() 注入的
 *   globalThis.MySQL/PostgreSQL 是 wrapBridge 包装版(参数预转);Tier 2 的
 *   new InteropApi() 内部 new dotnet.VRCX.PostgreSQL() 是未包装实例 ——
 *   正是测 InteropApi 自身参数处理的目的,绕开 adapter 预转
 *
 * Gated on `PG_TEST_HOST`:env 未设时 Tier 2 整个套件 skip,默认 `npm test`
 * (SQLite 模式)零副作用。CI workflow `.github/workflows/ci.yaml` `test_pgsql`
 * job 设置 env,先 setup-dotnet 9.0.x + `dotnet build
 * Dotnet/VRCX-Electron.csproj -c Debug`,再导入 test/fixtures/seed.pgsql.sql,
 * 最后以 `.pgsql.test.js` 过滤器全量运行本文件。
 *
 * Run locally (需 docker + .NET 9 SDK):
 *   dotnet build Dotnet/VRCX-Electron.csproj -c Debug
 *   docker run -d --name vrcx-pg -e POSTGRES_PASSWORD=vrcx -e POSTGRES_USER=vrcx \
 *     -e POSTGRES_DB=vrcx -p 5432:5432 postgres:16
 *   psql -h localhost -U vrcx -d vrcx -f test/fixtures/seed.pgsql.sql
 *   PG_TEST_HOST=localhost npx vitest run interopApi.pgsql
 *
 * env 清单(与 CI 一致):PG_TEST_HOST / PG_TEST_PORT / PG_TEST_USER /
 * PG_TEST_PASSWORD / PG_TEST_DB
 *
 * 纪律:
 * - 桥加载 beforeAll 显式 30s 超时(dotnet.load 冷启动可数秒);
 * - globalThis.MySQL/PostgreSQL 对称保存/恢复(与 PgSQLAdapter.pgsql.test.js
 *   同款;vitest.setup.js 的 noopAsync Proxy stub 为原值);
 * - Tier 2 全程 OnConnection 路径,绕开 C# Init()/IsConnected 的
 *   VRCXStorage 依赖;
 * - T2-2 为决定性回归探针:裸数组路径 Npgsql 报 "bind message supplies 0
 *   parameters",修复后参数真实绑定;"连不可达端口区分错误"方案已实证否决
 *   (裸数组与 ArrayList 同为连接错误,不可区分),以真实参数查询为准。
 */

// createRequire(import.meta.url) 使 require('../../src-electron/InteropApi.js')
// 从本文件所在目录沿 node_modules 链解析(CJS 主进程模块),模式与
// bridgeLoader.js 同款;顶层仅装载 node-api-dotnet addon,不触发 dotnet.load()。
const requireFromTest = createRequire(import.meta.url);
const InteropApi = requireFromTest('../../src-electron/InteropApi.js');
const { toArrayList } = InteropApi;

// ── Tier 1:离线单测(无条件,默认 npm test 常跑)────────────────────

describe('InteropApi 数组 marshal 转换(离线单测)', () => {
    // fake dotnet:仅实现 Tier 1 需要的 ArrayList 构造与 Add 记录
    const fakeDotnet = {
        System: {
            Collections: {
                ArrayList: class {
                    constructor() {
                        this.items = [];
                    }

                    Add(value) {
                        this.items.push(value);
                    }
                }
            }
        }
    };

    it('T1-1 数组 → ArrayList:逐项 Add,顺序保持', () => {
        const list = toArrayList(['a', 1, null], fakeDotnet);
        expect(list).toBeInstanceOf(fakeDotnet.System.Collections.ArrayList);
        expect(list.items).toEqual(['a', 1, null]);
    });

    it('T1-2 空数组边界:ArrayList 且零元素', () => {
        const list = toArrayList([], fakeDotnet);
        expect(list).toBeInstanceOf(fakeDotnet.System.Collections.ArrayList);
        expect(list.items).toHaveLength(0);
    });

    it('T1-3 非数组输入原引用透传', () => {
        const map = new Map();
        const obj = { a: 1 };
        for (const value of ['str', 1, null, undefined, map, obj]) {
            expect(toArrayList(value, fakeDotnet)).toBe(value);
        }
    });

    it('T1-4 嵌套数组不递归:元素保持 JS 原引用', () => {
        const inner = ['x', 'y'];
        const list = toArrayList([inner, 1], fakeDotnet);
        expect(list.items[0]).toBe(inner);
        expect(list.items[1]).toBe(1);
    });

    it('T1-5 导出形态:命名导出 toArrayList 与默认导出类', () => {
        // 从模块命名导出取到后再比较,防导出契约回归
        const { toArrayList: namedExport } = InteropApi;
        expect(namedExport).toBe(InteropApi.toArrayList);
        expect(typeof InteropApi).toBe('function');
    });
});

// ── Tier 2:PG 门控桥集成(真实 C# 桥 + 可达 PG)────────────────────

const pgHost = process.env.PG_TEST_HOST;
const describeIntegration = pgHost ? describe : describe.skip;

describeIntegration('InteropApi 真实桥调用(Electron 主进程路径)', () => {
    /** @type {*} new InteropApi() 实例(未包装桥,见文件头注释) */
    let api;
    /** @type {*} 保存 vitest.setup.js 的 noopAsync stub 原值,afterAll 恢复 */
    let savedPostgreSQLBridge;
    /** @type {*} loadBridge() 同时注入 globalThis.MySQL,对称保存/恢复 */
    let savedMySQLBridge;

    beforeAll(() => {
        savedPostgreSQLBridge = globalThis.PostgreSQL;
        savedMySQLBridge = globalThis.MySQL;
        loadBridge(); // 幂等单例,注入 globalThis.MySQL / globalThis.PostgreSQL
        api = new InteropApi();
    }, 30000);

    afterAll(() => {
        globalThis.PostgreSQL = savedPostgreSQLBridge;
        globalThis.MySQL = savedMySQLBridge;
    });

    it('T2-1 真实 .NET 类型断言:数组 → System.Collections.ArrayList', () => {
        const bridge = loadBridge(); // 幂等:beforeAll 同一实例
        const list = InteropApi.toArrayList(['abc', 42, null], bridge.dotnet);
        expect(list.GetType().FullName).toBe('System.Collections.ArrayList');
        expect(list.Count).toBe(3);
    });

    it('T2-2 决定性回归探针:SELECT UPPER($1) 参数真实绑定', () => {
        // 裸数组 bug 下 Npgsql 抛 "bind message supplies 0 parameters";
        // 修复后数组 → ArrayList → NormalizeArgs IList 分支 → 参数真实绑定
        const result = api.callMethod('PostgreSQL', 'ExecuteJsonOnConnection', [
            buildPgConnectionString(),
            'SELECT UPPER($1)',
            ['abc']
        ]);
        expect(JSON.parse(result)[0][0]).toBe('ABC');
    });

    it('T2-3 null args 透传无副作用:SELECT 1', () => {
        const result = api.callMethod('PostgreSQL', 'ExecuteJsonOnConnection', [
            buildPgConnectionString(),
            'SELECT 1',
            null
        ]);
        expect(JSON.parse(result)[0][0]).toBe(1);
    });
});
