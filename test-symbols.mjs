// 符号提取（大纲面板的纯逻辑部分）
import { extractSymbols, buildSymbolTree, findReferences, supportsOutline, escapeRe } from './public/symbols.js'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(42)} ${d}`) }
const names = (list) => list.map((s) => s.name)

/** 把树拍平成「缩进 + 名字」，方便断言层级 */
const flatten = (node, depth = 0, out = []) => {
  for (const c of node.children) {
    out.push(`${'  '.repeat(depth)}${c.name}`)
    flatten(c, depth + 1, out)
  }
  return out
}

console.log('===== Java =====')
const JAVA = `package com.demo;

/**
 * 注释里的 class Fake 不该被提取
 * public void fakeMethod() {
 */
@Service
public class MobileDataProvider extends Base implements Provider {
    private static final String TAG = "x";
    private int count;

    public MobileDataProvider(String name) {
        this.name = name;
    }

    @Override
    public String getDataMaskingText(String input, int len) throws IOException {
        if (input == null) {
            return "";
        }
        return input;
    }

    @Override public int getRuleIndex() { return 1; }

    private List<Map<String, Object>> query(String sql) {
        return null;
    }

    public interface Callback {
        void onDone(String s);
        int size();
    }

    public enum Level {
        HIGH, LOW
    }
}
`
const j = extractSymbols(JAVA, 'java')
check('提取 class', names(j).includes('MobileDataProvider'), '')
check('提取构造器', j.some((s) => s.kind === 'constructor' && s.name === 'MobileDataProvider'), '')
check('提取方法（含返回类型）', j.some((s) => s.name === 'getDataMaskingText' && s.detail === 'String'), '')
check('提取泛型返回类型方法', j.some((s) => s.name === 'query' && /List/.test(s.detail || '')), '')
check('不提取字段（只到类型和函数）', !names(j).includes('TAG') && !names(j).includes('count'), '')
check('提取嵌套 interface / enum', j.some((s) => s.name === 'Callback' && s.kind === 'interface') &&
  j.some((s) => s.name === 'Level' && s.kind === 'enum'), '')
check('接口方法（; 结尾无函数体）', names(j).includes('onDone') && names(j).includes('size'), '')
check('注解与声明同行也提取', names(j).includes('getRuleIndex'), '')
check('注释里的假符号不被提取', !names(j).includes('Fake') && !names(j).includes('fakeMethod'), '')
check('不把 if 当方法', !names(j).includes('if'), '')
check('按行号升序', j.every((s, i) => i === 0 || j[i - 1].line <= s.line), '')

console.log('\n===== C# =====')
const CS = `using System;

namespace Demo.Services
{
    /// <summary>
    /// 注释里的 class Fake 不该被提取
    /// </summary>
    [Serializable]
    public partial class UserService : IUserService
    {
        private readonly string _name;
        public string Name { get; set; }
        public int Age { get; private set; }
        public bool IsActive => true;

        public UserService(string name)
        {
            _name = name;
        }

        [Obsolete]
        public async Task<string> GetNameAsync(int id) where T : class
        {
            return null;
        }

        public int Count() => 0;

        public class Builder
        {
            public Builder WithName(string n) { return this; }
        }

        public delegate void Handler(string msg);

        public interface IExtra
        {
            void Run();
        }

        public enum Kind { A, B }
        public record Point(int X, int Y);
        public struct Pair { public int A; }
    }
}
`
const c = extractSymbols(CS, 'cs')
check('提取 class', names(c).includes('UserService'), '')
check('提取嵌套 class', names(c).includes('Builder'), '')
check('提取 interface / enum / record / struct', ['IExtra', 'Kind', 'Point', 'Pair'].every((n) => names(c).includes(n)),
  ['IExtra', 'Kind', 'Point', 'Pair'].filter((n) => !names(c).includes(n)).join(',') || '全部命中')
check('提取 delegate 类型', c.find((s) => s.name === 'Handler')?.kind === 'delegate', '')
check('提取方法（async + 泛型约束）', names(c).includes('GetNameAsync'), '')
check('提取表达式体方法', names(c).includes('Count'), '')
check('提取构造器', c.some((s) => s.kind === 'constructor' && s.name === 'UserService'), '')
check('属性显示为 prop',
  c.filter((s) => s.kind === 'prop').map((s) => s.name).join(',') === 'Name,Age,IsActive',
  c.filter((s) => s.kind === 'prop').map((s) => s.name).join(','))
check('字段不提取', !names(c).includes('_name'), '')
check('C# 注释里的假符号不提取', !names(c).includes('Fake'), '')

console.log('\n===== TypeScript / JavaScript =====')
const TS = `import { x } from './x'

export interface Options { name: string }
export type Level = 'a' | 'b'
export enum Kind { A, B }

export class Service {
  run() {
    const inner = () => 1
  }
}

export function helper(a: number): string {
  function nested() {}
  return String(a)
}

