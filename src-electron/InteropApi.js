const dotnet = require('node-api-dotnet/net9.0');

/**
 * 把 JS 数组参数转为 C# System.Collections.ArrayList(非泛型 IList)。
 *
 * 背景:node-api-dotnet 把 JS 数组 marshal 到 C# object 参数时元素丢失(变
 * null,Npgsql 报 "bind message supplies 0 parameters");ArrayList 与生产
 * CefSharp 绑定层产出的 List<object> 同为 IList,NormalizeArgs 的 IList 分支
 * (commit 9669198b)原样消费;元素经 Add(object) 逐项写入(string/number/null
 * → object 参数实证正常)。形态与 src/services/database/adapter/__tests__/
 * bridgeLoader.js 的 toBridgeArgs 同款。
 *
 * 安全边界(审计结论,勿扩展):
 * - callMethod 可达面中唯一会收到 JS 数组的具体参数是 PostgreSQL 桥的
 *   `args: object?`(位置参数);MySQL/SQLite 的 args 由 adapter 预转 Map
 *   (Array.isArray(Map) === false,自然跳过,无需处理)
 * - 不递归转换嵌套数组:元素保持 JS 原值,沿用 node-api-dotnet 现有 marshal
 *   规则;byte[]/string[] 参数不经 callMethod(ProgramElectron.PreInit 由
 *   main.js 直接调,勿在此处包 ArrayList)
 * - 本函数只负责数组→ArrayList,不做对象→Map 转换(那是 adapter 的职责)
 *
 * @param {*} value - 参数值;非数组原样返回
 * @param {object} dotnet - node-api-dotnet 根对象(测试注入 fake)
 * @returns {*} ArrayList(数组输入)或原值(非数组输入)
 */
function toArrayList(value, dotnet) {
    if (!Array.isArray(value)) return value;
    const list = new dotnet.System.Collections.ArrayList();
    for (const item of value) {
        list.Add(item);
    }
    return list;
}

class InteropApi {
    constructor() {
        // Cache for .NET objects, might be problematic if we require a new instance every time
        this.createdObjects = {};
    }

    getDotNetObject(className) {
        if (!this.createdObjects[className]) {
            console.log(`Creating new instance of ${className}`);
            this.createdObjects[className] = new dotnet.VRCX[className]();
        }
        return this.createdObjects[className];
    }

    callMethod(className, methodName, args) {
        try {
            const obj = this.getDotNetObject(className);
            if (typeof obj[methodName] !== 'function') {
                throw new Error(
                    `Method ${methodName} does not exist on class ${className}`
                );
            }
            // 每参数独立转换:仅 JS 数组 → ArrayList,其余原样透传
            return obj[methodName](
                ...args.map((arg) =>
                    Array.isArray(arg) ? toArrayList(arg, dotnet) : arg
                )
            );
        } catch (e) {
            console.error(
                'Error calling .NET method',
                `${className}.${methodName}`,
                e
            );
            throw e;
        }
    }
}

module.exports = InteropApi;
module.exports.toArrayList = toArrayList;
