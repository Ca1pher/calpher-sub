import assert from 'assert';
import { dedupConfigAgainstExisting, nodeFingerprint } from './dedup.js';

// 场景: 旧配置内部已存在同指纹节点(例如同一隧道多条线路,指纹含 path 所以不同;
// 这里模拟真·完全相同的两个节点被用户保留), 脚本推送时 persistConfig 对整个旧配置跑 dedup,
// 不应把已有的重复指纹节点合并掉(35 -> 32 的元凶)。
const mkNode = (id, name, server, port, extra = {}) => ({
    id, name, type: 'vless', server, port, uuid: 'u', network: 'tcp', ...extra,
});

// old: 内部已有 3 对完全同指纹的节点(35 = 32 唯一 + 3 重复)
const oldNodes = [];
const oldGroups = [];
const uniq = Array.from({ length: 32 }, (_, i) => mkNode('old-u' + i, 'U' + i, 'srv' + i + '.com', 443));
oldNodes.push(...uniq);
oldGroups.push({ id: 'g1', name: 'PC', nodes: uniq.map(n => n.id) });
// 3 个与已有节点同指纹的重复节点(同 server/port/uuid/path)
const dups = [
    mkNode('dup-1', 'Dup1', 'srv0.com', 443),
    mkNode('dup-2', 'Dup2', 'srv1.com', 443),
    mkNode('dup-3', 'Dup3', 'srv2.com', 443),
];
oldNodes.push(...dups);
oldGroups[0].nodes.push(...dups.map(n => n.id));
const oldCfg = { nodes: oldNodes, groups: oldGroups };

// incoming 与 old 完全一致(脚本推送时加载完整 config 原样传回 persistConfig)
const incoming = { nodes: oldNodes, groups: oldGroups };
const result = dedupConfigAgainstExisting(incoming, oldCfg, 'test');

console.log('[test] old.nodes=', oldCfg.nodes.length, 'result.nodes=', result.nodes.length);
// 修复要求: 结果与 old 节点数一致(不得合并已有重复)
assert.strictEqual(result.nodes.length, oldCfg.nodes.length,
    `期望保留 ${oldCfg.nodes.length} 个节点,实际 ${result.nodes.length}`);
// 分组引用也必须完整保留
assert.strictEqual(result.groups[0].nodes.length, oldCfg.groups[0].nodes.length);
// 每个重复节点 id 都应保留(不被映射掉)
for (const d of dups) {
    assert.ok(result.nodes.some(n => n.id === d.id), '重复节点 ' + d.id + ' 被丢弃');
}

// 场景2: 真正新增的重复指纹节点(与 old 不冲突的新指纹), 仍应去重合并
const newDup = mkNode('new-a', 'NewA', 'brand-new.com', 8443);
const newDup2 = { ...newDup, id: 'new-b' };
const incoming2 = { nodes: [...oldNodes, newDup, newDup2], groups: oldGroups };
const result2 = dedupConfigAgainstExisting(incoming2, oldCfg, 'test');
// 32 唯一 + 3 旧重复 + 1 个新指纹 = 36
assert.strictEqual(result2.nodes.length, oldCfg.nodes.length + 1,
    `新增重复应合并为 1 个,实际 ${result2.nodes.length}`);

console.log('[test] 场景2(新增重复合并)通过');
console.log('[test] all passed');