export const arrowFn = (a: number) => a * 2
export const asyncArrow = async () => {}
const plainConst = 42
`
const t = extractSymbols(TS, 'ts')
check('提取 interface / type / enum', ['Options', 'Level', 'Kind'].every((n) => names(t).includes(n)), '')
check('提取 class', names(t).includes('Service'), '')
check('提取类内方法', names(t).includes('run'), '')
check('提取 function', names(t).includes('helper'), '')
check('提取内嵌函数', names(t).includes('nested'), '')
check('提取箭头函数常量', names(t).includes('arrowFn'), '')
check('普通常量不提取', !names(t).includes('plainConst'), '')

console.log('\n===== Go / Python / Vue =====')
const GO = `package util

const maxLen = 10
var defaultID = ""

type Builder struct {
	Name string
}

func GenerateShortID(existing map[string]bool) string { return "" }

func (b *Builder) Build(input string) (string, error) { return "", nil }
`
const g = extractSymbols(GO, 'go')
check('提取 func', names(g).includes('GenerateShortID'), '')
check('提取 type', names(g).includes('Builder'), '')
check('Go 不提取 const / var', !names(g).includes('maxLen') && !names(g).includes('defaultID'), '')
check('带 receiver 的方法记下 receiver',
  g.find((s) => s.name === 'Build')?.receiver === 'Builder',
  g.find((s) => s.name === 'Build')?.receiver)

const PY = `import os

class Service:
    def __init__(self):
        self.x = 1

    async def run(self, a):
        def inner():
            pass
        return inner

def top_level():
    pass
`
const p = extractSymbols(PY, 'py')
check('Python class / def', ['Service', 'run', 'top_level', 'inner'].every((n) => names(p).includes(n)),
  ['Service', 'run', 'top_level', 'inner'].filter((n) => !names(p).includes(n)).join(',') || '全部命中')

const VUE = `<template>
  <div>{{ msg }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const msg = ref('')

function handleClick() {}
</script>
`
const v = extractSymbols(VUE, 'vue')
check('Vue 只提取 script 块', names(v).includes('handleClick') && !names(v).includes('div'), '')
check('Vue 行号按整文件算', v.find((s) => s.name === 'handleClick')?.line === 10,
  String(v.find((s) => s.name === 'handleClick')?.line))

console.log('\n===== 建树（缩进层级）=====')
const TREE_JAVA = `public class Outer {
    void a() {
    }

    public static class Inner {
        void b() {
        }
    }

    void c() {
    }
}
`
const tj = buildSymbolTree(extractSymbols(TREE_JAVA, 'java'))
check('Java：类下挂方法，内部类再嵌一层',
  JSON.stringify(flatten(tj)) === JSON.stringify(['Outer', '  a', '  Inner', '    b', '  c']),
  JSON.stringify(flatten(tj)))

const TREE_TS = `export class App {
  mount() {
    function helper() {
      function deeper() {}
    }
  }
}
`
const tt = buildSymbolTree(extractSymbols(TREE_TS, 'ts'))
check('TS：方法内嵌函数逐层嵌套',
  JSON.stringify(flatten(tt)) === JSON.stringify(['App', '  mount', '    helper', '      deeper']),
  JSON.stringify(flatten(tt)))

const TREE_PY = `class A:
    def m1(self):
        def inner():
            pass

    def m2(self):
        pass
`
const tp = buildSymbolTree(extractSymbols(TREE_PY, 'py'))
check('Python：按缩进嵌套',
  JSON.stringify(flatten(tp)) === JSON.stringify(['A', '  m1', '    inner', '  m2']),
  JSON.stringify(flatten(tp)))

const tg = buildSymbolTree(extractSymbols(GO, 'go'))
check('Go：receiver 方法挂到 type 下',
  JSON.stringify(flatten(tg)) === JSON.stringify(['Builder', '  Build', 'GenerateShortID']),
  JSON.stringify(flatten(tg)))

console.log('\n===== 引用查找 =====')
const REF = `public class A {
    public void foo() {
        foo();
        fooBar();
    }
}
`
const refs = findReferences(REF, 'foo', { defLine: 2 })
check("同文件内命中含定义行", refs.length === 2, `${refs.length} 处`)
check('定义行被标记 isDef', refs.find((r) => r.line === 2)?.isDef === true, '')
check('词边界：不匹配 fooBar', !refs.some((r) => r.text.includes('fooBar()')), '')

console.log('\n===== 其他 =====')
check('不支持的语言返回空', extractSymbols('select 1', 'sql').length === 0, '')
check('supportsOutline 覆盖各语言',
  ['java', 'cs', 'ts', 'js', 'vue', 'go', 'py'].every(supportsOutline) && !supportsOutline('sql'), '')
check('空内容不报错', extractSymbols('', 'java').length === 0, '')
check('正则特殊字符可转义', escapeRe('a.b(1)') === 'a\\.b\\(1\\)', escapeRe('a.b(1)'))
check('怪内容不抛异常', extractSymbols('@@@\n{{{\n)))', 'java').length >= 0, '')
check('空树不报错', buildSymbolTree([]).children.length === 0, '')

const fail = checks.filter((c2) => !c2[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
