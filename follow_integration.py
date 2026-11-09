"""Verify persistent follow in the isolated Chrome profile (9222 only)."""
import asyncio
import json
import sys
import urllib.request
from browser_integration import targets, evaluate, wait_value, BASE, PORT, EXTENSION_ID

async def panel_target():
    async with asyncio.timeout(15):
        while True:
            for target in await targets():
                if target['url'] == f'chrome-extension://{EXTENSION_ID}/reader.html':
                    return target
            await asyncio.sleep(.15)

async def main():
    if sys.argv[1] == 'prepare':
        request = urllib.request.Request(PORT + '/json/new?http://127.0.0.1:18765/',method='PUT')
        page = json.load(urllib.request.urlopen(request,timeout=5))
        await wait_value(page,"document.querySelector('#status')?.textContent.includes('服务已连接')")
        long_text = ('这是一段跨越多屏的中文测试文字，用于检查按段落高亮时是否仍然跟随正在朗读的字。'*70)+'追踪目标就在这里。'+('手动滚走之后也要自动跟回当前的位置。'*45)
        nested_text = ('内层滚动容器也需要持续追踪，文字在容器里面自动换行。'*30)+'容器目标在这里。'+('继续测试内层区域。'*20)
        html = '<style>body{margin:35px;font:24px/1.9 sans-serif}article{width:540px;margin:auto}#scroller{height:300px;overflow:auto;border:2px solid #888}</style><article><h1>始终跟踪高亮验证</h1><p id=long>'+long_text+'</p><div id=scroller><p id=nested>'+nested_text+'</p></div><p>末尾内容。</p></article>'
        await evaluate(page,'document.title="始终跟踪功能验证";document.body.innerHTML='+json.dumps(html,ensure_ascii=False)+';window.getSelection().removeAllRanges();true')
        (BASE/'follow-browser-state.json').write_text(json.dumps({'pageId':page['id']}),encoding='utf-8')
        print('Follow fixture ready',flush=True)
        return
    panel=await panel_target()
    state=json.loads((BASE/'follow-browser-state.json').read_text())
    page=next(t for t in await targets() if t['id']==state['pageId'])
    await wait_value(panel,"typeof source !== 'undefined' && source?.documentId && source.text.includes('追踪目标')")
    await evaluate(panel,"stop();document.querySelector('#highlightMode').value='paragraph';document.querySelector('#follow').checked=true;const anchorIndex=source.text.indexOf('追踪目标');lastHighlight={media:{currentTime:.1},boundaries:[{start:0,duration:1,startChar:anchorIndex,endChar:anchorIndex+1}],piece:{text:source.text,start:0}};updateMode();true")
    geometry="""(() => {const r=Array.from(CSS.highlights.get('xiaoxiao-current')||[]);return {scroll:scrollY,paragraphTop:document.querySelector('#long').getBoundingClientRect().top,viewport:innerHeight,rectCount:r.length}})()"""
    await asyncio.sleep(1.5)
    status=await evaluate(panel,"chrome.runtime.sendMessage({action:'highlightStatus',tabId:source.sourceTabId,documentId:source.documentId})")
    assert status['following'] and status['mode']=='paragraph',status
    g=await evaluate(page,geometry)
    assert g['scroll']>1000 and g['paragraphTop'] < -500,g
    print('Long paragraph follows current character:',g,flush=True)
    original=g['scroll']
    await evaluate(page,'window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"});scrollY')
    await asyncio.sleep(1.6)
    g=await evaluate(page,geometry)
    assert abs(g['scroll']-original)<40,(original,g)
    print('Manual scroll followed back without a new character:',g['scroll'],flush=True)
    await evaluate(panel,"document.querySelector('#follow').checked=false;document.querySelector('#follow').dispatchEvent(new Event('change'));true")
    await asyncio.sleep(.5)
    manual=await evaluate(page,'window.scrollTo({top:100,behavior:"instant"});scrollY')
    await asyncio.sleep(1)
    g=await evaluate(page,geometry)
    status=await evaluate(panel,"chrome.runtime.sendMessage({action:'highlightStatus',tabId:source.sourceTabId,documentId:source.documentId})")
    saved=await evaluate(panel,"chrome.storage.local.get('followReading')")
    assert not status['following'] and saved['followReading'] is False,(status,saved)
    assert abs(g['scroll']-manual)<2,(manual,g)
    print('Switch OFF: free scrolling; preference saved',flush=True)
    await evaluate(panel,"document.querySelector('#follow').checked=true;document.querySelector('#follow').dispatchEvent(new Event('change'));true")
    await asyncio.sleep(1.5)
    g=await evaluate(page,geometry)
    assert abs(g['scroll']-original)<40,g
    print('Switch ON: reacquired unchanged highlight',flush=True)
    await evaluate(panel,"const nestedIndex=source.text.indexOf('容器目标');lastHighlight={media:{currentTime:.1},boundaries:[{start:0,duration:1,startChar:nestedIndex,endChar:nestedIndex+1}],piece:{text:source.text,start:0}};updateMode();true")
    await asyncio.sleep(2)
    nested=await evaluate(page,"({innerScroll:document.querySelector('#scroller').scrollTop,top:document.querySelector('#scroller').getBoundingClientRect().top,height:document.querySelector('#scroller').clientHeight,viewport:innerHeight})")
    assert nested['innerScroll']>200 and nested['top']<nested['viewport'] and nested['top']+nested['height']>0,nested
    print('Nested scroll container follows:',nested,flush=True)
    await evaluate(panel,"stop();true")
    status=await evaluate(panel,"chrome.runtime.sendMessage({action:'highlightStatus',tabId:source.sourceTabId,documentId:source.documentId})")
    assert not status['following'] and not status['highlightRects'],status
    (BASE/'follow-verification.json').write_text(json.dumps({'longParagraph':True,'manualScrollReturns':True,'switchOffFreeScroll':True,'switchOnReacquires':True,'preferenceSaved':True,'nestedContainer':nested,'stopClears':True},ensure_ascii=False,indent=2),encoding='utf-8')
    print('Persistent follow browser checks passed',flush=True)

if __name__=='__main__':
    asyncio.run(main())
