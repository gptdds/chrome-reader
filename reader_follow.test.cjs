// Behaviour check: the follow switch must work after the MP3 clock is cleared.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('follow switch uses the last page position after audio has finished', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value:'',checked:false,textContent:'',classList:{toggle(){}},addEventListener(){},selectedOptions:[{textContent:'按段落高亮'}]});
    return elements.get(id);
  };
  const messages = [], settings = [];
  const context = vm.createContext({
    document:{getElementById:element,querySelectorAll:()=>[]},
    window:{addEventListener(){}},
    chrome:{runtime:{sendMessage:async message=>{messages.push(message);return {ok:true};}},storage:{local:{get:async()=>({}),set:async value=>settings.push(value)},onChanged:{addListener(){}}}},
    fetch:async()=>({ok:true,json:async()=>({ok:true})}),
    READER_API:'http://127.0.0.1:18765',READER_TOKEN:'test-only',
    AbortSignal,AbortController,cancelAnimationFrame(){},requestAnimationFrame:()=>1,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'extension','reader.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext("source={sourceTabId:7,documentId:'test-doc'};lastHighlight={media:{currentTime:0},boundaries:[],piece:{},location:{index:40,end:41}};",context);
  element('highlightMode').value='paragraph';
  for (const follow of [false,true,false]) {
    element('follow').checked=follow;
    vm.runInContext('updateMode()',context);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(messages.at(-1).action,'highlight');
    assert.equal(messages.at(-1).follow,follow);
    assert.equal(messages.at(-1).index,40);
    assert.equal(settings.at(-1).followReading,follow);
  }
  element('highlightMode').value='off';
  vm.runInContext('updateMode()',context);
  assert.equal(messages.at(-1).action,'clearHighlight');
});
